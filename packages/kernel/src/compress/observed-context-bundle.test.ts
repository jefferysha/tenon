import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { recordStepExit, startStepVisit, stepOutputsContextFor, recordInputReads } from '../documents/step-outputs.js'
import { emptyFields } from '../state/parse.js'
import { publishInitialRunRevision, publishRunRevision, readCurrentRunRevision } from '../state/run-revision-store.js'
import { createTransitionRecordStore } from '../state/transition-record-store.js'
import type { TransitionRecord } from '../workflow/run-types.js'
import { compileObservedContextBundle } from './ledger-context-bundle-node-adapter.js'
import { nodeLedgerContextBundlePrimitives } from './ledger-context-bundle-node-adapter.js'
import { LedgerContextBundleError, type LedgerContextBundleErrorCode } from './ledger-context-bundle-contract.js'
import {
  compileObservedContextBundleWithPorts,
  type ObservedBundleSource,
} from './observed-context-bundle.js'

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

async function expectBundleError(action: () => Promise<unknown>, code: LedgerContextBundleErrorCode): Promise<LedgerContextBundleError> {
  try {
    await action()
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerContextBundleError)
    const typed = error as LedgerContextBundleError
    expect(typed.code).toBe(code)
    expect(typed.repairAction.length).toBeGreaterThan(0)
    return typed
  }
  throw new Error(`expected ${code}`)
}

