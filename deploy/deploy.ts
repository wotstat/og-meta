#!/usr/bin/env bun
// Blue-green activation. Only the private Compose gateway is ever reloaded.
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  RETENTION_SECONDS, atomicWrite, collect, fallbackRelease, nowSeconds, pointLink,
  publish, readJson, releaseId, resolvePath, setFallback, writeJson, type DeploymentPair, type DeploymentState
} from './releases'

const sourceRoot = resolvePath(join(import.meta.dir, '..'))

type Args = {
  action: 'meta' | 'frontend' | 'rollback' | 'gc' | 'start'
  app: string
  frontend?: string
  incoming?: string
  release?: string
}

type RunOptions = {
  capture?: boolean
  check?: boolean
  quiet?: boolean
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

function acquireDeployLock(path: string) {
  const marker = `${process.pid}:${path}`
  if (process.env.WOTSTAT_DEPLOY_LOCK === marker) {
    delete process.env.WOTSTAT_DEPLOY_LOCK
    return
  }

  const flock = Bun.which('flock')
  if (!flock) throw new Error('Deployment requires flock from util-linux on the Linux host')
  if (!process.execve) throw new Error('Deployment requires Bun 1.4.3 with process.execve')

  // Re-exec under flock with the same PID. The inherited descriptor keeps the
  // lock until this process exits, including SIGKILL; never unlink the lock file.
  console.log('Acquiring deployment lock; waiting if another deployment is running')
  process.execve(flock, [flock, '--exclusive', '--no-fork', path,
    process.execPath, import.meta.path, ...process.argv.slice(2)], {
    ...process.env, WOTSTAT_DEPLOY_LOCK: marker
  })
}

async function run(command: string[], options: RunOptions & { capture: true }): Promise<string>
async function run(command: string[], options?: RunOptions & { capture?: false }): Promise<number>
async function run(command: string[], options: RunOptions = {}): Promise<string | number> {
  let stdout: 'pipe' | 'ignore' | 'inherit' = options.quiet ? 'ignore' : 'inherit'
  if (options.capture) stdout = 'pipe'

  const child = Bun.spawn(command, {
    env: options.env ?? process.env,
    stdin: 'ignore',
    stdout,
    stderr: options.quiet ? 'ignore' : 'inherit',
    timeout: options.timeoutMs,
  })

  const [code, output] = await Promise.all([
    child.exited,
    options.capture ? new Response(child.stdout).text() : Promise.resolve('')
  ])
  if (options.check !== false && code !== 0) throw new Error(`Command failed (${code}): ${command.join(' ')}`)
  return options.capture ? output.trim() : code
}

class Deployment {
  readonly runtime: string
  readonly statePath: string
  readonly frontend: string
  candidate: DeploymentPair | null = null

  constructor(readonly args: Args, readonly state: DeploymentState) {
    this.runtime = join(args.app, 'runtime')
    this.statePath = join(this.runtime, 'state.json')

    if (state.schema !== 1) throw new Error('Unsupported deployment state schema')

    this.frontend = state.frontendRoot
    if (args.frontend && resolvePath(args.frontend) !== this.frontend) {
      throw new Error('Frontend directory differs from persisted deployment state')
    }
    mkdirSync(this.frontend, { recursive: true })
  }

  save() {
    writeJson(this.statePath, this.state)
  }

  compose(arguments_: string[], options: RunOptions & { capture: true }): Promise<string>
  compose(arguments_: string[], options?: RunOptions & { capture?: false }): Promise<number>
  compose(arguments_: string[], options: RunOptions = {}): Promise<string | number> {
    const available = [this.state.active, this.state.previous, this.candidate].filter(item => item !== null)
    const first = available[0]
    if (!first) throw new Error('No deployment available for Compose')

    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const slot of ['blue', 'green']) {
      const item = available.findLast(item => item.slot === slot) ?? first
      const prefix = `META_${slot.toUpperCase()}_`
      Object.assign(env, {
        [prefix + 'IMAGE']: item.image,
        [prefix + 'RELEASE']: item.release,
        [prefix + 'DEPLOYMENT']: item.id,
        [prefix + 'ARTIFACT_DIR']: join(this.frontend, 'releases', item.release, 'dist-meta')
      })
    }

    const command = ['docker', 'compose', '-p', 'og-meta', '--project-directory', this.args.app]
    if (existsSync(join(this.args.app, '.env'))) command.push('--env-file', join(this.args.app, '.env'))
    command.push('-f', join(sourceRoot, 'docker-compose.yaml'), ...arguments_)

    if (options.capture) return run(command, { ...options, env, capture: true })
    return run(command, { ...options, env, capture: false })
  }

  async logDiagnostics(item: DeploymentPair) {
    const service = 'meta-' + item.slot
    console.error(`Meta diagnostics for ${service} (release ${item.release}, deployment ${item.id})`)

    try {
      const options = { check: false, timeoutMs: 5000 }
      const container = await this.compose(['ps', '-a', '-q', service], { ...options, capture: true })
      if (!container) {
        console.error(`No container found for ${service}`)
        return
      }

      const format = 'status={{.State.Status}} exitCode={{.State.ExitCode}} oomKilled={{.State.OOMKilled}} '
        + 'restarts={{.RestartCount}} error={{json .State.Error}} startedAt={{.State.StartedAt}} finishedAt={{.State.FinishedAt}}'
      await run(['docker', 'inspect', '--format', format, container], options)

      console.error(`Last 200 log lines for ${service}:`)
      await run(['docker', 'logs', '--timestamps', '--tail', '200', container], options)
    } catch (error) {
      console.error(`Could not collect diagnostics for ${service}:`, error)
    }
  }

  async waitReady(item: DeploymentPair) {
    try {
      const container = await this.compose(['ps', '-a', '-q', 'meta-' + item.slot], { capture: true })
      const initialRestarts = await run(['docker', 'inspect', '--format', '{{.RestartCount}}', container], { capture: true })
      const script = 'const r = await fetch("http://127.0.0.1:3000/ready", {signal: AbortSignal.timeout(2000)}); '
        + 'const h = await r.json(); process.exit(r.ok && h.deploymentId === process.env.DEPLOYMENT_ID ? 0 : 1)'

      const deadline = performance.now() + 120_000
      while (performance.now() < deadline) {
        if (await this.compose(['exec', '-T', 'meta-' + item.slot, 'bun', '-e', script], { check: false, quiet: true }) === 0) return

        const [restarts, status] = (await run(['docker', 'inspect', '--format', '{{.RestartCount}} {{.State.Status}}', container], { capture: true })).split(/\s+/)
        if (Number(restarts) > Number(initialRestarts) || ['exited', 'dead'].includes(status ?? '')) {
          throw new Error('Meta exited or restarted before becoming ready')
        }
        await Bun.sleep(1000)
      }

      throw new Error('Candidate did not become ready within 120 seconds')
    } catch (error) {
      await this.logDiagnostics(item)
      throw error
    }
  }

  async gatewayWorkers() {
    const output = await this.compose(['exec', '-T', 'gateway', 'sh', '-c',
      'ps -o pid,args | awk \'$2 == "nginx:" && $3 == "worker" {print $1}\''], { capture: true })
    return output.split(/\s+/).filter(Boolean)
  }

  async drain(workers: string[]) {
    if (!workers.length) return
    const deadline = performance.now() + 50_000
    while (performance.now() < deadline) {
      if (!(await this.gatewayWorkers()).some(pid => workers.includes(pid))) return
      await Bun.sleep(1000)
    }
    throw new Error('Old gateway workers did not drain; keeping both meta instances')
  }

  async verifyGateway(item: DeploymentPair) {
    const deadline = performance.now() + 20_000
    while (performance.now() < deadline) {
      try {
        const response = await fetch('http://127.0.0.1:9110/ready', { signal: AbortSignal.timeout(2000) })
        const health = await response.json() as { deploymentId?: string, version?: string }
        if (response.ok && health.deploymentId === item.id && health.version === item.release) return
      } catch {
        // The gateway may still be starting or draining old workers.
      }
      await Bun.sleep(500)
    }
    throw new Error('Gateway did not switch to the expected deployment')
  }

  async switch(item: DeploymentPair, configuration?: string | null) {
    const config = configuration ?? readFileSync(join(sourceRoot, 'deploy/gateway.conf'), 'utf8').replace('__UPSTREAM__', 'meta-' + item.slot)
    const existed = Boolean(await this.compose(['ps', '-q', '--status', 'running', 'gateway'], { capture: true }))
    const workers = existed ? await this.gatewayWorkers() : []

    atomicWrite(join(this.runtime, 'nginx/nginx.conf'), config)
    await this.compose(['up', '-d', '--no-deps', '--no-recreate', 'gateway'])
    await this.compose(['exec', '-T', 'gateway', 'nginx', '-t', '-c', '/etc/og-gateway/nginx.conf'])
    if (existed) await this.compose(['exec', '-T', 'gateway', 'nginx', '-s', 'reload', '-c', '/etc/og-gateway/nginx.conf'])

    await this.verifyGateway(item)
    return workers
  }

  removeIncoming() {
    if (!this.args.incoming) return
    const incoming = resolvePath(this.args.incoming)
    if (dirname(incoming) === join(this.frontend, 'incoming')) rmSync(incoming, { recursive: true })
  }

  async collect() {
    await collect(this.frontend, this.state)

    const pairs = [this.state.active, this.state.previous].filter(item => item !== null)
    const protectedImages = new Set(pairs.map(item => item.image))
    const protectedSources = new Set([...pairs.map(item => item.source), sourceRoot])
    const now = nowSeconds()

    for (const [tag, build] of Object.entries(this.state.builds)) {
      if (protectedImages.has(build.image) || now < build.createdAt + RETENTION_SECONDS) continue
      // No force/prune: images still used by other containers are kept by Docker.
      if (await run(['docker', 'image', 'rm', tag], { check: false, quiet: true }) === 0) delete this.state.builds[tag]
    }

    for (const [source, retiredAt] of Object.entries(this.state.sources)) {
      if (protectedSources.has(source) || retiredAt === null || now < retiredAt + RETENTION_SECONDS) continue
      if (dirname(source) === join(this.args.app, 'versions') && lstatSync(source, { throwIfNoEntry: false })?.isDirectory()) {
        rmSync(source, { recursive: true })
      }
      delete this.state.sources[source]
    }
  }

  async recover() {
    const pending = this.state.pending
    if (!pending) return

    console.log('Recovering unfinished activation before accepting another deployment')
    this.candidate = pending.candidate
    const active = this.state.active

    if (active) {
      await this.compose(['up', '-d', '--no-deps', '--no-recreate', 'meta-' + active.slot])
      await this.waitReady(active)
      const workers = await this.switch(active, pending.gatewayConfig)
      setFallback(this.frontend, active.release)
      await this.drain(workers)
    } else {
      await this.compose(['rm', '--stop', '--force', 'gateway'])
      if (fallbackRelease(this.frontend) === this.candidate.release) rmSync(join(this.frontend, 'current'))
    }

    await this.compose(['rm', '--stop', '--force', 'meta-' + this.candidate.slot])
    if (!active || this.candidate.release !== active.release) this.state.releases[this.candidate.release] = nowSeconds()
    delete this.state.pending
    this.save()
    this.candidate = null
  }

  async start() {
    const active = this.state.active
    if (!active) throw new Error('No active release to start')

    await this.compose(['up', '-d', '--no-deps', '--no-recreate', 'meta-' + active.slot])
    await this.waitReady(active)
    const workers = await this.switch(active)
    setFallback(this.frontend, active.release)
    await this.drain(workers)
    await this.compose(['rm', '--stop', '--force', active.slot === 'blue' ? 'meta-green' : 'meta-blue'])
    if (dirname(active.source) === join(this.args.app, 'versions')) pointLink(join(this.args.app, 'current'), active.source)
  }

  async execute() {
    await this.recover()

    if (this.args.action === 'start') {
      await this.start()
      return
    }

    if (this.args.action === 'gc') {
      await this.collect()
      this.save()
      return
    }

    const active = this.state.active
    let identifier: string
    let image: string
    let source: string
    if (this.args.action === 'rollback') {
      const previous = this.state.previous
      if (!previous) throw new Error('No previous successful deployment')
      identifier = previous.release
      image = previous.image
      source = previous.source
    } else {
      if (this.args.incoming) identifier = await publish(this.frontend, resolvePath(this.args.incoming))
      else if (this.args.release) {
        identifier = releaseId(this.args.release)
        if (!(identifier in this.state.releases)) throw new Error('Unknown release')
      } else if (active) identifier = active.release
      else throw new Error('No active frontend release; provide --incoming')

      // Register the artifact before an image build can fail or be interrupted.
      if (!(identifier in this.state.releases)) this.state.releases[identifier] = nowSeconds()
      this.save()

      if (this.args.action === 'frontend') {
        if (!active) throw new Error('No active meta image; deploy meta with --incoming')
        image = active.image
        source = active.source

        if (identifier === active.release) {
          await this.start()
          await this.collect()
          this.save()
          this.removeIncoming()
          console.log('Frontend release already active; previous deployment preserved')
          return
        }
      } else {
        source = sourceRoot
        if (!(source in this.state.sources)) this.state.sources[source] = nowSeconds()
        this.save()

        const tag = `og-meta:${crypto.randomUUID().replaceAll('-', '')}`
        await run(['docker', 'build', '-t', tag, sourceRoot])
        image = await run(['docker', 'image', 'inspect', '--format', '{{.Id}}', tag], { capture: true })
        this.state.builds[tag] = { image, createdAt: nowSeconds() }
      }
    }

    if (!(identifier in this.state.releases)) this.state.releases[identifier] = nowSeconds()
    this.save()
    await run(['docker', 'image', 'inspect', image], { capture: true })

    this.candidate = {
      slot: active?.slot === 'blue' ? 'green' : 'blue', release: identifier, image, source,
      id: crypto.randomUUID().replaceAll('-', '')
    }

    const config = join(this.runtime, 'nginx/nginx.conf')
    this.state.pending = {
      candidate: this.candidate,
      gatewayConfig: existsSync(config) ? readFileSync(config, 'utf8') : null
    }
    this.save()

    console.log(`Preparing ${identifier} in meta-${this.candidate.slot}`)
    try {
      await this.compose(['up', '-d', '--no-deps', '--force-recreate', 'meta-' + this.candidate.slot])
      await this.waitReady(this.candidate)
      const workers = await this.switch(this.candidate)
      setFallback(this.frontend, identifier)
      await this.drain(workers)
      if (active) await this.compose(['rm', '--stop', '--force', 'meta-' + active.slot])
    } catch (error) {
      console.error('Activation failed; recovering the previous deployment:', error)
      // Failed recovery leaves the journal and all releases intact for the next run.
      await this.recover()
      throw error
    }

    const now = nowSeconds()
    if (active && active.release !== identifier) this.state.releases[active.release] = now
    if (active && active.source !== source) this.state.sources[active.source] = now
    this.state.sources[source] = null
    this.state.releases[identifier] = null

    this.state.previous = active
    this.state.active = this.candidate
    delete this.state.pending
    this.save()

    // Only deployed source snapshots use this link; never point a checkout into itself.
    if (dirname(source) === join(this.args.app, 'versions')) pointLink(join(this.args.app, 'current'), source)

    await this.collect()
    this.save()
    this.removeIncoming()
    console.log(`Active release ${identifier} (${this.candidate.slot}); previous retained for rollback`)
  }
}

