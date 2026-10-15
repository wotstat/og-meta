import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { database } from './database'

// Контракт собранного server.mjs; исходники и Vue-зависимости сайта здесь не нужны.
export type ImageFormat = 'og' | 'twitter'

export type PageMeta = {
  definitionId: string
  hasImage: boolean
  title: string
  description?: string
  imageAlt?: string
  cache: { htmlSeconds: number, imageSeconds: number }
}

export type MetaResolver = {
  resolveMeta: (url: URL) => Promise<PageMeta>
  close: () => void
}

type MetaModule = {
  formats: Record<ImageFormat, { width: number, height: number }>
  createServerMetaResolver: (options: typeof database) => MetaResolver
}

export async function loadArtifact(directory: string) {
  const modulePath = join(directory, 'server.mjs')
  const htmlPath = join(directory, 'spa.html')
  const clientDir = join(directory, 'client')

  const metadata: MetaModule = await import(pathToFileURL(modulePath).href)
  const html = await Bun.file(htmlPath).text()

  // index.html содержит хешированные пути JS/CSS и учитывает изменения карточек.
  const version = createHash('sha256')
    .update(await Bun.file(modulePath).text())
    .update(await Bun.file(join(clientDir, 'index.html')).text())
    .digest('hex').slice(0, 16)
  return { metadata, html, clientDir, version }
}

export type Artifact = Awaited<ReturnType<typeof loadArtifact>>
