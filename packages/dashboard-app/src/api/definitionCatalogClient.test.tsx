import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchDefinitionCatalog, subscribeAdapterInstall, subscribeDefinitionCatalog } from './definitionCatalogClient'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly listeners = new Map<string, Array<(event: Event) => void>>()
  readonly close = vi.fn(() => { this.closed = true })
  closed = false
  readyState = 1

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  emit(type: string, data = ''): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent<string>)
    }
  }

  fail(): void {
    this.readyState = 2
    this.onerror?.(new Event('error'))
  }

  onerror: ((event: Event) => void) | null = null
}

const validState = {
  job_id: 'job-1', host: 'cursor', phase: 'installed', message: 'installed',
  at: '2026-09-02T00:00:00.000Z', exit_code: 0,
}

const validCatalog = {
  schema_version: 'definition-catalog/v1', revision: 'r1', fingerprint: 'f1', generated_at: '2026-09-02T00:00:00.000Z',
  project: { root: '/repo', identity: 'p1' }, adapters: [], workflows: [], tracks: [], pipelines: [],
}

const cursorAdapter = {
  id: 'cursor', label: 'Cursor', kind: 'adapter', tier: 'B', cli_flag: '--cursor', target_scope: 'project',
  capabilities: { inject: 'degraded', veto: 'native', track: 'native' }, veto_fail_closed: true,
  supported_operations: ['setup', 'update'], state: 'unknown',
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeEventSource.instances = []
})

describe('definition catalog adapter install stream', () => {
  it('closes the finite EventSource on complete so the browser cannot reconnect and replay states', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const onState = vi.fn()
    const onComplete = vi.fn()
    const stop = subscribeAdapterInstall('/api/adapters/install/job-1/stream', onState, onComplete)
    const source = FakeEventSource.instances[0]
    if (!source) throw new Error('EventSource fixture missing')

    source.emit('install-state', JSON.stringify({ schema_version: 'adapter-install-event/v1', kind: 'install-state', state: validState }))
    source.emit('complete', JSON.stringify({ schema_version: 'adapter-install-event/v1', kind: 'complete', job_id: 'job-1' }))
    source.emit('install-state', JSON.stringify({ schema_version: 'adapter-install-event/v1', kind: 'install-state', state: validState }))

    expect(onState).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(source.close).toHaveBeenCalledTimes(1)
    stop()
    expect(source.close).toHaveBeenCalledTimes(1)
  })

  it('closes and reports a malformed event or transport error instead of leaving the UI busy forever', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const onError = vi.fn()
    subscribeAdapterInstall('/api/adapters/install/job-1/stream', vi.fn(), undefined, onError)
    const source = FakeEventSource.instances[0]
    if (!source) throw new Error('EventSource fixture missing')

    source.emit('install-state', '{not-json')
    source.fail()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(source.close).toHaveBeenCalledTimes(1)
  })

  it('does not report a transient catalog reconnect as an error and deduplicates snapshots by fingerprint', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const onCatalog = vi.fn()
    const onError = vi.fn()
    const stop = subscribeDefinitionCatalog('/repo', onCatalog, onError)
    const source = FakeEventSource.instances[0]
    if (!source) throw new Error('EventSource fixture missing')

    source.onerror?.(new Event('error'))
    expect(onError).not.toHaveBeenCalled()
    source.emit('snapshot', JSON.stringify({ schema_version: 'definition-catalog-event/v1', kind: 'snapshot', revision: 'r1', fingerprint: 'f1', catalog: validCatalog }))
    source.emit('catalog-updated', JSON.stringify({ schema_version: 'definition-catalog-event/v1', kind: 'catalog-updated', revision: 'r1', fingerprint: 'f1', catalog: validCatalog }))
    expect(onCatalog).toHaveBeenCalledTimes(1)

    source.fail()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(source.close).toHaveBeenCalledTimes(1)
    stop()
  })

  it('reports an unavailable EventSource so an install UI can recover instead of staying busy', () => {
    const onError = vi.fn()
    vi.stubGlobal('EventSource', undefined)
    const stop = subscribeAdapterInstall('/api/adapters/install/job-1/stream', vi.fn(), undefined, onError)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(() => stop()).not.toThrow()
  })
})

describe('definition catalog adapter capability decoding', () => {
  it('passes the three capability grades and the veto failure mode through to the UI', async () => {
    // 严格解码：三态必须**原样**到达 UI。折叠成布尔（或在解码处丢字段）会让 degraded
    // 与 none 无法区分，UI 想诚实也无从表达。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ...validCatalog, adapters: [cursorAdapter] }),
    }))
    const catalog = await fetchDefinitionCatalog('/repo')
    expect(catalog.adapters[0]?.capabilities).toEqual({ inject: 'degraded', veto: 'native', track: 'native' })
    expect(catalog.adapters[0]?.veto_fail_closed).toBe(true)
  })

  it('rejects the retired boolean capability payload and an unknown grade instead of silently degrading', async () => {
    // 阳性对照：解码器必须真的看这三个字段，否则「前后端同一次改完」无从验证。
    for (const adapter of [
      { ...cursorAdapter, capabilities: { inject: true, veto: true, track: true } },
      { ...cursorAdapter, capabilities: { ...cursorAdapter.capabilities, track: 'partial' } },
      { ...cursorAdapter, veto_fail_closed: 'true' },
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, status: 200, json: async () => ({ ...validCatalog, adapters: [adapter] }),
      }))
      await expect(fetchDefinitionCatalog('/repo')).rejects.toThrow()
    }
  })
})
