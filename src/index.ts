import { loadArtifact } from './artifact'
import { startServer } from './server'
import { RendererPool } from './renderer/RendererPool'
import { database } from './database'

const timeoutMs = Number(Bun.env.RENDER_TIMEOUT_MS ?? 15000)
const artifact = await loadArtifact(Bun.env.META_ARTIFACT_DIR ?? '../analytics-frontend/dist-meta')
const { createDatabase, createMetaResolver } = artifact.metadata
const { query } = createDatabase(database)
const resolver = createMetaResolver(query)

const pool = new RendererPool({
  clientDir: artifact.clientDir,
  formats: artifact.metadata.formats,
  size: Number(Bun.env.RENDER_POOL_SIZE ?? 2),
  maxQueue: Number(Bun.env.RENDER_QUEUE_LIMIT ?? 20),
  timeoutMs,
  chromePath: Bun.env.BUN_CHROME_PATH,
  noSandbox: Bun.env.CHROME_NO_SANDBOX === 'true',
})

let ready = false
let stopping = false
const server = startServer(artifact, resolver, pool, timeoutMs, () => ready && !stopping)

console.log(`Meta server: ${server.url} (version ${artifact.version})`)
Promise.all([pool.warmup(), resolver.warmup()]).then(
  () => {
    ready = true
    console.log('Contexts and Chromium pool ready')
  },
  error => console.error('Meta warmup failed; HTML remains available:', error),
)

const stop = async () => {
  if (stopping) return
  stopping = true
  const deadline = setTimeout(() => {
    console.error('Graceful shutdown timed out')
    resolver.close()
    pool.close()
    void server.stop(true)
    Bun.WebView.closeAll()
    process.exit(1)
  }, 30_000)
  await server.stop()
  clearTimeout(deadline)
  resolver.close()
  pool.close()
  Bun.WebView.closeAll()
  process.exit(0)
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
