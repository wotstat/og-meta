import { resolve } from 'node:path'
import { database } from '../database'

const databaseUrl = new URL(database.url)
const authorization = `Basic ${Buffer.from(`${database.username}:${database.password}`).toString('base64')}`

// Meta SPA доступен локально, отдельно от публичного HTTP сайта.
export function startRenderServer(directory: string) {
  const root = resolve(directory)

  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 10 * 1024 * 1024,
    routes: {
      '/render': new Response(Bun.file(resolve(root, 'index.html')), {
        headers: { 'Cache-Control': 'no-store' }
      }),
      '/assets/*': { dir: resolve(root, 'assets') },
      '/api/db/': { POST: proxyDatabaseRequest }
    }
  })
}

async function proxyDatabaseRequest(request: Request) {
  const incoming = new URL(request.url)
  if (incoming.searchParams.has('user') || incoming.searchParams.has('password'))
    return new Response('Database credentials are configured by the renderer', { status: 400 })

  const target = new URL(databaseUrl)
  target.search = incoming.search

  const headers = new Headers({ Authorization: authorization })
  for (const name of ['Content-Type', 'Accept-Encoding', 'X-Wotstat-Query-Cache-Key', 'X-Wotstat-Query-Cache-TTL', 'X-Wotstat-Query-Cache-Until']) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }

  const response = await fetch(target, {
    method: 'POST',
    headers,
    body: await request.arrayBuffer(),
    signal: request.signal,
    redirect: 'manual',
    decompress: false,
  })

  return new Response(response.body, { status: response.status, headers: response.headers })
}
