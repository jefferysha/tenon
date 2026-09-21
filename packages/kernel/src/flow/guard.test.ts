/**
 * BACKLOG #12 · guard 全量校验面测试 —— 对照 GUARD-RULES.md 规则表逐条红/绿。
 * 语义源：老仓 pipeline-guard.sh + pipeline-guard-lib.sh + manifest.yaml exit_checks（只读）。
 *
 * 约定：
 *   · 纯字段规则（yaml_nonempty / yaml_eq / automation 闸）无 ctx 也评估（lite 兼容面）。
 *   · 文件类规则仅在 ctx 注入对应能力时评估；未注入 → 静默跳过（GUARD-RULES §7.2）。
 *   · 文件路径锚点：change 内产物（proposal/tasks/design.md/.pipeline.yaml）相对
 *     ctx.changeDirRel；字段指向的文件（design_doc/plan/verification_report/prd_path）
 *     相对项目根（老 guard 在项目根运行，`[ -f "$p" ]` 直接用字段值）。
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIELD_ORDER, LIST_FIELDS } from '../types.js'
import { createBuildRevisionToken } from '../workflow/build-revision.js'
import type { FieldName, GuardContext, PipelineState } from '../types.js'
import { renderTaskPlanTasksMd, type TaskPlanRevisionV1 } from '../task-plan/index.js'
import type { CoverageProfile } from '../tracks/types.js'
import { evaluateGuard } from './guard.js'
import { checkDefaultEventPreconditions } from './default-event-policy.js'
import { createFlowEngine, loadManifest } from './index.js'
import { fileURLToPath } from 'node:url'

const CH = 'openspec/changes/demo'

function makeState(overrides: Partial<Record<FieldName, string | string[]>> = {}): PipelineState {
  const fields = {} as Record<FieldName, string | string[]>
  for (const f of FIELD_ORDER) {
    fields[f] = (LIST_FIELDS as readonly string[]).includes(f) ? [] : ''
  }
  Object.assign(fields, overrides)
  return { fields, opaqueTail: '' }
}

interface CtxOpts {
  activeDirs?: string[]
  archived?: string[]
  activeArchived?: string[]
  automationRunner?: boolean
  changeDirRel?: string
  coverageProfile?: CoverageProfile
}

/** 从「相对路径 → 内容」映射构造全量注入的 GuardContext */
function ctxOf(files: Record<string, string>, opts: CtxOpts = {}): GuardContext {
  const has = (p: string) => Object.prototype.hasOwnProperty.call(files, p)
  return {
    coverageProfile: opts.coverageProfile ?? 'backend',
    changeDirRel: opts.changeDirRel ?? CH,
    fileExists: (p) => has(p),
    fileNonempty: (p) => has(p) && files[p]!.length > 0,
    readFile: (p) => (has(p) ? files[p] : undefined),
    dirExists: (p) => (opts.activeDirs ?? []).includes(p),
    activeChangeArchived: (dep) => (opts.activeArchived ?? []).includes(dep),
    changeArchived: (dep) => (opts.archived ?? []).includes(dep),
    automationRunner: opts.automationRunner,
  }
}

/** ```coverage 块 design doc（老仓 coverage_block_status 解析格式） */
function coverageDoc(layers: Record<string, string>, touches = ''): string {
  const lines = Object.entries(layers).map(([k, v]) => `${k}: ${v}`)
  return ['# design', '', '```coverage', `touches: ${touches}`, ...lines, '```', ''].join('\n')
}

const ALL_FILLED = {
  L1_api: 'filled', L2_data: 'filled', L3_rules: 'filled', L4_state: 'filled',
  L5_errors: 'filled', L6_security: 'filled', L7_perf: 'filled', L8_deps: 'filled',
  L10_terms: 'filled',
}

/** open 相位全合规文件集（backend） */
function openFiles(): Record<string, string> {
  return {
    [`${CH}/.pipeline.yaml`]: 'track: backend\n',
    [`${CH}/proposal.md`]: '# proposal\n',
    [`${CH}/tasks.md`]: '- [ ] t1\n',
    [`${CH}/design.md`]: '# design\n',
  }
}

/** spec 相位全合规文件集（backend，coverage 全 filled） */
function specFiles(coverage: string = coverageDoc(ALL_FILLED)): Record<string, string> {
  return {
    [`${CH}/.pipeline.yaml`]: 'track: backend\n',
    [`${CH}/tasks.md`]: '- [ ] a\n- [x] b\n- [x] c\n',
    'docs/design.md': coverage,
    'docs/plan.md': '# plan\n',
  }
}

