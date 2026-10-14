import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PipelineState } from '@tenon/kernel'
import {
  readCurrentWorkflowDefinition,
  resolveWorkflowDefinitionStatusRoute,
  type WorkflowDefinitionStatusRouteDeps,
} from './serverWorkflowDefinitionStatusRoutes.js'
import {
  captureWorkflowRootAnchor,
  closeWorkflowRootAnchor,
  WorkflowPathError,
  WorkflowReadError,
} from './workflows.js'
import { ContextBundlePathError } from './contextBundlePreviewSupport.js'

const FROZEN = 'a'.repeat(64)

function state(workflow = 'custom', frozen = FROZEN): PipelineState {
  return {
    fields: { workflow },
    runMetadata: {
      runId: 'run-1',
      transitionSequence: 0,
      workflowPlanSnapshot: {
        version: 2,
        workflowId: workflow,
        executionModel: 'step-graph',
        workflow: { name: workflow, steps: [] },
        documentPolicy: null,
        workflowFingerprint: frozen,
      },
    },
    opaqueTail: '',
  }
}

function deps(overrides: Partial<WorkflowDefinitionStatusRouteDeps> = {}): WorkflowDefinitionStatusRouteDeps {
  return {
    workflowRootForRequest: vi.fn(() => ({ ok: true, anchor: { path: '/repo' } as never })),
    readChangeState: vi.fn(async () => state()),
    readCurrent: vi.fn(() => ({ kind: 'current', fingerprint: FROZEN })),
    ...overrides,
  }
}

describe('resolveWorkflowDefinitionStatusRoute', () => {
  it('returns null outside the endpoint', async () => {
    expect(await resolveWorkflowDefinitionStatusRoute('/', '/api/snapshot', deps())).toBeNull()
  })

  it('validates the change before resolving the root', async () => {
    const d = deps()
    expect(await resolveWorkflowDefinitionStatusRoute(
      '/api/workflow-definition-status?root=/repo&change=../bad',
      '/api/workflow-definition-status',
      d,
    )).toEqual({ status: 400, body: { ok: false, error: '非法 change 名（仅允许 a-z A-Z 0-9 - _）' } })
    expect(d.workflowRootForRequest).not.toHaveBeenCalled()
  })

  it('requires an explicit root before consulting the registered-root resolver', async () => {
    const d = deps()
    expect(await resolveWorkflowDefinitionStatusRoute(
      '/api/workflow-definition-status?change=demo',
      '/api/workflow-definition-status',
      d,
    )).toEqual({ status: 400, body: { ok: false, error: '缺少 root' } })
    expect(d.workflowRootForRequest).not.toHaveBeenCalled()
  })

  it('preserves registered-root and missing-change request errors', async () => {
    const denied = deps({ workflowRootForRequest: () => ({ ok: false, code: 404, error: 'unregistered' }) })
    expect(await resolveWorkflowDefinitionStatusRoute(
      '/api/workflow-definition-status?root=/other&change=demo',
      '/api/workflow-definition-status',
      denied,
    )).toEqual({ status: 404, body: { ok: false, error: 'root 未注册' } })

    const absent = deps({ readChangeState: async () => null })
    expect(await resolveWorkflowDefinitionStatusRoute(
      '/api/workflow-definition-status?root=/repo&change=demo',
      '/api/workflow-definition-status',
      absent,
    )).toEqual({ status: 400, body: { ok: false, error: '找不到该 change（无 canonical/legacy 状态）' } })
  })

  it('preserves a typed Change path violation as bounded 403', async () => {
    const denied = deps({
      readChangeState: async () => {
        throw new ContextBundlePathError(403, '/private/repo/change escaped')
      },
    })
    const result = await resolveWorkflowDefinitionStatusRoute(
      '/api/workflow-definition-status?root=/repo&change=demo',
      '/api/workflow-definition-status',
      denied,
    )
    expect(result).toEqual({
      status: 403,
      body: { ok: false, error: 'canonical change 路径不可信' },
    })
    expect(JSON.stringify(result)).not.toContain('/private/repo')
  })

  it('preserves a typed workflow-definition path violation as bounded 403', async () => {
    const denied = deps({
      readCurrent: () => {
        throw new WorkflowPathError('/private/repo/workflow escaped')
      },
    })
    const result = await resolveWorkflowDefinitionStatusRoute(
      '/api/workflow-definition-status?root=/repo&change=demo',
      '/api/workflow-definition-status',
      denied,
    )
    expect(result).toEqual({
      status: 403,
      body: { ok: false, error: 'workflow 定义路径不可信' },
    })
    expect(JSON.stringify(result)).not.toContain('/private/repo')
  })

  it('keeps a workflow I/O failure distinct from a forbidden path', async () => {
    const unreadable = deps({
      readCurrent: () => {
        throw new WorkflowReadError('/private/repo/workflow unreadable')
      },
    })
    const result = await resolveWorkflowDefinitionStatusRoute(
      '/api/workflow-definition-status?root=/repo&change=demo',
      '/api/workflow-definition-status',
      unreadable,
    )
    expect(result).toEqual({
      status: 500,
      body: { ok: false, error: 'workflow definition 读取失败' },
    })
    expect(JSON.stringify(result)).not.toContain('/private/repo')
  })

  it.each([
    [{ kind: 'missing' } as const, 'missing'],
    [{ kind: 'invalid' } as const, 'invalid'],
  ])('maps a safe current-definition outcome without leaking errors', async (current, status) => {
    const d = deps({ readCurrent: vi.fn(() => current) })
    const result = await resolveWorkflowDefinitionStatusRoute(
      '/api/workflow-definition-status?root=/repo&change=demo',
      '/api/workflow-definition-status',
      d,
    )
    expect(result).toEqual({
      status: 200,
      body: {
        schema: 'workflow-definition-status/v1',
        workflow: 'custom',
        status,
        frozen_fingerprint: FROZEN,
        current_fingerprint: null,
      },
    })
    expect(JSON.stringify(result)).not.toContain('/repo/.pipeline')
  })
})

