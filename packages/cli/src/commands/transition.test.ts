import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  compileAutomationPolicySnapshot,
  createEffectiveSkillResolver,
  loadRegistry,
  IllegalTransitionError,
  loadManifest,
  TRANSITION_EVENTS,
  eventEdge as kernelEventEdge,
  createBuildRevisionToken,
  makeBuildRevisionBlocker,
  publishTaskPlanRevision,
} from '@tenon/kernel'
import type { Phase, PipelineState, TaskPlanRevisionV1, TransitionResult } from '@tenon/kernel'
import { cmdTransition } from './transition.js'
import { EVENTS, eventEdge } from '../events.js'
import { makeGuardCtx } from '../guardContext.js'
import { FIXED_CLOCK, makeDeps, mockState, spy } from '../test-support.js'

const TEST_REVISION_IDENTITY = { repository: '/repo.git', worktree: '/repo\\0/repo.git/worktrees/change' } as const
const TEST_BUILD_TOKEN = createBuildRevisionToken('git', 'a'.repeat(40), TEST_REVISION_IDENTITY)

function trustBuildRevision(deps: ReturnType<typeof makeDeps>): void {
  deps.captureBuildRevision = async () => TEST_BUILD_TOKEN.value
  deps.assessBuildRevision = async () => ({ trusted: true as const, token: TEST_BUILD_TOKEN })
}

function approvedReviewState(fields: Parameters<typeof mockState>[0]): PipelineState {
  const phase = String(fields.phase ?? 'explore')
  const event = fields.review_gate_event ?? (
    phase === 'explore' ? 'explore-complete'
      : phase === 'spec' ? 'spec-complete'
        : phase === 'verify' ? 'verify-pass'
          : ''
  )
  return mockState({
    ...fields,
    review_gate_phase: phase,
    review_gate_status: 'approved',
    review_gate_event: event,
    review_requested_at: FIXED_CLOCK,
    review_acknowledged_at: FIXED_CLOCK,
  })
}

/** 接线级：cli 真消费 kernel 单一真相源（BACKLOG #25b / GOAL B2）——events.ts 已无本地镜像，
 * 只是 kernel TRANSITION_EVENTS/eventEdge 的稳定别名（引用同一对象=同一真相源）。 */
describe('接线 —— cli 事件表 = kernel 单源（无本地镜像）', () => {
  test('EVENTS 就是 kernel TRANSITION_EVENTS（引用同一对象）', () => {
    expect(EVENTS).toBe(TRANSITION_EVENTS)
  })
  test('eventEdge 就是 kernel eventEdge（同一函数）', () => {
    expect(eventEdge).toBe(kernelEventEdge)
  })
})

