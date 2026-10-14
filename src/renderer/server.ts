import { resolve } from 'node:path'

// Meta SPA доступен локально, отдельно от публичного HTTP сайта.
export function startRenderServer(directory: string) {
  const root = resolve(directory)
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    routes: {
      '/render': new Response(Bun.file(resolve(root, 'index.html')), {
        headers: { 'Cache-Control': 'no-store' }
      }),
      '/assets/*': { dir: resolve(root, 'assets') },
    },
  })
}
