import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  compile: vi.fn(),
  snapshot: vi.fn(),
  inputs: vi.fn(),
  assertRoot: vi.fn(),
  captureChange: vi.fn(),
  assertChange: vi.fn(),
}))

vi.mock('@tenon/kernel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tenon/kernel')>(),
  compileLedgerContextBundleWithPorts: mocks.compile,
}))

vi.mock('./workflows.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./workflows.js')>(),
  assertWorkflowRootAnchor: mocks.assertRoot,
}))

vi.mock('./contextBundleTrustedReader.js', () => ({
  trustedContextBundleCurrentSnapshot: mocks.snapshot,
  trustedContextBundleInputs: mocks.inputs,
}))

vi.mock('./contextBundlePreviewSupport.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./contextBundlePreviewSupport.js')>(),
  captureChangePathAnchor: mocks.captureChange,
  assertChangePathAnchor: mocks.assertChange,
}))

import { LedgerContextBundleError } from '@tenon/kernel'
import { handleContextBundlePreview } from './contextBundlePreview.js'

/** Built-in default change: the preview resolves its document policy from this state. */
const STATE = { fields: { workflow: 'default', phase: 'build', track: '' }, opaqueTail: '' } as never

const preview = {
  change: 'demo',
  from: 'build',
  to: 'verify',
  tier: 'strong' as const,
  budget: { maxBytes: 1, usedBytes: 64 },
  documentCount: 0,
  inputs: [],
}

function request(): IncomingMessage {
  return {
    url: '/api/context-bundle/preview?root=%2Frepo&change=demo&target=verify&budgetBytes=1',
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