describe('transition —— [TRANSITION] 走 stderr / 非法 exit 1（oracle 实测回写）', () => {
  test('free/matrix=false 仍拒绝缺失当前 visit 的 frozen phase Skill', async () => {
    const manifestPath = join(process.cwd(), 'templates', 'manifest.yaml')
    const deps = makeDeps({
      state: mockState({ phase: 'open', track: 'free' }),
      resolver: createEffectiveSkillResolver(loadManifest(manifestPath)),
    })
    const code = await cmdTransition(deps, 'demo', 'open-complete')
    expect(code).toBe(2)
    expect(deps.errLines.join('\n')).toContain('tenon-open')
    expect(deps.store.write.calls).toHaveLength(0)
  })

  test('合法转换：stdout 无输出，[TRANSITION] 走 stderr，exit 0', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'open' }) })
    const code = await cmdTransition(deps, 'demo', 'open-complete')
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([])
    expect(deps.errLines).toContain('[TRANSITION] demo: open -> explore')
  })

  test('无 interaction projection port 时，unbound approved receipt 仍拒绝 canonical transition', async () => {
    const deps = makeDeps({ state: approvedReviewState({ phase: 'explore', design_doc: 'docs/d.md' }) })
    deps.interaction = undefined
    Reflect.deleteProperty(deps, 'reviewGateBinding')
    deps.guardCtx = (name) => ({
      changeDirRel: `openspec/changes/${name}`,
      fileExists: () => true,
      fileNonempty: () => true,
      readFile: () => undefined,
      dirExists: () => false,
      changeArchived: () => false,
      automationRunner: false,
    })
    expect(await cmdTransition(deps, 'demo', 'explore-complete')).toBe(2)
    expect(deps.store.write.calls).toHaveLength(0)
  })

  test('事件映射目标相位并透传注入时钟给 flow.transition', async () => {
    // PM 保持原流程的 legacy plan artifact 豁免；本测只关注边映射。
    const deps = makeDeps({ state: approvedReviewState({ phase: 'spec', track: 'pm', plan: 'null' }) })
    await cmdTransition(deps, 'demo', 'spec-complete')
    const call = deps.flow.transition.calls[0]
    expect(call?.[1]).toBe('build')
    expect(call?.[2]).toBe(deps.clock)
  })

  test('新状态经 store.write 落盘，且整体在 withLock 内', async () => {
    const deps = makeDeps({ state: mockState({
      phase: 'build',
      build_mode: 'direct',
      isolation: 'worktree',
      pre_verify_review_result: 'pass',
    }) })
    trustBuildRevision(deps)
    await cmdTransition(deps, 'demo', 'build-complete')
    expect(deps.store.withLock.calls).toHaveLength(1)
    expect(deps.store.write.calls).toHaveLength(1)
    const written = deps.store.write.calls[0]?.[1] as PipelineState
    expect(written.fields.phase).toBe('verify')
    expect(written.fields.build_sha).toBe(TEST_BUILD_TOKEN.value)
  })

  test('生产 guardContext 会在 transition 锁内重验未完成 tasks 并阻止提交', async () => {
    const root = await mkdtemp(join(tmpdir(), 'transition-task-gate-'))
    const dir = join(root, 'openspec', 'changes', 'demo')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'tasks.md'), '# Tasks\n\n## Build\n\n- [ ] Finish implementation\n', 'utf8')
    const deps = makeDeps({
      cwd: root,
      state: mockState({ phase: 'build', build_mode: 'direct', isolation: 'worktree', pre_verify_review_result: 'pass' }),
      guardCtx: makeGuardCtx(root),
    })
    try {
      expect(await cmdTransition(deps, 'demo', 'build-complete')).toBe(1)
      expect(deps.errLines).toContain('build 出口：tasks.md 仍有 1 项未勾')
      expect(deps.store.write.calls).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('verify-pass 在 transition 锁内拒绝 canonical current 的缺失 tasks projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'transition-missing-canonical-projection-'))
    const dir = join(root, 'openspec', 'changes', 'demo')
    await mkdir(dir, { recursive: true })
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
    await publishTaskPlanRevision(dir, revision, { expected_current_revision_id: null })
    await rm(join(dir, 'tasks.md'))
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'v.md'), '# Verify\n', 'utf8')
    const deps = makeDeps({
      cwd: root,
      state: approvedReviewState({
        phase: 'verify',
        track: 'backend',
        verification_report: 'docs/v.md',
        branch_status: 'handled',
        agent_review_result: 'pass',
        codex_review_result: 'pass',
        build_sha: 'null',
      }),
      guardCtx: makeGuardCtx(root),
    })

    try {
      expect(await cmdTransition(deps, 'demo', 'verify-pass')).toBe(1)
      expect(deps.errLines.join('\n')).toContain('verify-build-revision-untrusted reason=null')
      expect(deps.store.write.calls).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('verify-fail 回退边：verify -> build（stderr），且 build_sha 清 null', async () => {
    const deps = makeDeps({ state: approvedReviewState({ phase: 'verify', review_gate_event: 'verify-fail' }) })
    const code = await cmdTransition(deps, 'demo', 'verify-fail')
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([])
    expect(deps.errLines).toContain('[TRANSITION] demo: verify -> build')
  })

  test('生产 guardContext 不用未完成 Verify tasks 阻断 verify-fail 回退', async () => {
    const root = await mkdtemp(join(tmpdir(), 'transition-verify-fail-task-gate-'))
    const dir = join(root, 'openspec', 'changes', 'demo')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'tasks.md'), '# Tasks\n\n## Verify\n\n- [ ] Reproduce failure\n', 'utf8')
    const deps = makeDeps({
      cwd: root,
      state: approvedReviewState({
        phase: 'verify', build_sha: 'FROZEN', review_gate_event: 'verify-fail',
      }),
      guardCtx: makeGuardCtx(root),
    })
    try {
      expect(await cmdTransition(deps, 'demo', 'verify-fail')).toBe(0)
      expect(deps.errLines).toContain('[TRANSITION] demo: verify -> build')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('archived 终态自环：archive -> archive（stderr）', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'archive' }) })
    const code = await cmdTransition(deps, 'demo', 'archived')
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([])
    expect(deps.errLines).toContain('[TRANSITION] demo: archive -> archive')
  })

  test('当前 phase 与事件 from 不符：exit 1（老内核口径），flow 不被调用、不写盘', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'open' }) })
    const code = await cmdTransition(deps, 'demo', 'verify-pass')
    expect(code).toBe(1)
    expect(deps.outLines).toEqual([])
    expect(deps.flow.transition.calls).toHaveLength(0)
    expect(deps.store.write.calls).toHaveLength(0)
  })

  test('flow 抛 IllegalTransitionError：exit 1，无 stdout（标题此前误写 exit 2 与断言不符——' +
    'exit 2 是 step guard 未通过专属，第 1 轮 TransitionApplication review 点名的既有标题失真）', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'verify' }) })
    deps.flow.transition = spy((_s: PipelineState, _to: Phase, _c?: () => string): TransitionResult => {
      throw new IllegalTransitionError('verify', 'ship')
    })
    const code = await cmdTransition(deps, 'demo', 'verify-pass')
    expect(code).toBe(1)
    expect(deps.outLines).toEqual([])
    expect(deps.store.write.calls).toHaveLength(0)
  })

  test('未知 event（default workflow）：exit 1（老内核口径）+ 同一句 stderr + 零写盘', async () => {
    const deps = makeDeps()
    const code = await cmdTransition(deps, 'demo', 'warp-speed')
    expect(code).toBe(1)
    // Task 8：判定 default vs 自定义 workflow 必须先读一次 state（未知 event 才能被断定为「对
    // default workflow 非法」——对自定义 workflow 任意 event 名都可能合法），故 read 计数 0→1。
    // 真实可观测行为不变：exit 1 + 逐字同一句 "ERROR: 未知 event" + 绝不写盘（下面两条守住）。
    expect(deps.store.read.calls).toHaveLength(1)
    expect(deps.store.write.calls).toHaveLength(0)
    expect(deps.errLines).toContain('ERROR: 未知 event: warp-speed')
  })

  test('状态文件缺失（read 抛错）：exit 1', async () => {
    const deps = makeDeps()
    deps.store.read = spy(async (_d: string): Promise<PipelineState> => {
      throw new Error('ENOENT')
    })
    const code = await cmdTransition(deps, 'demo', 'open-complete')
    expect(code).toBe(1)
  })

  test('成功后写 breadcrumb 缓存（CONTRACT §5.4）', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'open' }) })
    await cmdTransition(deps, 'demo', 'open-complete')
    expect(deps.breadcrumbs).toHaveLength(1)
    expect(deps.breadcrumbs[0]?.[0]).toBe('/repo/openspec/changes/demo')
    expect(deps.breadcrumbs[0]?.[1]).toContain('explore')
  })

  test('成功后 append 一条 transition 历史，raw=事件名（老仓 transitions_history.event 对位），' +
    'transitionRecordId=tx.commit() 真实返回的 record.id（W1 第二增量：history 合并边界从时间戳 ' +
    '比较改成来源标记，收尾必须用 kernel transitionRecordToHistoryEntry() 而非手填字段）', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'open' }) })
    await cmdTransition(deps, 'demo', 'open-complete')
    // mockWorkflowRunRepository.commit() 按 `mock-record-${sequence}` 生成 id（test-support.ts），
    // sequence 在每个 makeDeps() 新建的 repo 实例里从 0 起数；本测唯一一次 cmdTransition = 唯一
    // 一次 commit，sequence 落 1，故这里的 'mock-record-1' 是可预测的真实返回值，不是猜的——
    // 逐值比较（而非仅断言非空字符串）能守住「history 里的 id 确实来自 tx.commit() 返回值」
    // 这条不变式，若实现改回手填字符串常量也会被这个精确值拆穿。
    expect(deps.historyEntries).toEqual([
      [
        '/repo/openspec/changes/demo',
        {
          ts: FIXED_CLOCK, kind: 'transition', from: 'open', to: 'explore', raw: 'open-complete',
          transitionRecordId: 'mock-record-1',
        },
      ],
    ])
  })

  test('transition 收尾顺序 = breadcrumb → history；review projection 只能由 review request 写入', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'open' }) })
    await cmdTransition(deps, 'demo', 'open-complete')
    expect(deps.tailCallOrder).toEqual(['breadcrumb', 'history'])
  })

  test('breadcrumb 写失败仅 WARN，不影响 exit 0', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'open' }) })
    deps.writeBreadcrumb = async () => {
      throw new Error('EACCES')
    }
    const code = await cmdTransition(deps, 'demo', 'open-complete')
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([])
    expect(deps.errLines.join('\n')).toContain('WARN')
  })

  test('state YAML projection 写失败仅 WARN：canonical transition 已成功，exit 仍为 0', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'open' }) })
    deps.store.write = spy(async () => ({
      projection: { status: 'pending' as const, error: new Error('disk full') },
    }))
    const code = await cmdTransition(deps, 'demo', 'open-complete')
    expect(code).toBe(0)
    expect(deps.errLines.join('\n')).toContain('state YAML projection 写入失败（canonical 已提交）')
  })

  test('breadcrumb 写抛出 falsy 值（如 throw null）仍算失败、仍输出 WARN（G1 REFACTOR 第三轮 ' +
    'codex review 抓到：{error?:unknown} + truthy 判断会把 falsy 抛出值误判成成功、静默吞掉 ' +
    'WARN——TailWriteOutcome 改判别联合后用 ok 字段判定，不受 error 值本身是否 falsy 影响）', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'open' }) })
    deps.writeBreadcrumb = async () => { throw null }
    const code = await cmdTransition(deps, 'demo', 'open-complete')
    expect(code).toBe(0)
    expect(deps.errLines.join('\n')).toContain('WARN: breadcrumb 写入失败')
  })

  test('进入 review phase 不调用 review marker writer（由 review request 专职写入）', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'open' }) })
    let called = false
    deps.writeReviewMarker = async () => { called = true; throw '' }
    const code = await cmdTransition(deps, 'demo', 'open-complete')
    expect(code).toBe(0)
    expect(called).toBe(false)
  })

  test('非法 change 名：exit 1', async () => {
    const deps = makeDeps()
    const code = await cmdTransition(deps, 'bad name', 'open-complete')
    expect(code).toBe(1)
  })
})