describe('观察模式的 Context Bundle（交接输入作为包的输入）', () => {
  const ROOT = '/project'
  const DESIGN = { path: 'docs/superpowers/specs/demo-design.md', text: '# Design\nDecision: observe.\n' }
  const PROPOSAL = { path: 'openspec/changes/demo/proposal.md', text: '# Proposal\n目标：交接输入\n' }

  function ports(
    sources: readonly ObservedBundleSource[],
    files: Readonly<Record<string, string>>,
    step: string | null = 'build',
  ) {
    return {
      root: ROOT, change: 'demo', from: 'spec', target: 'build',
      repository: { read: async () => ({ step, sources }) },
      sourceReader: {
        read: async (path: string) => {
          const text = files[path]
          if (text === undefined) throw new Error(`source is missing: ${path}`)
          return { text, sourceBytes: Buffer.byteLength(text, 'utf8') }
        },
      },
      primitives: nodeLedgerContextBundlePrimitives,
    }
  }
  const source = (doc: { path: string; text: string }, over: Partial<ObservedBundleSource> = {}): ObservedBundleSource => ({
    path: doc.path, fromStep: 'spec', skill: null, recordedSha256: sha(doc.text), readSha256s: [], ...over,
  })

  test('包的输入恰好是当前步骤的交接文档，按路径排序，原因点名上游步骤，摘要是源文件内容的 sha256', async () => {
    const result = await compileObservedContextBundleWithPorts(ports(
      [source(PROPOSAL), source(DESIGN, { fromStep: 'explore' })],
      { [DESIGN.path]: DESIGN.text, [PROPOSAL.path]: PROPOSAL.text },
    ))
    expect(result.bundle.schemaVersion).toBe('context-bundle/v1')
    expect(result.bundle.from).toBe('spec')
    expect(result.bundle.to).toBe('build')
    expect(result.bundle.inputs.map((input) => input.path)).toEqual([DESIGN.path, PROPOSAL.path])
    expect(result.bundle.inputs.map((input) => input.reason)).toEqual(['explore 的产出', 'spec 的产出'])
    expect(result.bundle.inputs.map((input) => input.digest)).toEqual([`sha256:${sha(DESIGN.text)}`, `sha256:${sha(PROPOSAL.text)}`])
    expect(result.preview.documentCount).toBe(2)
    expect(result.preview.inputs.map((input) => [input.path, input.fromStep])).toEqual([[DESIGN.path, 'explore'], [PROPOSAL.path, 'spec']])
    expect(result.preview.budget.usedBytes).toBe(result.bundle.budget.usedBytes)
  })

  test('本步改过输入后重读：回执摘要等于当前内容就算权威，包里带的是当前内容的摘要', async () => {
    const revised = `${DESIGN.text}Revised in build.\n`
    const result = await compileObservedContextBundleWithPorts(ports(
      [source(DESIGN, { readSha256s: [sha(revised)] })],
      { [DESIGN.path]: revised },
    ))
    expect(result.bundle.inputs[0]?.digest).toBe(`sha256:${sha(revised)}`)
  })

  test('本步改过输入又没重读：包失败关闭，点名文件与 tenon document read 修复', async () => {
    const revised = `${DESIGN.text}Revised in build.\n`
    const error = await expectBundleError(
      () => compileObservedContextBundleWithPorts(ports([source(DESIGN, { readSha256s: [sha(DESIGN.text)] })], { [DESIGN.path]: revised })),
      'CONTEXT_BUNDLE_DOCUMENT_STALE',
    )
    expect(error.path).toBe(DESIGN.path)
    expect(error.repairAction).toContain('tenon document read demo all')
  })

  test('源文件读不到：失败关闭并点名路径', async () => {
    const error = await expectBundleError(
      () => compileObservedContextBundleWithPorts(ports([source(DESIGN)], {})),
      'CONTEXT_BUNDLE_DOCUMENT_MISSING',
    )
    expect(error.path).toBe(DESIGN.path)
  })

  test('包只能为当前步骤编译：target 不是当前步骤 → 拒绝', async () => {
    await expectBundleError(
      () => compileObservedContextBundleWithPorts({ ...ports([source(DESIGN)], { [DESIGN.path]: DESIGN.text }), target: 'verify' }),
      'CONTEXT_BUNDLE_INVALID_REQUEST',
    )
  })

  test('没有当前步骤访问（任务缺 run 状态）：空包，不报错', async () => {
    const result = await compileObservedContextBundleWithPorts(ports([], {}, null))
    expect(result.bundle.inputs).toEqual([])
    expect(result.preview.documentCount).toBe(0)
  })

  test('非法请求：相对 root、非法 change 与非法预算', async () => {
    const base = ports([source(DESIGN)], { [DESIGN.path]: DESIGN.text })
    await expectBundleError(() => compileObservedContextBundleWithPorts({ ...base, root: 'relative' }), 'CONTEXT_BUNDLE_INVALID_REQUEST')
    await expectBundleError(() => compileObservedContextBundleWithPorts({ ...base, change: '../x' }), 'CONTEXT_BUNDLE_INVALID_REQUEST')
    await expectBundleError(() => compileObservedContextBundleWithPorts({ ...base, budgetBytes: 0 }), 'CONTEXT_BUNDLE_INVALID_REQUEST')
  })

  test('超预算：报告所需字节，且预算检查发生在摘要与存在性校验之后', async () => {
    const error = await expectBundleError(
      () => compileObservedContextBundleWithPorts({ ...ports([source(DESIGN)], { [DESIGN.path]: DESIGN.text }), budgetBytes: 1 }),
      'CONTEXT_BUNDLE_BUDGET_EXCEEDED',
    )
    expect(error.requiredBytes).toBeGreaterThan(1)
  })

  test('资源上限：单文件过大 → CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED', async () => {
    const error = await expectBundleError(
      () => compileObservedContextBundleWithPorts({
        ...ports([source(DESIGN)], { [DESIGN.path]: DESIGN.text }),
        resourceLimits: { maxRecords: 10, maxSourceBytesPerDocument: 4, maxTotalSourceBytes: 100 },
      }),
      'CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED',
    )
    expect(error.metric).toBe('sourceBytesPerDocument')
  })

  test('输入数超过 maxRecords → CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED', async () => {
    const error = await expectBundleError(
      () => compileObservedContextBundleWithPorts({
        ...ports([source(DESIGN), source(PROPOSAL)], { [DESIGN.path]: DESIGN.text, [PROPOSAL.path]: PROPOSAL.text }),
        resourceLimits: { maxRecords: 1, maxSourceBytesPerDocument: 1000, maxTotalSourceBytes: 1000 },
      }),
      'CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED',
    )
    expect(error.metric).toBe('records')
  })

  test('读取输入清单本身失败 → CONTEXT_BUNDLE_STATE_CORRUPT（不当作空包）', async () => {
    await expectBundleError(
      () => compileObservedContextBundleWithPorts({
        ...ports([], {}),
        repository: { read: async () => { throw new Error('步骤产出账本损坏') } },
      }),
      'CONTEXT_BUNDLE_STATE_CORRUPT',
    )
  })
})