const fails = (r: { failures: string[] }, sub: string) => r.failures.filter((f) => f.includes(sub))

// ───────────────────────────────── open ─────────────────────────────────

describe('open 出口（O1-O5）', () => {
  const base = () => makeState({ phase: 'open', track: 'backend' })

  it('全合规 → pass 且无 warnings 键（lite 调用面 toEqual 兼容）', () => {
    expect(evaluateGuard(base(), ctxOf(openFiles()))).toEqual({ pass: true, failures: [] })
  })

  it('无 ctx → 文件类规则跳过（lite 纯字段面 pass）', () => {
    expect(evaluateGuard(base())).toEqual({ pass: true, failures: [] })
  })

  it('O1 状态文件缺失 → fail', () => {
    const files = openFiles()
    delete files[`${CH}/.pipeline.yaml`]
    const r = evaluateGuard(base(), ctxOf(files))
    expect(r.pass).toBe(false)
    expect(fails(r, '状态文件')).toHaveLength(1)
  })

  it('G1 canonical state existence 能力优先于 YAML projection 检查', () => {
    const files = openFiles()
    delete files[`${CH}/.pipeline.yaml`]
    const ctx = ctxOf(files)
    ctx.stateExists = () => true
    expect(evaluateGuard(base(), ctx)).toEqual({ pass: true, failures: [] })
    ctx.stateExists = () => false
    expect(fails(evaluateGuard(base(), ctx), '状态文件')).toHaveLength(1)
  })

  it('O2 proposal.md 缺失或为空 → fail', () => {
    const missing = openFiles()
    delete missing[`${CH}/proposal.md`]
    expect(fails(evaluateGuard(base(), ctxOf(missing)), 'proposal.md')).toHaveLength(1)
    const empty = openFiles()
    empty[`${CH}/proposal.md`] = ''
    expect(fails(evaluateGuard(base(), ctxOf(empty)), 'proposal.md')).toHaveLength(1)
  })

  it('O3+O4 tasks.md 缺失 → 「存在」与「至少 1 个任务」双 FAIL（老仓两条 check 各自计数）', () => {
    const files = openFiles()
    delete files[`${CH}/tasks.md`]
    const r = evaluateGuard(base(), ctxOf(files))
    expect(fails(r, 'tasks.md')).toHaveLength(2)
  })

  it('O4 任务行计数照老仓 regex ^- \\[[ x]\\]（大写 X 不算任务）', () => {
    const files = openFiles()
    files[`${CH}/tasks.md`] = '- [X] shouty\n'
    const r = evaluateGuard(base(), ctxOf(files))
    expect(fails(r, '至少 1 个任务')).toHaveLength(1)
    files[`${CH}/tasks.md`] = '- [x] done-counts-too\n'
    expect(evaluateGuard(base(), ctxOf(files)).pass).toBe(true)
  })

  it('O5 design.md：所有 default track（含 pm/未知）都要求，避免 OpenSpec 初始设计缺失', () => {
    const files = openFiles()
    delete files[`${CH}/design.md`]
    expect(fails(evaluateGuard(base(), ctxOf(files)), 'design.md')).toHaveLength(1)
    expect(fails(evaluateGuard(makeState({ phase: 'open', track: 'frontend' }), ctxOf(files)), 'design.md')).toHaveLength(1)
    expect(fails(evaluateGuard(makeState({ phase: 'open', track: 'pm' }), ctxOf(files)), 'design.md')).toHaveLength(1)
    expect(fails(evaluateGuard(makeState({ phase: 'open', track: '' }), ctxOf(files)), 'design.md')).toHaveLength(1)
  })
})

// ──────────────────────────────── explore ────────────────────────────────