/** 老仓 state-transition.sh case 块的事件前置校验（BACKLOG #14）——mock 快速回归。
 * 文件存在性走 deps.guardCtx 注入（缺省未注入 = lite 降级跳过文件面，字段面仍全量）。 */
describe('transition —— 事件前置校验（老仓 case 块，exit 1 + ERROR 走 stderr + 不写盘）', () => {
  const ctxAllFiles = (exists: boolean) => (name: string) => ({
    changeDirRel: `openspec/changes/${name}`,
    fileExists: () => exists,
    fileNonempty: () => exists,
    readFile: () => undefined,
    dirExists: () => false,
    changeArchived: () => false,
    automationRunner: false,
  })

  test('explore-complete：design_doc 字面 null → exit 1，不写盘（老仓 L120-126）', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'explore', design_doc: 'null' }) })
    expect(await cmdTransition(deps, 'demo', 'explore-complete')).toBe(1)
    expect(deps.errLines).toContain('ERROR: explore-complete 要求 design_doc 字段非空且文件存在 (当前=null)')
    expect(deps.store.write.calls).toHaveLength(0)
  })

  test('explore-complete：design_doc 文件不存在（guardCtx 注入 false）→ exit 1', async () => {
    const deps = makeDeps({
      state: approvedReviewState({ phase: 'explore', design_doc: 'docs/d.md' }),
      guardCtx: ctxAllFiles(false),
    })
    expect(await cmdTransition(deps, 'demo', 'explore-complete')).toBe(1)
    expect(deps.errLines).toContain('ERROR: explore-complete 要求 design_doc 字段非空且文件存在 (当前=docs/d.md)')
  })

  test('explore-complete：design_doc 存在 → exit 0', async () => {
    const deps = makeDeps({
      state: approvedReviewState({ phase: 'explore', design_doc: 'docs/d.md' }),
      guardCtx: ctxAllFiles(true),
    })
    expect(await cmdTransition(deps, 'demo', 'explore-complete')).toBe(0)
  })

  test('spec-complete：backend 无 plan 拒绝；PM 保持原流程豁免并可推进', async () => {
    const be = makeDeps({ state: mockState({ phase: 'spec', track: 'backend', plan: 'null' }) })
    expect(await cmdTransition(be, 'demo', 'spec-complete')).toBe(1)
    expect(be.errLines).toContain('ERROR: backend track spec-complete 要求 plan 字段非空且文件存在 (当前=null)')
    const pmMissing = makeDeps({ state: approvedReviewState({ phase: 'spec', track: 'pm', plan: 'null' }) })
    expect(await cmdTransition(pmMissing, 'demo', 'spec-complete')).toBe(0)
  })

  test('build-complete：build_mode/isolation 未设逐个拒（老仓 L144-147）', async () => {
    const noBm = makeDeps({ state: mockState({ phase: 'build' }) })
    expect(await cmdTransition(noBm, 'demo', 'build-complete')).toBe(1)
    expect(noBm.errLines).toContain('ERROR: build_mode 必须设置')
    const noIso = makeDeps({ state: mockState({ phase: 'build', build_mode: 'direct', isolation: 'null' }) })
    expect(await cmdTransition(noIso, 'demo', 'build-complete')).toBe(1)
    expect(noIso.errLines).toContain('ERROR: isolation 必须设置')
  })

  test('build-complete：isolation 非法枚举防线（保留受限 agent 的 in-place 扩展）', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'build', build_mode: 'direct', isolation: 'bogus' }) })
    expect(await cmdTransition(deps, 'demo', 'build-complete')).toBe(1)
    expect(deps.errLines).toContain("ERROR: 非法值 'bogus'，允许: branch worktree in-place")
  })

  test('build-complete：full+direct 必须 direct_override=true（老仓 L150-153）', async () => {
    const deps = makeDeps({
      state: mockState({ phase: 'build', preset: 'full', build_mode: 'direct', isolation: 'worktree' }),
    })
    expect(await cmdTransition(deps, 'demo', 'build-complete')).toBe(1)
    expect(deps.errLines).toContain('ERROR: full workflow 使用 build_mode=direct 必须显式设 direct_override=true')
    expect(deps.store.write.calls).toHaveLength(0)
  })

  test('verify-pass：report → branch_status → agent → codex 首错优先序（老仓 L167-190）', async () => {
    const base = {
      phase: 'verify' as const,
      track: 'backend',
      verification_report: 'docs/v.md',
      branch_status: 'pending',
      agent_review_result: 'pending',
      codex_review_result: 'pending',
    }
    const noVr = makeDeps({ state: mockState({ ...base, verification_report: 'null' }), guardCtx: ctxAllFiles(true) })
    expect(await cmdTransition(noVr, 'demo', 'verify-pass')).toBe(1)
    expect(noVr.errLines).toContain('ERROR: verify-pass 要求 verification_report 字段非空且文件存在 (当前=null)')
    const noBs = makeDeps({ state: mockState(base), guardCtx: ctxAllFiles(true) })
    expect(await cmdTransition(noBs, 'demo', 'verify-pass')).toBe(1)
    expect(noBs.errLines).toContain('ERROR: verify-pass 要求 branch_status=handled (当前=pending)')
    const noAr = makeDeps({ state: mockState({ ...base, branch_status: 'handled' }), guardCtx: ctxAllFiles(true) })
    expect(await cmdTransition(noAr, 'demo', 'verify-pass')).toBe(1)
    expect(noAr.errLines).toContain('ERROR: backend track 要求 agent_review_result=pass (当前=pending)')
    const noCr = makeDeps({
      state: mockState({ ...base, branch_status: 'handled', agent_review_result: 'pass' }),
      guardCtx: ctxAllFiles(true),
    })
    expect(await cmdTransition(noCr, 'demo', 'verify-pass')).toBe(1)
    expect(noCr.errLines).toContain('ERROR: backend track 要求 codex_review_result=pass (当前=pending)')
  })

  test('verify-pass：pm track 豁免双 review（skipped 通过，老仓 L180 分支）', async () => {
    const deps = makeDeps({
      state: approvedReviewState({
        phase: 'verify',
        track: 'pm',
        verification_report: 'docs/v.md',
        branch_status: 'handled',
        agent_review_result: 'skipped',
        codex_review_result: 'skipped',
        isolation: 'branch',
        build_sha: TEST_BUILD_TOKEN.value,
      }),
      guardCtx: ctxAllFiles(true),
    })
    trustBuildRevision(deps)
    expect(await cmdTransition(deps, 'demo', 'verify-pass')).toBe(0)
    const written = deps.store.write.calls[0]?.[1] as PipelineState
    expect(written.fields.verify_result).toBe('pass')
    expect(written.fields.verified_at).toBe(FIXED_CLOCK)
  })

  test('verify-pass barrier：revision stale 拒绝并输出 stable blocker', async () => {
    const deps = makeDeps({
      state: mockState({
        phase: 'verify',
        track: 'pm',
        verification_report: 'docs/v.md',
        branch_status: 'handled',
        isolation: 'branch',
        build_sha: TEST_BUILD_TOKEN.value,
      }),
      guardCtx: ctxAllFiles(true),
    })
    trustBuildRevision(deps)
    deps.assessBuildRevision = async () => ({ trusted: false as const, blocker: makeBuildRevisionBlocker('revision-stale') })
    expect(await cmdTransition(deps, 'demo', 'verify-pass')).toBe(1)
    expect(deps.errLines.join('\n')).toContain('verify-build-revision-untrusted reason=revision-stale remediation=return-to-build-and-capture-current-revision')
    expect(deps.store.write.calls).toHaveLength(0)
  })

  test('verify-pass barrier 退化：build_sha=null 或 legacy SHA → stable blocker，不跳过校验', async () => {
    const nullSha = makeDeps({
      state: approvedReviewState({
        phase: 'verify', track: 'pm', verification_report: 'docs/v.md',
        branch_status: 'handled', build_sha: 'null',
      }),
      guardCtx: ctxAllFiles(true),
    })
    nullSha.assessBuildRevision = async () => ({ trusted: false as const, blocker: makeBuildRevisionBlocker('null') })
    nullSha.gitHeadSha = async () => 'DEADBEEF'
    expect(await cmdTransition(nullSha, 'demo', 'verify-pass')).toBe(1)
    expect(nullSha.errLines.join('\n')).toContain('verify-build-revision-untrusted reason=null')
    const noHead = makeDeps({
      state: approvedReviewState({
        phase: 'verify', track: 'pm', verification_report: 'docs/v.md',
        branch_status: 'handled', build_sha: 'CAFEBABE',
      }),
      guardCtx: ctxAllFiles(true),
    })
    noHead.assessBuildRevision = async () => ({ trusted: false as const, blocker: makeBuildRevisionBlocker('malformed') })
    noHead.gitHeadSha = async () => ''
    expect(await cmdTransition(noHead, 'demo', 'verify-pass')).toBe(1)
    expect(noHead.errLines.join('\n')).toContain('verify-build-revision-untrusted reason=malformed')
  })

  test('verify-fail：无前置校验，verify_result=fail + build_sha=null 落写（老仓 L206-211）', async () => {
    const deps = makeDeps({ state: approvedReviewState({
      phase: 'verify', build_sha: 'DEADBEEF', review_gate_event: 'verify-fail',
    }) })
    expect(await cmdTransition(deps, 'demo', 'verify-fail')).toBe(0)
    const written = deps.store.write.calls[0]?.[1] as PipelineState
    expect(written.fields.verify_result).toBe('fail')
    expect(written.fields.build_sha).toBe('null')
  })

  test('archived：archived=true + archived_at 落写（老仓 L212-218）', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'archive' }) })
    expect(await cmdTransition(deps, 'demo', 'archived')).toBe(0)
    const written = deps.store.write.calls[0]?.[1] as PipelineState
    expect(written.fields.archived).toBe('true')
    expect(written.fields.archived_at).toBe(FIXED_CLOCK)
  })
})

