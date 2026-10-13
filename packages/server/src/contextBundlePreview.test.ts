import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  compile: vi.fn(),
  compileObserved: vi.fn(),
  snapshot: vi.fn(),
  inputs: vi.fn(),
  sourceReader: vi.fn(),
  assertRoot: vi.fn(),
  captureChange: vi.fn(),
  assertChange: vi.fn(),
}))

vi.mock('@tenon/kernel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tenon/kernel')>(),
  compileLedgerContextBundleWithPorts: mocks.compile,
  compileObservedContextBundleWithPorts: mocks.compileObserved,
}))

vi.mock('./workflows.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./workflows.js')>(),
  assertWorkflowRootAnchor: mocks.assertRoot,
}))

vi.mock('./contextBundleTrustedReader.js', () => ({
  trustedContextBundleCurrentSnapshot: mocks.snapshot,
  trustedContextBundleInputs: mocks.inputs,
  trustedContextBundleSourceReader: mocks.sourceReader,
}))

vi.mock('./contextBundlePreviewSupport.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./contextBundlePreviewSupport.js')>(),
  captureChangePathAnchor: mocks.captureChange,
  assertChangePathAnchor: mocks.assertChange,
}))

import {
  compileEffectiveWorkflowPlan, effectiveWorkflowPlanBinding, LedgerContextBundleError, workflowPlanSnapshot,
} from '@tenon/kernel'
import { handleContextBundlePreview } from './contextBundlePreview.js'

/** Built-in default change: the preview resolves its document policy from this state. */
const STATE = { fields: { workflow: 'default', phase: 'build', track: '' }, opaqueTail: '' } as never

/** 新建的 default 任务：冻结计划没有文档契约（观察模式），预览的包是当前步骤的交接输入。 */
const OBSERVED_STATE = (() => {
  const plan = compileEffectiveWorkflowPlan('default', undefined, { track: 'backend' })
  return {
    fields: { workflow: 'default', phase: 'build', track: 'backend' },
    runMetadata: { ...effectiveWorkflowPlanBinding(plan), workflowPlanSnapshot: workflowPlanSnapshot(plan) },
    opaqueTail: '',
  } as never
})()

const preview = {
  change: 'demo',
  from: 'build',
  to: 'verify',
  tier: 'strong' as const,
  budget: { maxBytes: 1, usedBytes: 64 },
  documentCount: 0,
  inputs: [],
}

function request(target = 'verify'): IncomingMessage {
  return {
    url: `/api/context-bundle/preview?root=%2Frepo&change=demo&target=${target}&budgetBytes=1`,
  } as IncomingMessage
}

function deps() {
  return {
    sendJson: vi.fn(),
    workflowRootForRequest: vi.fn(() => ({
      ok: true as const,
      anchor: {
        path: '/repo',
        realPath: '/repo',
        fdPath: '/proc/self/fd/10',
      },
    })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.captureChange.mockReturnValue({
    changeDir: '/repo/openspec/changes/demo',
    realPath: '/repo/openspec/changes/demo',
    chain: [
      { path: '/repo/openspec', dev: 1, ino: 1 },
      { path: '/repo/openspec/changes', dev: 1, ino: 2 },
      { path: '/repo/openspec/changes/demo', dev: 1, ino: 3 },
    ],
  })
  mocks.inputs.mockReturnValue({
    ledger: { version: 1, contract: 'openspec-v1', createdAt: 't', records: [] },
    sourceReader: { read: vi.fn() },
  })
})

describe('Context Bundle preview canonical snapshot barrier', () => {
  it('compiler 成功但 revision 改变时返回 409，不返回旧 success preview', async () => {
    mocks.snapshot
      .mockReturnValueOnce({ phase: 'build', revisionId: 'rev-before', stateDigest: 'a'.repeat(64), state: STATE })
      .mockReturnValueOnce({ phase: 'verify', revisionId: 'rev-after', stateDigest: 'b'.repeat(64), state: STATE })
    mocks.compile.mockResolvedValue({
      preview,
      bundle: { aggregateDigest: `sha256:${'c'.repeat(64)}` },
    })
    const runtime = deps()

    await handleContextBundlePreview(request(), {} as ServerResponse, runtime)

    expect(runtime.sendJson).toHaveBeenLastCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({ code: 'CONTEXT_BUNDLE_STATE_CORRUPT' }),
    )
    expect(runtime.sendJson.mock.calls.at(-1)?.[2]).not.toHaveProperty('preview')
  })

  it('compiler 产生 422 preview 但 revision 改变时仍由 409 barrier 覆盖', async () => {
    mocks.snapshot
      .mockReturnValueOnce({ phase: 'build', revisionId: 'rev-before', stateDigest: 'a'.repeat(64), state: STATE })
      .mockReturnValueOnce({ phase: 'verify', revisionId: 'rev-after', stateDigest: 'b'.repeat(64), state: STATE })
    mocks.compile.mockRejectedValue(new LedgerContextBundleError(
      'CONTEXT_BUNDLE_BUDGET_EXCEEDED',
      'budget exceeded',
      {
        repairAction: 'increase budget',
        requiredBytes: 64,
        availableBytes: 1,
        preview,
      },
    ))
    const runtime = deps()

    await handleContextBundlePreview(request(), {} as ServerResponse, runtime)

    expect(runtime.sendJson).toHaveBeenLastCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({ code: 'CONTEXT_BUNDLE_STATE_CORRUPT' }),
    )
    expect(runtime.sendJson.mock.calls.at(-1)?.[2]).not.toHaveProperty('preview')
  })
})

