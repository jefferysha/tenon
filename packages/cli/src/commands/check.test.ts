import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  classifyTaskPlanProjectionForChange,
  createBuildRevisionToken,
  makeBuildRevisionBlocker,
  publishTaskPlanRevision,
} from '@tenon/kernel'
import type { GuardResult, PipelineState, TaskPlanRevisionV1 } from '@tenon/kernel'
import type { GuardFileContext } from '../deps.js'
import { cmdCheck } from './check.js'
import { makeGuardCtx } from '../guardContext.js'
import { makeDeps, mockState, spy } from '../test-support.js'

describe('check —— guard 报告（人读）；0 过 / 2 不过（CONTRACT §3）', () => {
  test('通过：报告打 stdout，exit 0', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'build', track: 'pm' }) })
    const code = await cmdCheck(deps, 'demo')
    expect(code).toBe(0)
    expect(deps.outLines).toEqual(['[CHECK] demo (phase=build)', '  [PASS] 所有检查通过'])
  })

  test('不过：逐条列出 failure + 汇总行，exit 2', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'spec', track: 'pm' }) })
    deps.flow.guardCheck = spy(
      (_s: PipelineState): GuardResult => ({ pass: false, failures: ['design_doc 缺失', 'plan 缺失'] }),
    )
    const code = await cmdCheck(deps, 'demo')
    expect(code).toBe(2)
    expect(deps.outLines).toEqual([
      '[CHECK] demo (phase=spec)',
      '  [FAIL] design_doc 缺失',
      '  [FAIL] plan 缺失',
      '  [FAIL] 共 2 项未通过',
    ])
  })

  test('受治理 default 的文档账本不通过会被明确渲染为 blocker，不能被 guard 绿灯掩盖', async () => {
    const deps = makeDeps({
      state: mockState({ phase: 'build', track: 'pm' }),
      documentEvidence: async (_root, _changeDir, phase) => ({
        phase,
        hasLedger: false,
        pass: false,
        blockers: ['document ledger 缺失'],
        items: [],
      }),
    })
    const code = await cmdCheck(deps, 'demo')
    expect(code).toBe(2)
    expect(deps.outLines).toEqual([
      '[CHECK] demo (phase=build)',
      '  [FAIL] document: document ledger 缺失',
      '  [FAIL] 共 1 项未通过',
    ])
  })

  test('guardCheck 收到读出的完整 state', async () => {
    const state = mockState({ phase: 'verify', track: 'backend' })
    const deps = makeDeps({ state })
    await cmdCheck(deps, 'demo')
    expect(deps.flow.guardCheck.calls[0]?.[0]).toBe(state)
  })

  test('注入 deps.guardCtx：按 change 名构造 GuardContext 并传给 guardCheck（全量文件面）', async () => {
    const seen: string[] = []
    const deps = makeDeps({
      state: mockState({ phase: 'open', track: 'backend' }),
      guardCtx: (name: string): GuardFileContext => {
        seen.push(name)
        return {
          changeDirRel: `openspec/changes/${name}`,
          readFileBounded: () => ({ kind: 'missing' }),
        }
      },
    })
    await cmdCheck(deps, 'demo')
    expect(seen).toEqual(['demo'])
    expect(deps.flow.guardCheck.calls[0]?.[1]?.changeDirRel).toBe('openspec/changes/demo')
    expect(deps.flow.guardCheck.calls[0]?.[1]?.coverageProfile).toBe('backend')
  })

  test('真实 check 先认证 exact canonical tasks source，再把信任闭包注入同步 guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'check-canonical-task-plan-'))
    const changeDir = join(root, 'openspec', 'changes', 'demo')
    await mkdir(changeDir, { recursive: true })
    const revision: TaskPlanRevisionV1 = {
      schema_version: 'task-plan/v1',
      plan_id: 'plan-1',
      revision_id: 'revision-1',
      revision_number: 1,
      status: 'frozen',
      created_at: '2026-08-04T00:00:00.000Z',
      requirements: [{ id: 'req-1', title: 'Requirement' }],
      acceptance_criteria: [{ id: 'acc-1', title: 'Acceptance' }],
      groups: [{ id: 'group-1', title: 'Verify', parent_id: null, work_item_ids: ['work-1'] }],
      work_items: [{
        id: 'work-1',
        title: 'Finish Build implementation',
        group_id: 'group-1',
        requirement_refs: ['req-1'],
        acceptance_refs: ['acc-1'],
        depends_on: [],
        resource_claims: [],
        expected_outputs: [],
        validators: [],
      }],
    }
    await publishTaskPlanRevision(changeDir, revision, { expected_current_revision_id: null })
    const tasksMarkdown = await readFile(join(changeDir, 'tasks.md'), 'utf8')
    expect(await classifyTaskPlanProjectionForChange(changeDir, tasksMarkdown)).toBe('current')
    let status: string | undefined
    const deps = makeDeps({
      cwd: root,
      state: mockState({ phase: 'build', track: 'backend' }),
      guardCtx: makeGuardCtx(root),
    })
    deps.flow.guardCheck = spy((_state: PipelineState, context): GuardResult => {
      status = context?.canonicalTasksProjectionStatus?.({
        changeDirRel: 'openspec/changes/demo',
        tasksMarkdown,
      })
      return { pass: true, failures: [] }
    })

    try {
      expect(await cmdCheck(deps, 'demo')).toBe(0)
      expect(status).toBe('current')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('真实 check 对 canonical current 的缺失 tasks projection 失败关闭，不能按非 Build absence 放行', async () => {
    const root = await mkdtemp(join(tmpdir(), 'check-missing-canonical-projection-'))
    const changeDir = join(root, 'openspec', 'changes', 'demo')
    await mkdir(changeDir, { recursive: true })
    const revision: TaskPlanRevisionV1 = {
      schema_version: 'task-plan/v1',
      plan_id: 'plan-1',
      revision_id: 'revision-1',
      revision_number: 1,
      status: 'frozen',
      created_at: '2026-08-04T00:00:00.000Z',
      requirements: [],
      acceptance_criteria: [],
      groups: [],
      work_items: [],
    }
    await publishTaskPlanRevision(changeDir, revision, { expected_current_revision_id: null })
    await rm(join(changeDir, 'tasks.md'))
    let status: string | undefined
    const deps = makeDeps({
      cwd: root,
      state: mockState({ phase: 'verify', track: 'backend' }),
      guardCtx: makeGuardCtx(root),
    })
    deps.flow.guardCheck = spy((_state: PipelineState, context): GuardResult => {
      status = context?.canonicalTasksProjectionStatus?.({
        changeDirRel: 'openspec/changes/demo',
        tasksMarkdown: '',
      })
      return { pass: status !== 'invalid', failures: status === 'invalid' ? ['invalid projection'] : [] }
    })

    try {
      expect(await cmdCheck(deps, 'demo')).toBe(2)
      expect(status).toBe('invalid')
      expect(deps.outLines).toContain('  [FAIL] invalid projection')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('真实 check 对非普通 canonical current + 缺失 tasks projection 失败关闭', async () => {
    const root = await mkdtemp(join(tmpdir(), 'check-invalid-canonical-current-'))
    const changeDir = join(root, 'openspec', 'changes', 'demo')
    await mkdir(join(changeDir, '.pipeline-task-plan', 'current.json'), { recursive: true })
    let status: string | undefined
    const deps = makeDeps({
      cwd: root,
      state: mockState({ phase: 'verify', track: 'backend' }),
      guardCtx: makeGuardCtx(root),
    })
    deps.flow.guardCheck = spy((_state: PipelineState, context): GuardResult => {
      status = context?.canonicalTasksProjectionStatus?.({
        changeDirRel: 'openspec/changes/demo',
        tasksMarkdown: '',
      })
      return { pass: status !== 'invalid', failures: status === 'invalid' ? ['invalid projection'] : [] }
    })

    try {
      expect(await cmdCheck(deps, 'demo')).toBe(2)
      expect(status).toBe('invalid')
      expect(deps.outLines).toContain('  [FAIL] invalid projection')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('真实 check 非 Verify phase 对真正缺失 canonical current 保留 legacy tasks absence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'check-legacy-absence-'))
    await mkdir(join(root, 'openspec', 'changes', 'demo'), { recursive: true })
    let receivedCanonicalStatus = false
    const deps = makeDeps({
      cwd: root,
      // Verify now always runs the typed revision barrier; this legacy tasks absence assertion
      // belongs to a non-Verify phase and preserves the old projection compatibility seam.
      state: mockState({ phase: 'build', track: 'backend' }),
      guardCtx: makeGuardCtx(root),
    })
    deps.flow.guardCheck = spy((_state: PipelineState, context): GuardResult => {
      receivedCanonicalStatus = context?.canonicalTasksProjectionStatus !== undefined
      return { pass: !receivedCanonicalStatus, failures: receivedCanonicalStatus ? ['not legacy'] : [] }
    })

    try {
      expect(await cmdCheck(deps, 'demo')).toBe(0)
      expect(receivedCanonicalStatus).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('canonical tasks 投影漂移时注入 invalid，不能降级为 legacy phase 解析', async () => {
    const root = await mkdtemp(join(tmpdir(), 'check-drifted-task-plan-'))
    const canonicalDir = join(root, 'openspec', 'changes', 'demo')
    await mkdir(canonicalDir, { recursive: true })
    const revision: TaskPlanRevisionV1 = {
      schema_version: 'task-plan/v1',
      plan_id: 'plan-1',
      revision_id: 'revision-1',
      revision_number: 1,
      status: 'frozen',
      created_at: '2026-08-04T00:00:00.000Z',
      requirements: [{ id: 'req-1', title: 'Requirement' }],
      acceptance_criteria: [{ id: 'acc-1', title: 'Acceptance' }],
      groups: [{ id: 'group-1', title: 'Build', parent_id: null, work_item_ids: ['work-1'] }],
      work_items: [{
        id: 'work-1',
        title: 'Finish implementation',
        group_id: 'group-1',
        requirement_refs: ['req-1'],
        acceptance_refs: ['acc-1'],
        depends_on: [],
        resource_claims: [],
        expected_outputs: [],
        validators: [],
      }],
    }
    await publishTaskPlanRevision(canonicalDir, revision, { expected_current_revision_id: null })
    const drifted = '# Tasks\n\n## Verify <!-- tenon-task-group:group-1 -->\n\n- [ ] Finish implementation <!-- tenon-work-item:work-1 -->\n'
    await writeFile(join(canonicalDir, 'tasks.md'), drifted, 'utf8')
    let status: string | undefined
    const deps = makeDeps({
      cwd: root,
      state: mockState({ phase: 'build', track: 'backend' }),
      guardCtx: makeGuardCtx(root),
    })
    deps.flow.guardCheck = spy((_state: PipelineState, context): GuardResult => {
      status = context?.canonicalTasksProjectionStatus?.({
        changeDirRel: 'openspec/changes/demo',
        tasksMarkdown: drifted,
      })
      return { pass: status !== 'invalid', failures: status === 'invalid' ? ['invalid projection'] : [] }
    })

    try {
      expect(await cmdCheck(deps, 'demo')).toBe(2)
      expect(status).toBe('invalid')
      await writeFile(join(canonicalDir, '.pipeline-task-plan', 'current.json'), '{malformed', 'utf8')
      status = undefined
      expect(await cmdCheck(deps, 'demo')).toBe(2)
      expect(status).toBe('invalid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('真实 check 在物化前拒绝超过 canonical byte cap 的 sparse tasks.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'check-oversized-task-plan-'))
    const canonicalDir = join(root, 'openspec', 'changes', 'demo')
    const tasksPath = join(canonicalDir, 'tasks.md')
    await mkdir(join(canonicalDir, '.pipeline-task-plan'), { recursive: true })
    await writeFile(join(canonicalDir, '.pipeline-task-plan', 'current.json'), '{}\n', 'utf8')
    await writeFile(tasksPath, '# Tasks\n', 'utf8')
    await truncate(tasksPath, 1_048_578)
    let status: string | undefined
    const deps = makeDeps({
      cwd: root,
      state: mockState({ phase: 'build', track: 'backend' }),
      guardCtx: makeGuardCtx(root),
    })
    deps.flow.guardCheck = spy((_state: PipelineState, context): GuardResult => {
      status = context?.canonicalTasksProjectionStatus?.({
        changeDirRel: 'openspec/changes/demo',
        tasksMarkdown: '',
      })
      return { pass: status !== 'invalid', failures: status === 'invalid' ? ['invalid projection'] : [] }
    })

    try {
      expect(await cmdCheck(deps, 'demo')).toBe(2)
      expect(status).toBe('invalid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('真实 check 在物化前执行更窄的 legacy 256 KiB byte cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'check-oversized-legacy-tasks-'))
    const changeDir = join(root, 'openspec', 'changes', 'demo')
    const tasksPath = join(changeDir, 'tasks.md')
    await mkdir(changeDir, { recursive: true })
    await writeFile(tasksPath, '# Tasks\n', 'utf8')
    await truncate(tasksPath, 256 * 1024 + 1)
    let status: string | undefined
    const deps = makeDeps({
      cwd: root,
      state: mockState({ phase: 'build', track: 'backend' }),
      guardCtx: makeGuardCtx(root),
    })
    deps.flow.guardCheck = spy((_state: PipelineState, context): GuardResult => {
      status = context?.canonicalTasksProjectionStatus?.({
        changeDirRel: 'openspec/changes/demo', tasksMarkdown: '',
      })
      return { pass: status !== 'invalid', failures: status === 'invalid' ? ['invalid projection'] : [] }
    })

    try {
      expect(await cmdCheck(deps, 'demo')).toBe(2)
      expect(status).toBe('invalid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('未注入文件探针也从 effective registry 取 policy，并显式传 coverageProfile 给 engine', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'open', track: 'pm' }) })
    await cmdCheck(deps, 'demo')
    expect(deps.flow.guardCheck.calls[0]?.[1]).toEqual({ coverageProfile: 'pm' })
  })

  test('warnings 渲染为 [WARN] 行（老 guard yellow 面），不影响 exit 0', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'spec', track: 'pm' }) })
    deps.flow.guardCheck = spy(
      (_s: PipelineState): GuardResult => ({
        pass: true,
        failures: [],
        warnings: ['hotfix：2 层覆盖留空（已豁免，建议补；🔒 锁不豁免）'],
      }),
    )
    const code = await cmdCheck(deps, 'demo')
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([
      '[CHECK] demo (phase=spec)',
      '  [WARN] hotfix：2 层覆盖留空（已豁免，建议补；🔒 锁不豁免）',
      '  [PASS] 所有检查通过',
    ])
  })

  test('不过且带 warnings：先 WARN 后 FAIL 明细，exit 2', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'spec', track: 'pm' }) })
    deps.flow.guardCheck = spy(
      (_s: PipelineState): GuardResult => ({
        pass: false,
        failures: ['spec 出口：全栈 Spec 覆盖（1 层阻塞）'],
        warnings: ['覆盖阻塞: L6_security required blank BLOCKED LOCKVIOLATION'],
      }),
    )
    const code = await cmdCheck(deps, 'demo')
    expect(code).toBe(2)
    expect(deps.outLines).toEqual([
      '[CHECK] demo (phase=spec)',
      '  [WARN] 覆盖阻塞: L6_security required blank BLOCKED LOCKVIOLATION',
      '  [FAIL] spec 出口：全栈 Spec 覆盖（1 层阻塞）',
      '  [FAIL] 共 1 项未通过',
    ])
  })

  test('状态文件缺失：exit 1', async () => {
    const deps = makeDeps()
    deps.store.read = spy(async (_d: string): Promise<PipelineState> => {
      throw new Error('ENOENT')
    })
    const code = await cmdCheck(deps, 'demo')
    expect(code).toBe(1)
  })

  test('非法 change 名：exit 1', async () => {
    const deps = makeDeps()
    const code = await cmdCheck(deps, '../etc')
    expect(code).toBe(1)
    expect(deps.store.read.calls).toHaveLength(0)
  })

  test('回归：workflow 字段空串（历史遗留）仍走 default guardCheck，不误入自定义分支（`||` 兜空串）', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'build', track: 'pm', workflow: '' }) })
    const code = await cmdCheck(deps, 'demo')
    expect(code).toBe(0)
    expect(deps.flow.guardCheck.calls).toHaveLength(1)
    expect(deps.outLines).toEqual(['[CHECK] demo (phase=build)', '  [PASS] 所有检查通过'])
  })

  test('Verify default check：旧 guard 绿灯也必须评估 null build_sha，typed blocker exit 2 且 assessor 恰一次', async () => {
    const deps = makeDeps({
      state: mockState({
        phase: 'verify', track: 'backend', verification_report: 'docs/v.md',
        branch_status: 'handled',
        isolation: 'branch', build_sha: 'null',
      }),
    })
    let calls = 0
    deps.assessBuildRevision = async (request) => {
      calls += 1
      return { trusted: false, blocker: makeBuildRevisionBlocker('null', request.stateHash) }
    }
    expect(await cmdCheck(deps, 'demo')).toBe(2)
    expect(calls).toBe(1)
    expect(deps.outLines[1]).toMatch(
      /^  \[FAIL\] verify-build-revision-untrusted reason=null remediation=return-to-build-and-capture-current-revision stateHash=sha256:[a-f0-9]{64}$/,
    )
  })

  test('Verify default check：typed assessor 通过时保留 legacy PASS，且恰评估一次', async () => {
    const deps = makeDeps({
      state: mockState({
        phase: 'verify', track: 'backend', verification_report: 'docs/v.md',
        branch_status: 'handled',
        isolation: 'branch', build_sha: 'build:v1:git:candidate',
      }),
    })
    let calls = 0
    deps.assessBuildRevision = async () => {
      calls += 1
      return {
        trusted: true as const,
        token: createBuildRevisionToken('git', 'a'.repeat(40), {
          repository: '/repo.git', worktree: '/repo\\0/worktree',
        }),
      }
    }
    expect(await cmdCheck(deps, 'demo')).toBe(0)
    expect(calls).toBe(1)
    expect(deps.outLines).toContain('  [PASS] 所有检查通过')
  })

  test('default 分支把 agent 阻断渲染成 [FAIL] agent: 行并计入总数', async () => {
    const deps = makeDeps({
      state: mockState({
        phase: 'verify', track: 'backend', verification_report: 'docs/v.md', branch_status: 'handled',
        isolation: 'branch', build_sha: 'build:v1:git:candidate',
      }),
    })
    deps.assessBuildRevision = async () => ({
      trusted: true as const,
      token: createBuildRevisionToken('git', 'a'.repeat(40), {
        repository: '/repo.git', worktree: '/repo\\0/worktree',
      }),
    })
    deps.stepAgents = async () => [{ kind: 'reviewer-stale', agent: 'security' }]
    expect(await cmdCheck(deps, 'demo')).toBe(2)
    expect(deps.outLines.some((line) =>
      line.startsWith("  [FAIL] agent: 评审者 'security' 的结论已过期"))).toBe(true)
    expect(deps.outLines).toContain('  [FAIL] 共 1 项未通过')
  })

  test('非 Verify default check 不调用 revision assessor', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'build', track: 'backend', build_sha: 'null' }) })
    let calls = 0
    deps.assessBuildRevision = async () => {
      calls += 1
      throw new Error('must not be called')
    }
    expect(await cmdCheck(deps, 'demo')).toBe(0)
    expect(calls).toBe(0)
  })

  test('Verify default check assessor 异常映射 evaluation-error 且 exit 2', async () => {
    const deps = makeDeps({
      state: mockState({
        phase: 'verify', track: 'backend', verification_report: 'docs/v.md',
        branch_status: 'handled', agent_review_result: 'pass', codex_review_result: 'pass',
        isolation: 'branch', build_sha: 'build:v1:git:candidate',
      }),
    })
    let calls = 0
    deps.assessBuildRevision = async () => {
      calls += 1
      throw new Error('/private/raw/path')
    }
    expect(await cmdCheck(deps, 'demo')).toBe(2)
    expect(calls).toBe(1)
    expect(deps.outLines.join('\n')).toContain(
      'verify-build-revision-untrusted reason=evaluation-error remediation=return-to-build-and-capture-current-revision',
    )
    expect(deps.outLines.join('\n')).not.toContain('/private/raw/path')
  })
})

