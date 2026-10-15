import { loadArtifact } from './artifact'
import { startServer } from './server'
import { RendererPool } from './renderer/RendererPool'
import { database } from './database'

const timeoutMs = Number(Bun.env.RENDER_TIMEOUT_MS ?? 15000)
const artifact = await loadArtifact(Bun.env.META_ARTIFACT_DIR ?? '../analytics-frontend/dist-meta')
const resolver = artifact.metadata.createServerMetaResolver(database)

const pool = new RendererPool({
  clientDir: artifact.clientDir,
  formats: artifact.metadata.formats,
  size: Number(Bun.env.RENDER_POOL_SIZE ?? 2),
  maxQueue: Number(Bun.env.RENDER_QUEUE_LIMIT ?? 20),
  timeoutMs,
  chromePath: Bun.env.BUN_CHROME_PATH,
  noSandbox: Bun.env.CHROME_NO_SANDBOX === 'true',
})

const server = startServer(artifact, resolver, pool, timeoutMs)

console.log(`Meta server: ${server.url} (version ${artifact.version})`)
pool.warmup().then(
  () => console.log('Chromium pool ready'),
  error => console.error('Chromium warmup failed; HTML remains available:', error),
)

let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  resolver.close()
  pool.close()
  await server.stop(true)
  Bun.WebView.closeAll()
  process.exit(0)
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
