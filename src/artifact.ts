import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { database } from './database'

// Контракт собранного server.mjs; исходники и Vue-зависимости сайта здесь не нужны.
export type ImageFormat = 'og' | 'twitter'

export type RequestContext = {
  url: string
}

export type PageMeta = {
  definitionId: string
  hasImage: boolean
  title: string
  description?: string
  imageAlt?: string
  revisionKey?: string
  cache: { htmlSeconds: number, imageSeconds: number }
}

export type MetaResolver = {
  resolveMeta: (url: URL, request: RequestContext) => Promise<PageMeta>
  warmup: () => Promise<void>
  close: () => void
}

type MetaModule = {
  formats: Record<ImageFormat, { width: number, height: number }>
  createDatabase: (options: typeof database) => { query: unknown }
  createMetaResolver: (query: unknown) => MetaResolver
}

export async function loadArtifact(directory: string) {
  const modulePath = join(directory, 'server.mjs')
  const htmlPath = join(directory, 'spa.html')
  const clientDir = join(directory, 'client')

  const release: { schema: number, id: string } = await Bun.file(join(directory, 'release.json')).json()
  if (release.schema !== 1 || typeof release.id !== 'string' || !/^[a-f0-9]{24}$/.test(release.id)) {
    throw new Error('Invalid frontend release manifest')
  }
  if (Bun.env.RELEASE_ID && Bun.env.RELEASE_ID !== release.id) {
    throw new Error('Frontend release differs from the deployed release ID')
  }

  const metadata: MetaModule = await import(pathToFileURL(modulePath).href)
  const html = await Bun.file(htmlPath).text()
  return { metadata, html, clientDir, version: release.id }
}

export type Artifact = Awaited<ReturnType<typeof loadArtifact>>
