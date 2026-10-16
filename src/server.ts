import type { Artifact, MetaResolver } from './artifact'
import { imagePath, imageUrl, renderHtml } from './metadata'
import { RendererError, type RendererPool } from './renderer/RendererPool'

// Временно включаем метаданные только для */debug/* на время отладки.
const isDebugPage = (page: URL) => page.pathname.includes('/debug/')

export function startServer(artifact: Artifact, resolver: MetaResolver, pool: RendererPool, timeoutMs: number, isReady: () => boolean) {
  const publicOrigin = new URL(Bun.env.PUBLIC_ORIGIN ?? 'https://wotstat.info').origin
  const { version } = artifact

  return Bun.serve({
    hostname: Bun.env.HOST ?? '127.0.0.1',
    port: Number(Bun.env.PORT ?? 3000),
    idleTimeout: Math.ceil(timeoutMs / 1000) + 5,
    routes: {
      '/health': { GET: () => health(200) },
      '/ready': { GET: () => health(isReady() && pool.ready ? 200 : 503) },
      [imagePath]: { GET: image },
      '/*': { GET: html },
    },
    fetch: () => {
      const response = failure('Method not allowed', 405)
      response.headers.set('Allow', 'GET, HEAD')
      return response
    },
    error: error => {
      console.error('Meta request failed:', error)
      return failure('Internal server error', 500)
    },
  })

  function health(status: number) {
    return Response.json({ version, deploymentId: Bun.env.DEPLOYMENT_ID, rendererReady: pool.ready }, {
      status,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  async function html(request: Request) {
    const url = new URL(request.url)
    const page = pageUrl(url.pathname + url.search, publicOrigin)
    if (!page) return failure('Invalid page URL', 400)

    if (!isDebugPage(page)) {
      return new Response(request.method === 'HEAD' ? null : artifact.html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }

    const meta = await resolver.resolveMeta(page)
    return new Response(request.method === 'HEAD' ? null : renderHtml(artifact, page, meta, requestImageOrigin(request)), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': `public, max-age=${Math.min(300, Math.max(0, meta.cache.htmlSeconds))}`,
        Vary: 'X-Forwarded-Host',
      },
    })
  }

  async function image(request: Request) {
    const params = new URL(request.url).searchParams
    const raw = params.get('url')
    const format = params.get('format') ?? 'og'
    if (!raw || (format !== 'og' && format !== 'twitter')) return failure('Invalid image parameters', 400)

    const page = pageUrl(raw, publicOrigin)
    if (!page) return failure('Invalid page URL', 400)
    if (!isDebugPage(page)) return failure('Not found', 404)

    const requestedVersion = params.get('v')
    if (requestedVersion && requestedVersion !== version) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: imageUrl(page, format, version, requestImageOrigin(request), params.get('r') ?? undefined),
          'Cache-Control': 'no-store'
        },
      })
    }

    const meta = await resolver.resolveMeta(page)
    if (!meta.hasImage) return failure('No image for this page', 404)
    const headers = {
      'Content-Type': 'image/png',
      'Cache-Control': `public, max-age=${meta.cache.imageSeconds}`,
    }
    if (request.method === 'HEAD') return new Response(null, { headers })

    try {
      return new Response(await pool.render({ url: page.href, format, meta }), { headers })
    } catch (error) {
      console.error('Meta image rendering failed:', error)
      const status = error instanceof RendererError ? error.status : 502
      return failure('Image rendering is temporarily unavailable', status)
    }
  }
}

function requestImageOrigin(request: Request): string {
  const origin = new URL(Bun.env.IMAGE_ORIGIN ?? 'https://og.wotstat.info')
  const host = request.headers.get('x-forwarded-host') ?? new URL(request.url).host
  if (/^ru\.(?:[a-z0-9-]+\.)*wotstat\.info(?::\d+)?$/i.test(host) && !origin.hostname.startsWith('ru.')) {
    origin.hostname = `ru.${origin.hostname}`
  }
  return origin.origin
}

function failure(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function pageUrl(value: string, publicOrigin: string): URL | null {
  if (value.length > 8192) return null
  try {
    const page = new URL(value, publicOrigin)
    if (page.origin !== publicOrigin || page.username || page.password) return null
    page.hash = ''
    return page
  } catch {
    return null
  }
}