/** 自定义 workflow 的 step-guard 预览（真临时目录，同 internalSkillGate.test.ts 手法）——
 * check 是纯预览：读当前 step 定义按 step-guard 评估，绝不写盘。exit 过 0 / guard 不过 2 /
 * 配置错（workflow 缺失·非法、step 不在图）1。 */
describe('check —— 自定义 workflow 按当前 step 的 step-guard 评估', () => {
  let root: string

  // s1 同时挂 tasks-at-least 与 nonempty-output 两类 guard（覆盖两条评估路径）；s1 声明到 s2 的
  // transition + s2 终态零 transition，仅为满足 loadWorkflow 读入时的 validateWorkflow（非终止 step
  // 必须有出边），与本文件只测的 step-guard 评估无关。
  const WF = `name: custom-check
steps:
  - id: s1
    label: build-step
    gate: null
    skills: []
    inputs: []
    outputs:
      - field: design_doc
        type: file_path
    guards:
      - type: tasks-at-least
        n: 1
      - type: nonempty-output
    transitions:
      - event: complete
        to: s2
  - id: s2
    label: done
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'check-custom-wf-'))
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'workflows', 'custom-check.yaml'), WF, 'utf8')
    await mkdir(join(root, 'openspec', 'changes', 'demo'), { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('step guard 全通过（tasks.md 达标 + 产出字段非空）→ exit 0 [PASS]，且不调 default guardCheck', async () => {
    await writeFile(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), '- [ ] 任务一\n', 'utf8')
    const deps = makeDeps({
      cwd: root,
      state: mockState({ workflow: 'custom-check', phase: 's1', design_doc: 'docs/design.md' }),
    })
    const code = await cmdCheck(deps, 'demo')
    expect(code).toBe(0)
    expect(deps.outLines).toEqual(['[CHECK] demo (phase=s1)', '  [PASS] 所有检查通过'])
    // 走自定义 step-guard 路径，不再委托 default 相位出口全量规则表
    expect(deps.flow.guardCheck.calls).toHaveLength(0)
  })

  test('step-graph 分支同样渲染 [FAIL] agent: 行', async () => {
    await writeFile(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), '- [ ] 任务一\n', 'utf8')
    const deps = makeDeps({
      cwd: root,
      state: mockState({ workflow: 'custom-check', phase: 's1', design_doc: 'docs/design.md' }),
    })
    deps.stepAgents = async () => [{ kind: 'executor-missing', agent: 'builder' }]
    expect(await cmdCheck(deps, 'demo')).toBe(2)
    expect(deps.outLines).toContain("  [FAIL] agent: 执行者 'builder' 未运行；运行：tenon agent next demo")
  })

  test('tasks-at-least 不足（缺 tasks.md）→ exit 2 [FAIL] 逐行 + 汇总', async () => {
    // design_doc 非空 → nonempty-output 单独通过，隔离出唯一一条 tasks 失败
    const deps = makeDeps({
      cwd: root,
      state: mockState({ workflow: 'custom-check', phase: 's1', design_doc: 'docs/design.md' }),
    })
    const code = await cmdCheck(deps, 'demo')
    expect(code).toBe(2)
    expect(deps.outLines).toEqual([
      '[CHECK] demo (phase=s1)',
      "  [FAIL] step 's1' 要求 tasks.md 至少 1 个任务（当前=0）",
      '  [FAIL] 共 1 项未通过',
    ])
  })

  test('nonempty-output 缺字段（design_doc 空）→ exit 2 [FAIL]', async () => {
    // tasks.md 达标 → tasks-at-least 单独通过，隔离出唯一一条产出字段失败
    await writeFile(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), '- [ ] 任务一\n', 'utf8')
    const deps = makeDeps({
      cwd: root,
      state: mockState({ workflow: 'custom-check', phase: 's1', design_doc: '' }),
    })
    const code = await cmdCheck(deps, 'demo')
    expect(code).toBe(2)
    expect(deps.outLines).toEqual([
      '[CHECK] demo (phase=s1)',
      "  [FAIL] 字段 'design_doc' 未设置（step 's1' 声明为必须产出）",
      '  [FAIL] 共 1 项未通过',
    ])
  })

  test('in-place workspace 基线 guard 预览会注入真实指纹能力，漂移时不误报 [PASS]', async () => {
    const baseline = `workspace:sha256:${'a'.repeat(64)}`
    const WORKSPACE_GUARD = `name: workspace-check
steps:
  - id: s1
    label: verify-in-place
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards:
      - type: build-head-unchanged
        field: build_sha
    transitions:
      - event: complete
        to: s2
  - id: s2
    label: done
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`
    await writeFile(join(root, '.pipeline', 'workflows', 'workspace-check.yaml'), WORKSPACE_GUARD, 'utf8')
    let gitCalls = 0
    const deps = makeDeps({
      cwd: root,
      state: mockState({ workflow: 'workspace-check', phase: 's1', isolation: 'in-place', build_sha: baseline }),
      workspaceFingerprint: async () => `workspace:sha256:${'b'.repeat(64)}`,
      gitHeadSha: async () => { gitCalls++; return 'UNUSED' },
    })

    expect(await cmdCheck(deps, 'demo')).toBe(2)
    expect(deps.outLines).toHaveLength(3)
    expect(deps.outLines[0]).toBe('[CHECK] demo (phase=s1)')
    expect(deps.outLines[1]).toMatch(
      /^  \[FAIL\] verify-build-revision-untrusted reason=malformed remediation=return-to-build-and-capture-current-revision stateHash=sha256:[a-f0-9]{64}$/,
    )
    expect(deps.outLines[1]).not.toContain(baseline)
    expect(deps.outLines[1]).not.toContain('workspace:sha256:bbbb')
    expect(deps.outLines[2]).toBe('  [FAIL] 共 1 项未通过')
    expect(gitCalls).toBe(0)
  })

  test('arbitrary Verify-like success exit 自动补 revision guard；仅 rollback exit 不要求 forward proof', async () => {
    const revisionWorkflow = `name: revision-check
steps:
  - id: implement-anything
    label: Implement
    gate: null
    skills: []
    inputs: []
    outputs:
      - field: build_sha
        type: string
    guards: []
    transitions:
      - event: ready
        to: assure-anything
  - id: assure-anything
    label: Assure
    gate: review
    skills: []
    inputs:
      - field: build_sha
        type: string
    outputs: []
    guards:
      - type: field-equals
        field: branch_status
        value: handled
    transitions:
      - event: pass
        to: ship-anything
      - event: rollback
        to: implement-anything
        actions:
          - type: mark-verification-failed
  - id: ship-anything
    label: Ship
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`
    await writeFile(join(root, '.pipeline', 'workflows', 'revision-check.yaml'), revisionWorkflow, 'utf8')
    const deps = makeDeps({
      cwd: root,
      state: mockState({
        workflow: 'revision-check', phase: 'assure-anything', isolation: 'branch', build_sha: 'legacy-sha',
        branch_status: 'handled',
      }),
    })
    let successAssessCalls = 0
    deps.assessBuildRevision = async () => {
      successAssessCalls += 1
      return { trusted: false, blocker: makeBuildRevisionBlocker('malformed') }
    }
    expect(await cmdCheck(deps, 'demo')).toBe(2)
    expect(deps.outLines.join('\n')).toContain('verify-build-revision-untrusted')
    expect(successAssessCalls).toBe(1)

    deps.outLines.length = 0
    let rollbackAssessCalls = 0
    deps.assessBuildRevision = async () => {
      rollbackAssessCalls += 1
      return { trusted: false, blocker: makeBuildRevisionBlocker('malformed') }
    }
    deps.store.read = spy(async () => mockState({
      workflow: 'revision-check', phase: 'assure-anything', isolation: 'branch', build_sha: 'legacy-sha',
      branch_status: 'handled',
    }))
    expect(await cmdCheck(deps, 'demo', { event: 'rollback' })).toBe(0)
    expect(deps.outLines).toContain('  [PASS] 所有检查通过')
    expect(rollbackAssessCalls).toBe(0)

    deps.outLines.length = 0
    deps.store.read = spy(async () => mockState({
      workflow: 'revision-check', phase: 'assure-anything', isolation: 'branch', build_sha: 'legacy-sha',
      branch_status: 'unhandled',
    }))
    expect(await cmdCheck(deps, 'demo', { event: 'rollback' })).toBe(2)
    expect(deps.outLines.join('\n')).toContain("step 'assure-anything' 要求字段 'branch_status'=handled")
    expect(rollbackAssessCalls).toBe(0)
  })

  test('workflow 文件不存在 → exit 1，stderr 报未找到，不写 stdout', async () => {
    const deps = makeDeps({ cwd: root, state: mockState({ workflow: 'ghost', phase: 's1' }) })
    const code = await cmdCheck(deps, 'demo')
    expect(code).toBe(1)
    expect(deps.outLines).toEqual([])
    expect(deps.errLines.join('\n')).toContain("workflow 'ghost' 未找到")
  })

  test('当前 phase 不是该 workflow 任何 step → exit 1', async () => {
    const deps = makeDeps({ cwd: root, state: mockState({ workflow: 'custom-check', phase: 'no-such-step' }) })
    const code = await cmdCheck(deps, 'demo')
    expect(code).toBe(1)
    expect(deps.outLines).toEqual([])
    expect(deps.errLines.join('\n')).toContain("step 'no-such-step' 不在 workflow 'custom-check' 里")
  })

  test('workflow 文件非法（悬空 transition to）→ loadWorkflow 抛错被 catch → exit 1（评审应修：钉住 try/catch 分支）', async () => {
    // s1 的出边指向不存在的 step → validateWorkflow 报「to 'ghost-step' 不存在」→ loadWorkflow
    // fail-loud 抛（parse 本身接受该文件，确保走的是 check.ts 的 catch 分支而非 parse 错误）。
    const BROKEN = `name: broken-wf
steps:
  - id: s1
    label: dangling
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: complete
        to: ghost-step
`
    await writeFile(join(root, '.pipeline', 'workflows', 'broken-wf.yaml'), BROKEN, 'utf8')
    const deps = makeDeps({ cwd: root, state: mockState({ workflow: 'broken-wf', phase: 's1' }) })
    const code = await cmdCheck(deps, 'demo')
    expect(code).toBe(1)
    expect(deps.outLines).toEqual([]) // 配置错不写 stdout（同 未找到/step 不在图 两分支）
    expect(deps.errLines.join('\n')).toContain('校验失败')
  })
})

