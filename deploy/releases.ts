import { createHash } from 'node:crypto'
import {
  closeSync, copyFileSync, cpSync, createReadStream, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export type DeploymentPair = {
  slot: 'blue' | 'green'
  release: string
  image: string
  source: string
  id: string
}

export type DeploymentState = {
  schema: 1
  releases: Record<string, number | null>
  active: DeploymentPair | null
  previous: DeploymentPair | null
  frontendRoot: string
  builds: Record<string, { image: string, createdAt: number }>
  sources: Record<string, number | null>
  pending?: {
    candidate: DeploymentPair
    gatewayConfig: string | null
  }
}

type ReleaseManifest = {
  schema: 1
  id: string
  files: Record<string, string>
}

// server.ts caps HTML max-age at 300; old tabs and emergency stale caches may outlive retained assets.
export const RETENTION_SECONDS = 7 * 86400 + 300
export const nowSeconds = () => Date.now() / 1000

export function atomicWrite(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = path + '.tmp'
  const fd = openSync(temporary, 'w')
  try {
    writeFileSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
}

export function writeJson(path: string, value: unknown) {
  atomicWrite(path, JSON.stringify(value, null, 2) + '\n')
}

export async function readJson<T>(path: string): Promise<T> {
  return Bun.file(path).json()
}

// Canonicalize even paths whose last components do not exist yet.
export function resolvePath(path: string): string {
  const absolute = resolve(path)
  if (existsSync(absolute)) return realpathSync(absolute)
  return join(resolvePath(dirname(absolute)), basename(absolute))
}

export function pointLink(path: string, target: string) {
  const current = lstatSync(path, { throwIfNoEntry: false })
  if (current && !current.isSymbolicLink()) throw new Error(`Refusing to replace directory/file with symlink: ${path}`)
  const temporary = path + '.tmp'
  if (lstatSync(temporary, { throwIfNoEntry: false })) unlinkSync(temporary)
  symlinkSync(target, temporary)
  renameSync(temporary, path)
}

function manifestId(files: Record<string, string>) {
  const content = Object.keys(files).sort().map(name => `${name}\0${files[name]}\n`).join('')
  return createHash('sha256').update(content).digest('hex').slice(0, 24)
}

async function digest(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function* filesIn(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* filesIn(path)
    else if (entry.isFile()) yield path
    else throw new Error(`Non-regular file in release: ${path}`)
  }
}

export async function makeManifest(root: string): Promise<ReleaseManifest> {
  const paths: string[] = []
  for (const directory of ['dist', 'dist-meta']) {
    const path = join(root, directory)
    if (!lstatSync(path).isDirectory()) throw new Error(`Missing directory: ${path}`)
    paths.push(...filesIn(path))
  }

  const files: Record<string, string> = {}
  for (const path of paths.sort()) {
    const name = relative(root, path)
    if (name !== 'dist-meta/release.json') files[name] = await digest(path)
  }
  return { schema: 1, id: manifestId(files), files }
}

export function releaseId(value: string) {
  if (!/^[a-f0-9]{24}$/.test(value)) throw new Error(`Invalid release id: ${value}`)
  return value
}

export function fallbackRelease(root: string) {
  const current = join(root, 'current')
  if (!lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) return null
  return releaseId(basename(dirname(resolvePath(current))))
}

export function setFallback(root: string, identifier: string) {
  pointLink(join(root, 'current'), join('releases', releaseId(identifier), 'dist'))
}

export async function publish(root: string, source: string) {
  const actual = await makeManifest(source)
  if (!isDeepStrictEqual(await readJson(join(source, 'dist-meta/release.json')), actual)) {
    throw new Error('Release manifest does not match uploaded files')
  }
  for (const name of ['dist/index.html', 'dist-meta/spa.html', 'dist-meta/server.mjs', 'dist-meta/client/index.html']) {
    if (!(name in actual.files)) throw new Error(`Missing release file: ${name}`)
  }
  if (actual.files['dist/index.html'] !== actual.files['dist-meta/spa.html']) {
    throw new Error('SPA and meta HTML belong to different builds')
  }

  const releases = join(root, 'releases')
  mkdirSync(releases, { recursive: true })
  const destination = join(releases, actual.id)
  if (existsSync(destination)) {
    if (!isDeepStrictEqual(await readJson(join(destination, 'dist-meta/release.json')), actual)
      || !isDeepStrictEqual(await makeManifest(destination), actual)) {
      throw new Error('Existing release manifest changed')
    }

    for (const [name, checksum] of Object.entries(actual.files)) {
      if (!name.startsWith('dist/assets/')) continue
      const shared = join(root, 'shared', name.slice(5))
      mkdirSync(dirname(shared), { recursive: true })
      if (!existsSync(shared)) linkSync(join(destination, name), shared)
      else if (await digest(shared) !== checksum) throw new Error(`Asset path reused with different contents: ${name}`)
    }
    return actual.id
  }

  const staging = mkdtempSync(join(releases, '.upload-'))
  try {
    for (const directory of ['dist', 'dist-meta']) cpSync(join(source, directory), join(staging, directory), { recursive: true })
    writeJson(join(staging, 'dist-meta/release.json'), actual)
    if (!isDeepStrictEqual(await makeManifest(staging), actual)) throw new Error('Release changed while copying')

    for (const [name, checksum] of Object.entries(actual.files)) {
      if (!name.startsWith('dist/assets/')) continue
      const shared = join(root, 'shared', name.slice(5))
      mkdirSync(dirname(shared), { recursive: true })
      if (existsSync(shared)) {
        if (await digest(shared) !== checksum) throw new Error(`Asset path reused with different contents: ${name}`)
      } else {
        copyFileSync(join(staging, name), shared + '.tmp')
        renameSync(shared + '.tmp', shared)
      }

      // Same filesystem: unchanged chunks occupy disk only once across releases.
      unlinkSync(join(staging, name))
      linkSync(shared, join(staging, name))
    }

    renameSync(staging, destination)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return actual.id
}

export async function collect(root: string, state: DeploymentState) {
  if (state.pending) throw new Error('Cannot collect during an unfinished activation')

  const protectedIds = new Set([state.active?.release, state.previous?.release, fallbackRelease(root)].filter(id => id != null))
  for (const identifier of protectedIds) {
    if (!(identifier in state.releases)) throw new Error('A protected release is missing from deployment state; refusing GC')
  }

  const now = nowSeconds()
  const retained = new Set<string>()
  const needed = new Set<string>()
  // Validate every retained manifest before deleting anything; damaged metadata fails closed.
  for (const [identifier, retiredAt] of Object.entries(state.releases)) {
    releaseId(identifier)
    if (!protectedIds.has(identifier) && retiredAt !== null && now >= retiredAt + RETENTION_SECONDS) continue
    const manifest = await readJson<ReleaseManifest>(join(root, 'releases', identifier, 'dist-meta/release.json'))
    if (manifest.schema !== 1 || manifest.id !== identifier || !manifest.files || typeof manifest.files !== 'object') {
      throw new Error(`Invalid retained manifest: ${identifier}`)
    }

    for (const [name, checksum] of Object.entries(manifest.files)) {
      if (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error(`Invalid checksum in ${identifier}`)
      if (name.startsWith('dist/assets/')) needed.add(name.slice(5))
    }
    if (manifestId(manifest.files) !== identifier) throw new Error(`Retained manifest contents changed: ${identifier}`)
    retained.add(identifier)
  }

  for (const identifier of Object.keys(state.releases)) {
    if (retained.has(identifier)) continue
    rmSync(join(root, 'releases', identifier), { recursive: true, force: true })
    delete state.releases[identifier]
    console.log(`Removed release ${identifier}`)
  }

  const assets = join(root, 'shared/assets')
  if (!existsSync(assets)) return
  for (const path of filesIn(assets)) {
    if (!needed.has(relative(join(root, 'shared'), path))) unlinkSync(path)
  }
}