describe('观察模式的 Context Bundle · 真实账本与文件', () => {
  const roots: string[] = []
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
  const AT = '2026-10-12T00:00:00.000Z'

  function git(root: string, ...args: string[]): void {
    execFileSync('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'pipe' })
  }
  async function write(root: string, path: string, content: string): Promise<void> {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  async function project(): Promise<{ readonly root: string; readonly changeDir: string }> {
    const root = await mkdtemp(join(tmpdir(), 'observed-bundle-'))
    roots.push(root)
    const changeDir = join(root, 'openspec', 'changes', 'demo')
    await mkdir(changeDir, { recursive: true })
    await write(root, 'README.md', '# readme\n')
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'init')
    const fields = emptyFields()
    fields.workflow = 'default'
    fields.phase = 'spec'
    await publishInitialRunRevision(changeDir, {
      fields, runMetadata: { runId: 'run-1', transitionSequence: 0, transitionHead: undefined }, opaqueTail: '',
    }, AT)
    return { root, changeDir }
  }
  /** 与转换一致：先 recordStepExit，再提交 transition revision。 */
  async function leave(changeDir: string, to: string): Promise<void> {
    const current = await readCurrentRunRevision(changeDir)
    const metadata = current?.state.runMetadata
    if (current === undefined || metadata === undefined) throw new Error('fixture: 缺少 run 身份')
    const from = String(current.state.fields.phase)
    await recordStepExit(stepOutputsContextFor(changeDir), { runId: metadata.runId, sequence: metadata.transitionSequence, step: from, event: 'next', to, at: AT })
    const sequence = metadata.transitionSequence + 1
    const id = `next-${sequence}`
    const record = {
      schemaVersion: 1, id, runId: metadata.runId, sequence, previousRecordId: metadata.transitionHead,
      workflowId: 'default', event: 'next', from, to, effects: [{ kind: 'state-field-change', field: 'phase', from, to }], observedAt: AT,
    } satisfies TransitionRecord
    await createTransitionRecordStore().write(changeDir, record)
    await publishRunRevision(changeDir, current, {
      ...current.state,
      fields: { ...current.state.fields, phase: to },
      runMetadata: { ...metadata, transitionSequence: sequence, transitionHead: id },
    }, { kind: 'transition', transitionRecordId: id, observedAt: AT })
  }

  test('build 步的包 = spec 访问产出的文档（代码文件不在其中），原因点名 spec', async () => {
    const { root, changeDir } = await project()
    await startStepVisit(stepOutputsContextFor(changeDir), { runId: 'run-1', sequence: 0, step: 'spec' }, AT)
    await write(root, 'openspec/changes/demo/specs/cap/spec.md', '# Spec\n- requirement\n')
    await write(root, 'docs/superpowers/plans/demo.md', '# Plan\n1. do it\n')
    await write(root, 'src/a.ts', 'export const a = 1\n')
    await leave(changeDir, 'build')

    const result = await compileObservedContextBundle({ root, change: 'demo', from: 'spec', target: 'build' })
    expect(result.bundle.inputs.map((input) => input.path)).toEqual([
      'docs/superpowers/plans/demo.md',
      'openspec/changes/demo/specs/cap/spec.md',
    ])
    expect(new Set(result.bundle.inputs.map((input) => input.reason))).toEqual(new Set(['spec 的产出']))
    expect(new Set(result.bundle.inputs.map((input) => input.mode))).toEqual(new Set(['summary']))
  })

  test('源文件在上游记录之后被改且没重读 → 失败；读完（回执 = 当前内容）→ 编译通过', async () => {
    const { root, changeDir } = await project()
    await startStepVisit(stepOutputsContextFor(changeDir), { runId: 'run-1', sequence: 0, step: 'spec' }, AT)
    await write(root, 'docs/superpowers/plans/demo.md', '# Plan\n1. do it\n')
    await leave(changeDir, 'build')
    await write(root, 'docs/superpowers/plans/demo.md', '# Plan\n1. do it, revised\n')

    await expectBundleError(() => compileObservedContextBundle({ root, change: 'demo', from: 'spec', target: 'build' }), 'CONTEXT_BUNDLE_DOCUMENT_STALE')
    await recordInputReads(stepOutputsContextFor(changeDir), 'all', AT)
    const result = await compileObservedContextBundle({ root, change: 'demo', from: 'spec', target: 'build' })
    expect(result.bundle.inputs[0]?.digest).toBe(`sha256:${sha('# Plan\n1. do it, revised\n')}`)
  })

  test('账本损坏 → CONTEXT_BUNDLE_STATE_CORRUPT（不当作没有输入）', async () => {
    const { root, changeDir } = await project()
    await writeFile(join(changeDir, '.pipeline-step-outputs.json'), '{not json')
    await expectBundleError(() => compileObservedContextBundle({ root, change: 'demo', from: 'spec', target: 'spec' }), 'CONTEXT_BUNDLE_STATE_CORRUPT')
  })
})