/** Task 8 —— mockState 默认 workflow + 非 default workflow 的分支路由（mock 快测；真 step 间转换的
 *  端到端证据在 transition-custom-workflow.integration.test.ts 用真 harness 落实）。 */
describe('transition —— Task 8 双轨分支路由（mock 快测）', () => {
  test('mockState() 缺省 workflow=default（镜像 kernel emptyFields，守住 28 例默认路径不误入自定义分支）', () => {
    expect(mockState().fields.workflow).toBe('default')
    expect(mockState({ phase: 'open' }).fields.workflow).toBe('default')
  })

  test('workflow!=default 且 workflow 文件缺失：真路由到自定义分支并报 "未找到"（exit 1，不写盘）', async () => {
    // workflow=ghost 使 str(workflow)||'default' === 'ghost' → 走自定义分支；cwd=/repo 下无
    // .pipeline/workflows/ghost.yaml → loadWorkflow 返回 null → WorkflowError（真代码路径，非 mock 桩返回值）。
    const deps = makeDeps({ state: mockState({ phase: 's1', workflow: 'ghost' }) })
    const code = await cmdTransition(deps, 'demo', 'complete')
    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toContain("workflow 'ghost' 未找到")
    expect(deps.store.write.calls).toHaveLength(0)
  })
})