describe('Context Bundle preview · 新任务（没有文档契约）', () => {
  const observedPreview = {
    change: 'demo',
    from: 'build',
    to: 'verify',
    tier: 'strong' as const,
    budget: { maxBytes: 1, usedBytes: 64 },
    documentCount: 1,
    inputs: [{
      path: 'docs/specs/a.md',
      fromStep: 'spec',
      skill: 'writing-plans',
      digest: `sha256:${'d'.repeat(64)}` as const,
      reason: 'spec 的产出',
      mode: 'summary' as const,
      sourceBytes: 10,
      materializedBytes: 20,
    }],
  }

  beforeEach(() => {
    mocks.snapshot.mockReturnValue({ phase: 'build', revisionId: 'rev', stateDigest: 'a'.repeat(64), state: OBSERVED_STATE })
    mocks.sourceReader.mockReturnValue({ read: vi.fn() })
  })

  it('改用观察模式的编译器：包是当前步骤的交接输入，不读文档账本；预览带上游步骤与来源技能', async () => {
    mocks.compileObserved.mockResolvedValue({ preview: observedPreview, bundle: { aggregateDigest: `sha256:${'c'.repeat(64)}` } })
    const runtime = deps()

    await handleContextBundlePreview(request(), {} as ServerResponse, runtime)

    expect(mocks.compileObserved).toHaveBeenCalledWith(expect.objectContaining({
      root: '/repo', change: 'demo', from: 'build', target: 'verify', budgetBytes: 1, repository: expect.any(Object),
    }))
    expect(mocks.compile).not.toHaveBeenCalled()
    expect(mocks.inputs).not.toHaveBeenCalled()
    expect(runtime.sendJson).toHaveBeenLastCalledWith(expect.anything(), 200, {
      ok: true,
      preview: expect.objectContaining({
        schemaVersion: 'context-bundle-preview/v1',
        sideEffects: 'none',
        documentCount: 1,
        aggregateDigest: `sha256:${'c'.repeat(64)}`,
        budget: { maxBytes: 1, usedBytes: 64, fits: true },
        inputs: [{
          kind: 'handoff',
          path: 'docs/specs/a.md',
          digest: `sha256:${'d'.repeat(64)}`,
          reason: 'spec 的产出',
          reasonCode: 'context-bundle.reason.handoff',
          mode: 'summary',
          sourceBytes: 10,
          materializedBytes: 20,
          fromStep: 'spec',
          skill: 'writing-plans',
        }],
      }),
    })
  })

  it('target 必须是计划里的步骤，不是就 400 且不编译', async () => {
    const runtime = deps()

    await handleContextBundlePreview(request('not-a-step'), {} as ServerResponse, runtime)

    expect(runtime.sendJson).toHaveBeenLastCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ ok: false, code: 'CONTEXT_BUNDLE_INVALID_REQUEST', error: 'target 必须是 workflow step: not-a-step' }),
    )
    expect(mocks.compileObserved).not.toHaveBeenCalled()
  })

  it('编译器的类型化失败照旧映射（输入被改过没有重读 = 409）', async () => {
    mocks.compileObserved.mockRejectedValue(new LedgerContextBundleError(
      'CONTEXT_BUNDLE_DOCUMENT_STALE', 'stale input', { path: 'docs/specs/a.md', repairAction: 'reread' },
    ))
    const runtime = deps()

    await handleContextBundlePreview(request(), {} as ServerResponse, runtime)

    expect(runtime.sendJson).toHaveBeenLastCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({ code: 'CONTEXT_BUNDLE_DOCUMENT_STALE' }),
    )
  })
})