describe('explore 出口（E1-E3）', () => {
  const files = () => ({
    [`${CH}/.pipeline.yaml`]: 'track: backend\n',
    'docs/design.md': '# d\n',
  })

  it('全合规 → pass', () => {
    const s = makeState({ phase: 'explore', track: 'backend', design_doc: 'docs/design.md' })
    expect(evaluateGuard(s, ctxOf(files()))).toEqual({ pass: true, failures: [] })
  })

  it('E2+E3 design_doc 字段空 → 非空与文件存在双 FAIL（老仓两条 check）', () => {
    const s = makeState({ phase: 'explore', track: 'backend' })
    const r = evaluateGuard(s, ctxOf(files()))
    expect(fails(r, 'design_doc')).toHaveLength(2)
  })

  it('E3 design_doc 指向缺失文件 → fail「指向的文件存在」', () => {
    const s = makeState({ phase: 'explore', track: 'backend', design_doc: 'docs/nope.md' })
    const r = evaluateGuard(s, ctxOf(files()))
    expect(fails(r, '指向的文件存在')).toHaveLength(1)
  })
})

// ───────────────────────────────── spec ─────────────────────────────────

describe('spec 出口（S1-S5）', () => {
  const be = (over: Partial<Record<FieldName, string | string[]>> = {}) =>
    makeState({ phase: 'spec', track: 'backend', preset: 'full', design_doc: 'docs/design.md', plan: 'docs/plan.md', ...over })

  it('backend full 全合规（plan + tasks≥3 + coverage 全 filled）→ pass', () => {
    expect(evaluateGuard(be(), ctxOf(specFiles()))).toEqual({ pass: true, failures: [] })
  })

  it('S3 plan 指向缺失文件 → 非 PM track fail；PM 保持 legacy state artifact 豁免', () => {
    const files = specFiles()
    delete files['docs/plan.md']
    expect(fails(evaluateGuard(be(), ctxOf(files)), '指向的文件存在')).toHaveLength(1)
    const pm = makeState({ phase: 'spec', track: 'pm', preset: 'full', design_doc: 'docs/design.md', plan: 'null' })
    const pmFiles = { [`${CH}/.pipeline.yaml`]: 'x', [`${CH}/tasks.md`]: '- [ ] a\n- [ ] b\n- [ ] c\n', 'docs/design.md': coverageDoc(ALL_FILLED) }
    expect(fails(evaluateGuard(pm, ctxOf(pmFiles)), 'plan')).toHaveLength(0)
  })

  it('S4 tasks.md 少于 3 个任务 → fail（全 track，含 pm）', () => {
    const files = specFiles()
    files[`${CH}/tasks.md`] = '- [ ] a\n- [x] b\n'
    const r = evaluateGuard(be(), ctxOf(files))
    expect(fails(r, '至少 3 个任务')).toHaveLength(1)
  })

  it('S5 backend full 无 coverage 块 → 7 层阻塞（L1/L2/L3/L4/L5/L6/L8 required）', () => {
    const r = evaluateGuard(be(), ctxOf(specFiles('# design 无覆盖块\n')))
    expect(fails(r, '全栈 Spec 覆盖（7 层阻塞）')).toHaveLength(1)
    expect((r.warnings ?? []).filter((w) => w.includes('覆盖阻塞')).length).toBe(7)
  })

  it('S5 coverageProfile 接管适用性：data+backend 按 backend 矩阵，backend+none 不检查', () => {
    const files = specFiles('# design 无覆盖块\n')
    const dynamicBackend = evaluateGuard(
      be({ track: 'data' }),
      { ...ctxOf(files), coverageProfile: 'backend' },
    )
    const builtinNone = evaluateGuard(
      be({ track: 'backend' }),
      { ...ctxOf(files), coverageProfile: 'none' },
    )
    expect([
      fails(dynamicBackend, '全栈 Spec 覆盖（7 层阻塞）').length,
      fails(builtinNone, '全栈 Spec 覆盖').length,
    ]).toEqual([1, 0])
  })

  it('S5 design_doc 字段空 → 同缺失文件，全 blank 照样阻塞', () => {
    const r = evaluateGuard(be({ design_doc: '' }), ctxOf(specFiles()))
    expect(fails(r, '全栈 Spec 覆盖（7 层阻塞）')).toHaveLength(1)
  })

  it('S5 required 层 waived 放行（waived ≠ blank）', () => {
    const cov = coverageDoc({ ...ALL_FILLED, L1_api: 'waived' })
    expect(evaluateGuard(be(), ctxOf(specFiles(cov))).pass).toBe(true)
  })

  it('S5 frontend：仅 L4_state/L5_errors required', () => {
    const fe = be({ track: 'frontend' })
    const blank = evaluateGuard(fe, ctxOf(specFiles(coverageDoc({})), { coverageProfile: 'frontend' }))
    expect(fails(blank, '全栈 Spec 覆盖（2 层阻塞）')).toHaveLength(1)
    const ok = coverageDoc({ L4_state: 'filled', L5_errors: 'filled' })
    expect(evaluateGuard(fe, ctxOf(specFiles(ok), { coverageProfile: 'frontend' })).pass).toBe(true)
  })

  it('S5 pm：仅 L3_rules required', () => {
    const pm = makeState({ phase: 'spec', track: 'pm', preset: 'full', design_doc: 'docs/design.md', plan: 'docs/plan.md' })
    const files = { [`${CH}/.pipeline.yaml`]: 'x', [`${CH}/tasks.md`]: '- [ ] a\n- [ ] b\n- [ ] c\n', 'docs/design.md': coverageDoc({}), 'docs/plan.md': '# plan\n' }
    const r = evaluateGuard(pm, ctxOf(files, { coverageProfile: 'pm' }))
    expect(fails(r, '全栈 Spec 覆盖（1 层阻塞）')).toHaveLength(1)
    files['docs/design.md'] = coverageDoc({ L3_rules: 'filled' })
    expect(evaluateGuard(pm, ctxOf(files, { coverageProfile: 'pm' })).pass).toBe(true)
  })

  it('S5 coverageProfile=none → 0 coverage 阻塞（chat 内建 policy；plan 仍按 P0 NON_PM 要求）', () => {
    const chat = makeState({ phase: 'spec', track: 'chat', preset: 'full', design_doc: 'docs/design.md', plan: 'docs/plan.md' })
    const files = { [`${CH}/.pipeline.yaml`]: 'x', [`${CH}/tasks.md`]: '- [ ] a\n- [ ] b\n- [ ] c\n', 'docs/design.md': '# 无覆盖块\n', 'docs/plan.md': '# plan\n' }
    expect(evaluateGuard(chat, ctxOf(files, { coverageProfile: 'none' })).pass).toBe(true)
  })

  it('S5 🔒 锁：touches 含 auth → L6_security 必须 filled，waived 也算 LOCKVIOLATION，hotfix 不豁免', () => {
    const cov = coverageDoc({ ...ALL_FILLED, L6_security: 'waived' }, 'auth')
    const full = evaluateGuard(be(), ctxOf(specFiles(cov)))
    expect(fails(full, '全栈 Spec 覆盖（1 层阻塞）')).toHaveLength(1)
    expect((full.warnings ?? []).some((w) => w.includes('LOCKVIOLATION'))).toBe(true)
    const hotfix = evaluateGuard(be({ preset: 'hotfix' }), ctxOf(specFiles(cov)))
    expect(fails(hotfix, '全栈 Spec 覆盖（1 层阻塞）')).toHaveLength(1)
  })

  it('S5 🔒 锁只锁非 na 层：pm 的 L6_security=na，touches auth 也不锁', () => {
    const pm = makeState({ phase: 'spec', track: 'pm', preset: 'full', design_doc: 'docs/design.md', plan: 'docs/plan.md' })
    const files = { [`${CH}/.pipeline.yaml`]: 'x', [`${CH}/tasks.md`]: '- [ ] a\n- [ ] b\n- [ ] c\n', 'docs/design.md': coverageDoc({ L3_rules: 'filled' }, 'auth'), 'docs/plan.md': '# plan\n' }
    expect(evaluateGuard(pm, ctxOf(files, { coverageProfile: 'pm' })).pass).toBe(true)
  })

  it('S5 preset=hotfix/tweak：required-blank 豁免为 WARN，不阻塞', () => {
    for (const preset of ['hotfix', 'tweak']) {
      const r = evaluateGuard(be({ preset }), ctxOf(specFiles('# 无覆盖块\n')))
      expect(fails(r, '全栈 Spec 覆盖')).toHaveLength(0)
      expect((r.warnings ?? []).some((w) => w.includes('已豁免'))).toBe(true)
    }
  })

  it('S5/S4 无 readFile 注入 → coverage 与 tasks 检查跳过', () => {
    const ctx = ctxOf(specFiles('# 无覆盖块\n'))
    delete ctx.readFile
    // tasks/coverage 需 readFile；plan 字段与文件、状态文件仍评估且满足
    expect(evaluateGuard(be(), ctx).pass).toBe(true)
  })
})