function argumentsFromCli(): Args | null {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2), allowPositionals: true, strict: true,
    options: {
      'app-dir': { type: 'string' }, 'frontend-dir': { type: 'string' },
      incoming: { type: 'string' }, release: { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    }
  })

  if (values.help) {
    console.log(`Usage: bun deploy/deploy.ts [meta|frontend|rollback|gc|start] [options]
  --app-dir PATH       Meta installation (default: this source directory)
  --frontend-dir PATH  Frontend installation (default: ../analytics-frontend)
  --incoming PATH     Complete dist and dist-meta upload
  --release ID        Reactivate a retained frontend release
  start               Start the saved active release without building or switching releases`)
    return null
  }

  const action = positionals[0] ?? 'meta'
  if (positionals.length > 1 || !['meta', 'frontend', 'rollback', 'gc', 'start'].includes(action)) throw new Error('Unknown action; see --help')
  if (values.incoming && values.release) throw new Error('--incoming and --release are mutually exclusive')
  if (['gc', 'rollback', 'start'].includes(action) && (values.incoming || values.release)) throw new Error(`${action} does not accept artifact arguments`)
  if (action === 'frontend' && !(values.incoming || values.release)) throw new Error('frontend requires --incoming or --release')

  return {
    action: action as Args['action'], app: resolvePath(values['app-dir'] ?? sourceRoot),
    frontend: values['frontend-dir'], incoming: values.incoming, release: values.release
  }
}

async function main() {
  const args = argumentsFromCli()
  if (!args) return

  const runtime = join(args.app, 'runtime')
  mkdirSync(runtime, { recursive: true })
  acquireDeployLock(join(runtime, 'deploy.lock'))

  // Read state only after acquiring the lock shared by both CIs, rollback and GC.
  const path = join(runtime, 'state.json')
  let state: DeploymentState
  if (existsSync(path)) state = await readJson<DeploymentState>(path)
  else {
    state = {
      schema: 1, releases: {}, active: null, previous: null,
      frontendRoot: resolvePath(args.frontend ?? join(args.app, '..', 'analytics-frontend')),
      builds: {}, sources: {}
    }
  }

  await new Deployment(args, state).execute()
}

try {
  await main()
} catch (error) {
  console.error('Deployment failed:', error)
  process.exitCode = 1
}
