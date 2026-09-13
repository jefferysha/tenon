import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureWorkflowRootAnchor, closeWorkflowRootAnchor } from './workflows.js'
import { resolveDefinitionCatalogRoute } from './definitionCatalogRoutes.js'
import type { PipelineCliRunner } from './operations.js'

const HOSTS = ['codex', 'claude', 'cursor', 'gemini', 'copilot', 'pi', 'devin', 'zed', 'aider', 'continue', 'cline', 'amp'] as const
const hostCatalog = {
  schema_version: 'host-target-plan/v1',
  targets: HOSTS.map((id) => ({
    id,
    kind: id === 'codex' || id === 'claude' ? 'native' : 'adapter',
    cli_flag: `--${id}`,
    target_scope: id === 'codex' || id === 'claude' ? 'user' : 'project',
    supported_operations: ['setup', 'update'],
    capabilities: id === 'codex' || id === 'claude'
      ? ['native-marketplace', 'managed-runtime', 'bundled-skills', 'automatic-update']
      : ['project-adapter', 'managed-runtime', 'bundled-skills'],
  })),
}

describe('definition catalog routes', () => {
  const anchors: Array<ReturnType<typeof captureWorkflowRootAnchor>> = []
  const roots: string[] = []
  afterEach(async () => {
    while (anchors.length) closeWorkflowRootAnchor(anchors.pop()!)
    while (roots.length) await rm(roots.pop()!, { recursive: true, force: true })
  })

  it('projects builtin definitions and adapter catalog through the real route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-catalog-'))
    roots.push(root)
    await mkdir(join(root, '.pipeline'), { recursive: true })
    const anchor = captureWorkflowRootAnchor(root)
    anchors.push(anchor)
    const runner = vi.fn<PipelineCliRunner>().mockResolvedValue({ exitCode: 0, stdout: JSON.stringify(hostCatalog), stderr: '' })
    let response: unknown
    const result = await resolveDefinitionCatalogRoute(
      { url: `/api/catalog?root=${encodeURIComponent(root)}` } as never,
      {} as never,
      '/api/catalog',
      {
        workflowRootForRequest: () => ({ ok: true, anchor }),
        hostHome: root,
        operationRunner: runner,
        trackValidationContextFor: () => ({ workflowExists: () => true, skillProfiles: new Set() }),
        clock: () => '2026-09-02T00:00:00.000Z',
        pollIntervalMs: 100,
        heartbeatMs: 1000,
        sendJson: (_res, _code, body) => { response = body },
      },
    )
    expect(result).toBe(true)
    expect((response as { schema_version: string }).schema_version).toBe('definition-catalog/v1')
    expect((response as { adapters: unknown[] }).adapters).toHaveLength(12)
    expect((response as { workflows: Array<{ id: string }> }).workflows.map((item) => item.id)).toEqual(['default', 'simple'])
    expect((response as { pipelines: unknown[] }).pipelines.length).toBeGreaterThan(0)
    expect(runner).toHaveBeenCalledWith(root, ['host-target-plan', '--json'])
    // 能力矩阵按 registry 三态原样上线：cursor 的 inject 是降级、veto 是原生且 fail-closed；
    // pi 是 tier B 却 inject 原生 / veto 降级——档位字母不决定哪个能力降级，折叠成布尔
    // 会把这两个宿主报成同一种「不是全绿」，UI 因此答不出「我的 veto 是不是降级的」。
    const adapters = (response as { adapters: Array<{ id: string; tier: string; capabilities: Record<string, string>; veto_fail_closed: boolean }> }).adapters
    const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]))
    expect(byId.get('cursor')).toMatchObject({
      tier: 'B',
      capabilities: { inject: 'degraded', veto: 'native', track: 'native' },
      veto_fail_closed: true,
    })
    expect(byId.get('pi')).toMatchObject({
      tier: 'B',
      capabilities: { inject: 'native', veto: 'degraded', track: 'native' },
      veto_fail_closed: false,
    })
    expect(byId.get('zed')?.capabilities).toEqual({ inject: 'degraded', veto: 'degraded', track: 'degraded' })
    expect(byId.get('codex')?.capabilities).toEqual({ inject: 'native', veto: 'native', track: 'native' })
  })

  it('fails closed before reading untrusted roots', async () => {
    let response: unknown
    const result = await resolveDefinitionCatalogRoute(
      { url: '/api/catalog?root=/tmp/evil' } as never,
      {} as never,
      '/api/catalog',
      {
        workflowRootForRequest: () => ({ ok: false, code: 403, error: 'untrusted' }),
        hostHome: '/tmp',
        operationRunner: vi.fn<PipelineCliRunner>(),
        trackValidationContextFor: () => ({ workflowExists: () => true, skillProfiles: new Set() }),
        clock: () => new Date(0).toISOString(),
        pollIntervalMs: 100,
        heartbeatMs: 1000,
        sendJson: (_res, code, body) => { response = { code, body } },
      },
    )
    expect(result).toBe(true)
    expect(response).toEqual({ code: 403, body: { ok: false, code: 'CATALOG_ROOT_INVALID', error: 'untrusted' } })
  })

  it('cleans up when the browser closes during the initial asynchronous projection', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'tenon-catalog-close-'))
    roots.push(root)
    await mkdir(join(root, '.pipeline'), { recursive: true })
    const anchor = captureWorkflowRootAnchor(root)
    anchors.push(anchor)
    let resolveHost: ((value: { exitCode: number; stdout: string; stderr: string }) => void) | undefined
    const runner = vi.fn<PipelineCliRunner>(() => new Promise((resolve) => { resolveHost = resolve }))
    const req = new EventEmitter()
    const writes: string[] = []
    const res = {
      writableEnded: false,
      writeHead: vi.fn(),
      write: vi.fn((chunk: string) => { writes.push(chunk); return true }),
    }
    ;(req as EventEmitter & { url: string }).url = `/api/catalog/stream?root=${encodeURIComponent(root)}`
    const pending = resolveDefinitionCatalogRoute(
      req as never,
      res as never,
      '/api/catalog/stream',
      {
        workflowRootForRequest: () => ({ ok: true, anchor }),
        hostHome: root,
        operationRunner: runner,
        trackValidationContextFor: () => ({ workflowExists: () => true, skillProfiles: new Set() }),
        clock: () => '2026-09-02T00:00:00.000Z',
        pollIntervalMs: 10,
        heartbeatMs: 10,
        sendJson: vi.fn(),
      },
    )
    req.emit('close')
    resolveHost?.({ exitCode: 0, stdout: JSON.stringify(hostCatalog), stderr: '' })
    await expect(pending).resolves.toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(runner).toHaveBeenCalledTimes(1)
    expect(writes).toEqual([])
    vi.useRealTimers()
  })
})