/** W1 第二增量收尾：非 default workflow 分支同样必须把 tx.commit() 返回的 record 经
 *  transitionRecordToHistoryEntry() 投影进 history，不能像 default 分支曾经那样各自手填。
 *  非 default 分支的成功转换需要 kernel loadWorkflow() 真读 <cwd>/.pipeline/workflows/<name>.yaml
 *  （existsSync/readFileSync，硬 fs 依赖，不受本文件其余 mock 影响）——本文件按约定是 mock 单测
 *  （对照 transition-custom-workflow.integration.test.ts 文件头注释），不引入 integration-harness.ts
 *  那套真实项目 harness，只为这一处硬依赖临时开一个 mkdtemp 目录、落一份最小 workflow 定义，
 *  其余（store/runRepo/history）仍全 mock——不新增被禁止触碰的文件、也不把本文件整体改造成
 *  真 e2e。 */
describe('transition —— 非 default workflow 分支的 transitionRecordId（W1 第二增量）', () => {
  const TWO_STEP_WF = `name: twostep
steps:
  - id: s1
    label: step-one
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: complete
        to: s2
  - id: s2
    label: step-two
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

  test('非 default workflow 成功转换：history 也携带 tx.commit() 真实返回的 record.id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'transition-record-id-'))
    try {
      await mkdir(join(cwd, '.pipeline', 'workflows'), { recursive: true })
      await writeFile(join(cwd, '.pipeline', 'workflows', 'twostep.yaml'), TWO_STEP_WF, 'utf8')
      const deps = makeDeps({ cwd, state: mockState({ phase: 's1', workflow: 'twostep' }) })
      const code = await cmdTransition(deps, 'demo', 'complete')
      expect(code).toBe(0)
      // 同上：本测唯一一次 cmdTransition = mockWorkflowRunRepository 唯一一次 commit，
      // sequence 落 1 → record.id 可预测地等于 'mock-record-1'，逐值比较而非仅断言格式。
      expect(deps.historyEntries).toEqual([
        [
          join(cwd, 'openspec', 'changes', 'demo'),
          {
            ts: FIXED_CLOCK, kind: 'transition', from: 's1', to: 's2', raw: 'complete',
            transitionRecordId: 'mock-record-1',
          },
        ],
      ])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

/** Loop human gate: TENON_AFK is a mode signal that must deny; unset allows (same-OS-user limitation). */
describe('transition —— loop human gate（TENON_AFK 模式信号）', () => {
  const LOOPS_YAML = `version: 1
loops:
  - id: gate-loop
    name: gate loop
    kind: executor
    goal: advance governed changes behind human gates
    cadence: 1h
    risk: low
    runner: codex
    change_prefix: gate-
    phases:
      - decide
      - record
    human_gates:
      - explore
    design_doc: docs/loops/gate-loop.md
    status: active
    budget:
      max_runs_per_day: 1
      max_in_flight: 1
      on_exceed: skip
    kill_criteria:
      - never
    skill_bundle_id: backend
`

  async function governedDeps(cwd: string, afk: string | undefined) {
    await mkdir(join(cwd, '.pipeline'), { recursive: true })
    await writeFile(join(cwd, '.pipeline', 'loops.yaml'), LOOPS_YAML, 'utf8')
    const loop = loadRegistry(cwd).data?.loops.find((candidate) => candidate.id === 'gate-loop')
    if (loop === undefined) throw new Error('gate-loop fixture failed to load')
    const policy = compileAutomationPolicySnapshot(loop, { capturedAt: FIXED_CLOCK })
    const deps = makeDeps({ cwd, state: mockState({ phase: 'open' }) })
    deps.env = (name) => (name === 'TENON_AFK' ? afk : undefined)
    await deps.runRepo.bindAutomationPolicy(join(cwd, 'openspec', 'changes', 'demo'), policy)
    return deps
  }

  test('TENON_AFK=1 → gated target denied, exit 1, zero writes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'transition-human-gate-afk-'))
    try {
      const deps = await governedDeps(cwd, '1')
      expect(await cmdTransition(deps, 'demo', 'open-complete')).toBe(1)
      expect(deps.errLines).toContain('ERROR: automation constraint denied transition: human-gate-required')
      expect(deps.store.write.calls).toHaveLength(0)
      expect(deps.historyEntries).toEqual([])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('TENON_AFK unset → gated target allowed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'transition-human-gate-hitl-'))
    try {
      const deps = await governedDeps(cwd, undefined)
      expect(await cmdTransition(deps, 'demo', 'open-complete')).toBe(0)
      expect(deps.errLines).toContain('[TRANSITION] demo: open -> explore')
      expect(deps.store.write.calls).toHaveLength(1)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