describe('readCurrentWorkflowDefinition', () => {
  it('uses the trusted reader to distinguish current, missing, and invalid definitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-definition-status-'))
    const workflows = join(root, '.pipeline', 'workflows')
    await mkdir(workflows, { recursive: true })
    await writeFile(join(workflows, 'valid.yaml'), `name: valid
steps:
  - id: open
    label: Open
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`, 'utf8')
    await writeFile(join(workflows, 'broken.yaml'), 'name: broken\nsteps: nope\n', 'utf8')
    const outside = await mkdtemp(join(tmpdir(), 'workflow-definition-status-outside-'))
    await writeFile(join(outside, 'linked.yaml'), 'name: linked\nsteps: []\n', 'utf8')
    await symlink(join(outside, 'linked.yaml'), join(workflows, 'linked.yaml'), 'file')
    const anchor = captureWorkflowRootAnchor(root)
    try {
      // 有分支的 default 必须带上任务的轨道才算得出当前指纹；缺轨道按「当前定义不可用」处理。
      expect(readCurrentWorkflowDefinition(anchor, 'default', { track: 'backend' })).toMatchObject({
        kind: 'current',
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      expect(readCurrentWorkflowDefinition(anchor, 'default', {})).toEqual({ kind: 'invalid' })
      expect(readCurrentWorkflowDefinition(anchor, 'valid', {})).toMatchObject({
        kind: 'current',
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      expect(readCurrentWorkflowDefinition(anchor, 'ghost', {})).toEqual({ kind: 'missing' })
      expect(readCurrentWorkflowDefinition(anchor, 'broken', {})).toEqual({ kind: 'invalid' })
      expect(() => readCurrentWorkflowDefinition(anchor, 'linked', {})).toThrow(WorkflowPathError)
    } finally {
      closeWorkflowRootAnchor(anchor)
    }
  })

  it('classifies a captured root identity replacement as a workflow path violation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-definition-root-race-'))
    const anchor = captureWorkflowRootAnchor(root)
    const original = `${root}.original`
    const outside = await mkdtemp(join(tmpdir(), 'workflow-definition-root-outside-'))
    try {
      await rename(root, original)
      await symlink(outside, root, 'dir')
      expect(() => readCurrentWorkflowDefinition(anchor, 'default', { track: 'backend' })).toThrow(WorkflowPathError)
    } finally {
      closeWorkflowRootAnchor(anchor)
    }
  })
})
