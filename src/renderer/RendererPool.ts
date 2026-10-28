import type { Artifact, ImageFormat, PageMeta, RequestContext } from '../artifact'
import { imageQuality, type ImageEncoding } from '../image'
import { startRenderServer } from './server'

type RendererPoolOptions = {
  clientDir: string
  formats: Artifact['metadata']['formats']
  size: number
  maxQueue: number
  timeoutMs: number
  chromePath?: string
  noSandbox?: boolean
}

type RenderRequest = {
  url: string
  format: ImageFormat
  encoding: ImageEncoding
  meta: PageMeta
  request: RequestContext
}

export class RendererError extends Error {
  constructor(message: string, readonly status: 502 | 503 | 504, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RendererError'
  }
}

type Slot = {
  view: Bun.WebView | null
  cancel: ((error: RendererError) => void) | null
}

type Job = {
  request: RenderRequest
  deadline: number
  resolve: (image: Blob) => void
  reject: (error: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

export class RendererPool {
  private readonly slots: Slot[]
  private readonly queue: Job[] = []
  private readonly server: ReturnType<typeof startRenderServer>
  private closed = false

  constructor(private readonly options: RendererPoolOptions) {
    this.slots = Array.from({ length: options.size }, () => ({ view: null, cancel: null }))
    this.server = startRenderServer(options.clientDir)
  }

  get ready() {
    return !this.closed && this.slots.some(slot => slot.view)
  }

  async warmup(): Promise<void> {
    const tasks = this.slots.filter(slot => !slot.cancel && !slot.view)
      .map(slot => this.run(slot, Date.now() + this.options.timeoutMs, async () => { }))
    const results = await Promise.allSettled(tasks)
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }

  render(request: RenderRequest): Promise<Blob> {
    if (this.closed) return Promise.reject(new RendererError('Image renderer is closed', 503))

    const slot = this.slots.find(candidate => !candidate.cancel)
    if (!slot && this.queue.length >= this.options.maxQueue) {
      return Promise.reject(new RendererError('Image renderer queue is full', 503))
    }

    return new Promise((resolve, reject) => {
      const job: Job = { request, deadline: Date.now() + this.options.timeoutMs, resolve, reject }
      if (slot) {
        this.start(slot, job)
        return
      }

      job.timer = setTimeout(() => {
        this.queue.splice(this.queue.indexOf(job), 1)
        reject(new RendererError('Image renderer queue timed out', 504))
      }, this.options.timeoutMs)
      this.queue.push(job)
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true

    const error = new RendererError('Image renderer is closed', 503)
    for (const job of this.queue.splice(0)) {
      clearTimeout(job.timer)
      job.reject(error)
    }
    for (const slot of this.slots) {
      slot.cancel?.(error)
      slot.view?.close()
      slot.view = null
    }
    void this.server.stop(true)
  }

  private start(slot: Slot, job: Job) {
    clearTimeout(job.timer)
    void this.run(slot, job.deadline, async view => {
      const { width, height } = this.options.formats[job.request.format]
      await view.resize(width, height)
      await view.evaluate(`window.prepare(${JSON.stringify(job.request)})`)
      return view.screenshot({ format: job.request.encoding, quality: imageQuality })
    }).then(job.resolve, job.reject)
  }

  private async run<T>(slot: Slot, deadline: number, operation: (view: Bun.WebView) => Promise<T>): Promise<T> {
    if (this.closed) throw new RendererError('Image renderer is closed', 503)

    let view = slot.view
    let cancellation: RendererError | null = null

    slot.cancel = error => {
      cancellation = error
      view?.close()
    }

    const timer = setTimeout(() => {
      slot.cancel?.(new RendererError('Image rendering timed out', 504))
    }, Math.max(0, deadline - Date.now()))

    try {
      if (deadline <= Date.now()) throw new RendererError('Image rendering timed out', 504)
      if (!view) {
        view = new Bun.WebView({
          ...this.options.formats.og,
          backend: {
            type: 'chrome',
            url: false,
            path: this.options.chromePath,
            argv: this.options.noSandbox ? ['--no-sandbox'] : undefined,
          },
        })
        await view.navigate(`http://127.0.0.1:${this.server.port}/render`)
        if (!await view.evaluate('typeof window.prepare === "function"')) {
          throw new RendererError('Image renderer did not initialize', 502)
        }
        if (cancellation) throw cancellation
        slot.view = view
      }

      return await operation(view)
    } catch (error) {
      view?.close()
      slot.view = null
      if (cancellation) throw cancellation
      if (error instanceof RendererError) throw error
      throw new RendererError('Image renderer failed', 502, { cause: error })
    } finally {
      clearTimeout(timer)
      slot.cancel = null
      const next = this.queue.shift()
      if (next) this.start(slot, next)
    }
  }
}
