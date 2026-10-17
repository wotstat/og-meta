import type { Artifact, PageMeta, ImageFormat } from './artifact'
import { imageEncodings, preferredImageEncoding, type ImageEncoding } from './image'

export function imageUrl(page: URL, format: ImageFormat, encoding: ImageEncoding, version: string, origin: string, revisionKey?: string): string {
  const url = new URL(imageEncodings[encoding].path, origin)
  url.searchParams.set('url', page.pathname + page.search)
  url.searchParams.set('format', format)
  url.searchParams.set('v', version)
  if (revisionKey !== undefined) url.searchParams.set('r', revisionKey)
  return url.href
}

export function renderHtml(artifact: Artifact, page: URL, meta: PageMeta, imageOrigin: string): string {
  const { html, metadata, version } = artifact
  const properties: Record<string, string> = {
    'og:type': 'website',
    'og:title': meta.title,
    'og:url': page.href,
  }

  const names: Record<string, string> = {
    'twitter:card': meta.hasImage ? 'summary_large_image' : 'summary',
    'twitter:title': meta.title,
  }

  if (meta.description !== undefined) {
    properties['og:description'] = meta.description
    names.description = meta.description
    names['twitter:description'] = meta.description
  }

  if (meta.hasImage) {
    properties['og:image'] = imageUrl(page, 'og', preferredImageEncoding, version, imageOrigin, meta.revisionKey)
    properties['og:image:type'] = imageEncodings[preferredImageEncoding].contentType
    properties['og:image:width'] = String(metadata.formats.og.width)
    properties['og:image:height'] = String(metadata.formats.og.height)
    names['twitter:image'] = imageUrl(page, 'twitter', preferredImageEncoding, version, imageOrigin, meta.revisionKey)

    if (meta.imageAlt !== undefined) {
      properties['og:image:alt'] = meta.imageAlt
      names['twitter:image:alt'] = meta.imageAlt
    }
  }

  const tags = [
    `<title>${Bun.escapeHTML(meta.title)}</title>`,
    ...Object.entries(properties).map(([key, value]) => `<meta property="${key}" content="${Bun.escapeHTML(value)}">`),
    ...Object.entries(names).map(([key, value]) => `<meta name="${key}" content="${Bun.escapeHTML(value)}">`),
  ].join('\n')

  return new HTMLRewriter()
    .on('title, meta[name="description"], meta[property^="og:"], meta[name^="og:"], meta[name^="twitter:"], meta[property^="twitter:"]', {
      element: element => { element.remove() },
    })
    .on('head', { element: element => { element.append(`\n${tags}\n`, { html: true }) } })
    .transform(html)
}