// ───────────────────────────────── build ─────────────────────────────────

describe('build 出口（GG3 + B1-B7；B9 build_sha 投影撤销）', () => {
  const buildFiles = (tasks = '- [x] a\n- [x] b\n- [x] c\n') => ({
    [`${CH}/.pipeline.yaml`]: 'track: backend\n',
    [`${CH}/tasks.md`]: tasks,
  })
  const be = (over: Partial<Record<FieldName, string | string[]>> = {}) =>
    makeState({
      phase: 'build',
      track: 'backend',
      preset: 'full',
      build_mode: 'worktree',
      isolation: 'worktree',
      pre_verify_review_result: 'pass',
      ...over,
    })

  it('B9 锚：全合规且 build_sha 为空 → pass（老仓 guard 出口不查 build_sha，SHA 由 build-complete 事件冻结）', () => {
    const r = evaluateGuard(be(), ctxOf(buildFiles()))
    expect(r).toEqual({ pass: true, failures: [] })
  })

  it('pre-Verify 全量收敛非 pass → Build 出口失败', () => {
    expect(fails(
      evaluateGuard(be({ pre_verify_review_result: 'pending' }), ctxOf(buildFiles())),
      'pre_verify_review_result=pass',
    )).toHaveLength(1)
  })

  it('B2 tasks.md 有未勾任务 → fail；文件缺失也 fail（老 tasks_all_done 语义）', () => {
    const r = evaluateGuard(be(), ctxOf(buildFiles('- [x] a\n- [ ] b\n')))
    expect(fails(r, '全部勾选')).toHaveLength(1)
    const files = buildFiles()
    delete files[`${CH}/tasks.md`]
    expect(fails(evaluateGuard(be(), ctxOf(files)), '全部勾选')).toHaveLength(1)
  })

  it('B2 七阶段 tasks.md 只要求截至 Build 的任务完成，Verify/Ship/Archive 待办不阻塞', () => {
    const tasks = `# Tasks

## Open
- [x] scope

## Build
- [x] implementation

## Verify
- [ ] acceptance

## Ship
- [ ] release

## Archive
- [ ] archive
`
    expect(evaluateGuard(be(), ctxOf(buildFiles(tasks)))).toEqual({ pass: true, failures: [] })
  })

  it('B2 受信 canonical TaskGroup 的 phase-like 标题不能把未完成项绕到未来 phase', () => {
    const root = mkdtempSync(join(tmpdir(), 'tenon-guard-task-plan-'))
    const revision: TaskPlanRevisionV1 = {
      schema_version: 'task-plan/v1',
      plan_id: 'plan-1',
      revision_id: 'revision-1',
      revision_number: 1,
      status: 'frozen',
      created_at: '2026-08-04T00:00:00.000Z',
      requirements: [],
      acceptance_criteria: [],
      groups: [{ id: 'group-1', title: 'Verify', parent_id: null, work_item_ids: ['work-1'] }],
      work_items: [{
        id: 'work-1',
        title: 'Finish Build implementation',
        group_id: 'group-1',
        requirement_refs: [],
        acceptance_refs: [],
        depends_on: [],
        resource_claims: [],
        expected_outputs: [],
        validators: [],
      }],
    }
    const tasksMarkdown = renderTaskPlanTasksMd(revision, { digest: 'sha256:current-revision' })
    const tasksPath = join(root, CH, 'tasks.md')
    mkdirSync(join(root, CH), { recursive: true })
    writeFileSync(tasksPath, tasksMarkdown, 'utf8')

    try {
      const readFile = (relPath: string) => readFileSync(join(root, relPath), 'utf8')
      const legacy = evaluateGuard(be(), {
        coverageProfile: 'backend',
        changeDirRel: CH,
        stateExists: () => true,
        readFile,
        canonicalTasksProjectionStatus: () => 'legacy',
      })
      expect(legacy.pass).toBe(true)

      const invalid = evaluateGuard(be(), {
        coverageProfile: 'backend',
        changeDirRel: CH,
        stateExists: () => true,
        readFile,
        canonicalTasksProjectionStatus: () => 'invalid',
      })
      expect(invalid.pass).toBe(false)
      expect(fails(invalid, 'canonical TaskPlan')).toHaveLength(1)

      const trustInputs: Array<{ changeDirRel: string; tasksMarkdown: string }> = []
      const ctx: GuardContext = {
        coverageProfile: 'backend',
        changeDirRel: CH,
        stateExists: () => true,
        readFile,
        canonicalTasksProjectionStatus: (input) => {
          trustInputs.push({ ...input })
          return input.changeDirRel === CH && input.tasksMarkdown === tasksMarkdown ? 'current' : 'invalid'
        },
      }

      const result = evaluateGuard(be(), ctx)
      expect(result.pass).toBe(false)
      expect(fails(result, '全部勾选')).toHaveLength(1)
      expect(trustInputs).toEqual([{ changeDirRel: CH, tasksMarkdown }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('B5 full+direct 要求 direct_override=true；tweak+direct 与 full+worktree 不查', () => {
    const bad = evaluateGuard(be({ build_mode: 'direct' }), ctxOf(buildFiles()))
    expect(fails(bad, 'direct_override')).toHaveLength(1)
    expect(evaluateGuard(be({ build_mode: 'direct', direct_override: 'true' }), ctxOf(buildFiles())).pass).toBe(true)
    expect(evaluateGuard(be({ preset: 'tweak', build_mode: 'direct' }), ctxOf(buildFiles())).pass).toBe(true)
    expect(evaluateGuard(be(), ctxOf(buildFiles())).pass).toBe(true)
  })

  it('B5 无 ctx 也评估（纯字段规则）', () => {
    const r = evaluateGuard(be({ build_mode: 'direct' }))
    expect(fails(r, 'direct_override')).toHaveLength(1)
  })

  it('B6 depends_on：活跃 → 必须先归档；无处可寻 → 不存在；已归档 → pass', () => {
    const active = evaluateGuard(
      be({ depends_on: ['dep-a'] }),
      ctxOf(buildFiles(), { activeDirs: ['openspec/changes/dep-a'] }),
    )
    expect(fails(active, "依赖 change 'dep-a' 必须先归档（当前活跃）")).toHaveLength(1)
    const gone = evaluateGuard(be({ depends_on: ['dep-c'] }), ctxOf(buildFiles()))
    expect(fails(gone, "依赖 change 'dep-c' 不存在（既不在活跃也不在归档）")).toHaveLength(1)
    const ok = evaluateGuard(be({ depends_on: ['dep-b'] }), ctxOf(buildFiles(), { archived: ['dep-b'] }))
    expect(ok.pass).toBe(true)
    const canonicallyArchivedInPlace = evaluateGuard(
      be({ depends_on: ['dep-b'] }),
      ctxOf(buildFiles(), {
        activeDirs: ['openspec/changes/dep-b'],
        archived: ['dep-b'],
        activeArchived: ['dep-b'],
      }),
    )
    expect(canonicallyArchivedInPlace.pass).toBe(true)
    const staleSameNameArchive = evaluateGuard(
      be({ depends_on: ['dep-b'] }),
      ctxOf(buildFiles(), {
        activeDirs: ['openspec/changes/dep-b'],
        archived: ['dep-b'],
      }),
    )
    expect(fails(staleSameNameArchive, "'dep-b' 必须先归档")).toHaveLength(1)
    const damagedActiveCanonical = evaluateGuard(
      be({ depends_on: ['dep-b'] }),
      ctxOf(buildFiles(), {
        activeDirs: ['openspec/changes/dep-b'],
        archived: ['dep-b'],
        activeArchived: [],
      }),
    )
    expect(fails(damagedActiveCanonical, "'dep-b' 必须先归档")).toHaveLength(1)
  })

  it('B6 老式逗号标量也认（"a, b" → 逐项 trim）；"null"/空跳过', () => {
    const r = evaluateGuard(
      be({ depends_on: 'dep-a, dep-b' as unknown as string }),
      ctxOf(buildFiles(), { activeDirs: ['openspec/changes/dep-a'], archived: ['dep-b'] }),
    )
    expect(fails(r, "'dep-a' 必须先归档")).toHaveLength(1)
    expect(fails(r, 'dep-b')).toHaveLength(0)
    expect(evaluateGuard(be({ depends_on: 'null' as unknown as string }), ctxOf(buildFiles())).pass).toBe(true)
  })

  it('B6 无 dirExists/changeArchived 注入 → depends_on 检查跳过', () => {
    const ctx = ctxOf(buildFiles())
    delete ctx.dirExists
    delete ctx.changeArchived
    expect(evaluateGuard(be({ depends_on: ['dep-a'] }), ctx).pass).toBe(true)
  })

  it('GG3 automation=queued → 拦下主线 build（无 ctx 也评估）；runner 旁路；off 放行', () => {
    const queued = be({ automation: 'queued' })
    expect(fails(evaluateGuard(queued), 'automation=queued')).toHaveLength(1)
    expect(fails(evaluateGuard(queued, ctxOf(buildFiles())), 'automation=queued')).toHaveLength(1)
    expect(evaluateGuard(queued, ctxOf(buildFiles(), { automationRunner: true })).pass).toBe(true)
    expect(evaluateGuard(be({ automation: 'off' }), ctxOf(buildFiles())).pass).toBe(true)
  })

  it('GG3 只在 build 相位生效（verify 阶段 automation=queued 不拦）', () => {
    const s = makeState({
      phase: 'verify', track: 'pm', automation: 'queued',
      verification_report: 'docs/v.md', branch_status: 'handled', verify_result: 'pass',
    })
    expect(evaluateGuard(s).pass).toBe(true)
  })
})

// ──────────────────────────────── verify ────────────────────────────────

describe('verify 出口（V3 + V7 pm-only 回对齐）', () => {
  const okFields = {
    phase: 'verify' as const,
    verification_report: 'docs/verify.md',
    branch_status: 'handled',
    agent_review_result: 'pass',
    codex_review_result: 'pass',
  }
  const files = () => ({ [`${CH}/.pipeline.yaml`]: 'x', 'docs/verify.md': '# report\n' })

  it('V7 锚：backend verify_result 为空 → pass（老仓 M246 tracks=pm，fe/be 由 verify-pass 事件落值）', () => {
    const r = evaluateGuard(makeState({ ...okFields, track: 'backend' }), ctxOf(files()))
    expect(r).toEqual({ pass: true, failures: [] })
  })

  it('V7 pm：verify_result 非 pass → fail', () => {
    const r = evaluateGuard(makeState({ ...okFields, track: 'pm' }), ctxOf(files()))
    expect(fails(r, 'verify_result')).toHaveLength(1)
    expect(evaluateGuard(makeState({ ...okFields, track: 'pm', verify_result: 'pass' }), ctxOf(files())).pass).toBe(true)
  })

  it('free：保留报告与 branch_status 门，但不继承工程 Track 双 review', () => {
    const r = evaluateGuard(
      makeState({
        ...okFields,
        track: 'free',
        agent_review_result: 'skipped',
        codex_review_result: 'skipped',
      }),
      ctxOf(files()),
    )
    expect(r).toEqual({ pass: true, failures: [] })
  })

  it('V3 verification_report 指向缺失文件 → fail「verification_report 文件存在」', () => {
    const s = makeState({ ...okFields, track: 'backend', verification_report: 'docs/nope.md' })
    const r = evaluateGuard(s, ctxOf(files()))
    expect(fails(r, 'verification_report 文件存在')).toHaveLength(1)
  })
})

// ──────────────────────────────── ship / archive ────────────────────────────────

describe('ship 出口（P3）与 archive 出口（A1）', () => {
  it('P3 pm：prd_path 文件缺失 → fail；存在 → pass；fe/be 不查 prd 文件', () => {
    const pm = makeState({ phase: 'ship', track: 'pm', prd_path: 'docs/prd.md' })
    const noFile = ctxOf({ [`${CH}/.pipeline.yaml`]: 'x' })
    expect(fails(evaluateGuard(pm, noFile), 'prd_path 文件存在')).toHaveLength(1)
    const withFile = ctxOf({ [`${CH}/.pipeline.yaml`]: 'x', 'docs/prd.md': '# prd\n' })
    expect(evaluateGuard(pm, withFile)).toEqual({ pass: true, failures: [] })
    const be = makeState({ phase: 'ship', track: 'backend', pr_url: 'https://x/pr/1' })
    expect(evaluateGuard(be, noFile).pass).toBe(true)
    const free = makeState({ phase: 'ship', track: 'free', pr_url: 'null' })
    expect(evaluateGuard(free, noFile).pass).toBe(true)
  })

  it('A1 archive：状态文件缺失 → fail；全合规 → pass', () => {
    const s = makeState({ phase: 'archive', verify_result: 'pass' })
    expect(evaluateGuard(s, ctxOf({})).pass).toBe(false)
    expect(evaluateGuard(s, ctxOf({ [`${CH}/.pipeline.yaml`]: 'x' }))).toEqual({ pass: true, failures: [] })
  })
})

// ──────────── advisory/enforcement 一致性矩阵（2026-07-17 P0 撕裂修复的验收）────────────
// 同一 track 问两层同一个问题：「plan / 双 review 是否被要求？」guard（tenon check/doctor
// 的 advisory 预览）与 transition（事件强制层）必须同判。修复前 guard 层用 tracks= 白名单，
// chat/未知 track 被豁免，而 transition 层按 !=pm 拒绝——本矩阵在那两格是红的；统一走
// workflow/predicates.ts 的 NON_PM 后全绿。legacy `plan` artifact 与双 review 都对 PM 豁免；
// PM 仍受独立 OpenSpec 文档账本的 plan 文档约束。

describe('一致性矩阵：guard 出口适用性 == transition 前置强制性（track ∈ pm/backend/frontend/chat/ml）', () => {
  const manifest = loadManifest(fileURLToPath(new URL('../../../../templates/manifest.yaml', import.meta.url)))
  const engine = createFlowEngine(manifest)
  const PLAN_MATRIX: readonly [string, boolean][] = [
    ['pm', false],       // 原流程：PM 不要求 legacy plan artifact
    ['backend', true],
    ['frontend', true],
    ['chat', true],      // 修复前 guard 层豁免（白名单外）→ 与 transition 层撕裂
    ['ml', true],        // 未知 track，同上
  ]

  const REVIEW_MATRIX: readonly [string, boolean][] = [
    ['pm', false],       // PM 走人工原型验收，不要求两条代码 review
    ['backend', true],
    ['frontend', true],
    ['chat', true],
    ['ml', true],
  ]

  it.each(PLAN_MATRIX)('track=%s：spec 的 plan 要求两层同判（required=%s）', async (track, required) => {
    // transition 强制层：spec-complete 前置校验（plan 未设 → 非豁免轨返回违反行）
    const violations = await checkDefaultEventPreconditions('spec-complete', makeState({ track }))
    const transitionRequires = violations !== null
    if (violations !== null) expect(violations[0]).toContain('要求 plan 字段非空')
    // guard 层：spec 出口 plan 非空是纯字段规则，lite（无 ctx）也评估——这就是 check/doctor 的 advisory 面
    const failures = engine.guardCheck(makeState({ phase: 'spec', track })).failures
    const guardRequires = failures.some((f) => f.includes('要求 plan 非空'))
    expect(guardRequires).toBe(transitionRequires)
    expect(transitionRequires).toBe(required)
  })

  it.each(REVIEW_MATRIX)('track=%s：verify 出口不再有手填评审字段（曾 required=%s）', async (track) => {
    // report/branch_status 给足，评审字段已删除：两层都不应再提它们。
    const fields = {
      verification_report: 'docs/v.md',
      branch_status: 'handled',
    } as const
    const trustedRevision = createBuildRevisionToken('git', 'a'.repeat(40), {
      repository: 'guard-test-repository',
      worktree: 'guard-test-worktree',
    })
    const violations = await checkDefaultEventPreconditions(
      'verify-pass',
      makeState({ ...fields, track }),
      { assessBuildRevision: async () => ({ trusted: true as const, token: trustedRevision }) },
    )
    expect(violations).toBeNull()
    const failures = engine.guardCheck(makeState({ ...fields, phase: 'verify', track })).failures
    expect(failures.some((f) => f.includes('review_result'))).toBe(false)
  })
})

// ──────────────────────────────── engine 透传 ────────────────────────────────

describe('FlowEngine.guardCheck 透传 GuardContext', () => {
  it('engine.guardCheck(state, ctx) 与 evaluateGuard(state, ctx) 同判', () => {
    const manifest = loadManifest(fileURLToPath(new URL('../../../../templates/manifest.yaml', import.meta.url)))
    const engine = createFlowEngine(manifest)
    const s = makeState({ phase: 'open', track: 'backend' })
    // 空文件系统注入 → open 的文件类规则全红
    const r = engine.guardCheck(s, ctxOf({}))
    expect(r.pass).toBe(false)
    expect(r.failures.length).toBeGreaterThanOrEqual(4)
    // 不带 ctx 仍是 lite 纯字段面
    expect(engine.guardCheck(s).pass).toBe(true)
  })
})
