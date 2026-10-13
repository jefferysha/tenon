/**
 * guard handler 单测（G2 P1）——核心验收：新 handler 对旧 switch 全部分支语义等价。
 * 「旧 switch 语义对照」各 describe 的期望值**手写自旧代码阅读**（行号 = flow/transition-table.ts
 * 与 workflow/stepGuard.ts 的当前行），刻意不 import 旧函数当 oracle——old/new 双跑对照
 * 属于生产接线层的验收面，不属于本层。
 * 每个用例名标注对应旧行号出处。
 */
import { describe, expect, it, vi } from 'vitest'
import type { FieldName } from '../types.js'
import type { CompiledGuardConfig, GuardInput } from './ir.js'
import { evaluateGuards, GUARD_HANDLERS } from './guard-handlers.js'
import { NON_PM } from './predicates.js'
import { allFields } from './test-support.js'
import { assessBuildRevisionTrust, createBuildRevisionToken } from './build-revision.js'

const REVISION_IDENTITY = { repository: '/repo.git', worktree: '/repo\\0/repo.git/worktrees/change' } as const
const REVISION = 'a'.repeat(40)
const REVISION_TOKEN = createBuildRevisionToken('git', REVISION, REVISION_IDENTITY)

const assessTrustedRevision: NonNullable<GuardInput['assessBuildRevision']> = async (request) => assessBuildRevisionTrust({
  ...request,
  observe: async () => ({ kind: 'git' as const, revision: REVISION, identity: REVISION_IDENTITY }),
  provenance: async () => ({
    currentStep: 'verify', stateHash: request.stateHash, stateBuildSha: REVISION_TOKEN.value,
    recordTo: 'verify', buildShaEffects: [REVISION_TOKEN.value],
  }),
})

function makeInput(
  over: Partial<Record<FieldName, string | string[]>> = {},
  caps: Partial<Pick<
    GuardInput,
    | 'track' | 'change' | 'fileExists' | 'readText' | 'gitHeadSha' | 'workspaceFingerprint' | 'specMigrationStatus'
    | 'assessBuildRevision' | 'currentStep' | 'tasksThroughStep' | 'afkQueued' | 'dependencyStates' | 'requiredOutput'
  >> = {},
): GuardInput {
  return {
    fields: allFields(over),
    track: caps.track ?? 'backend',
    change: caps.change,
    fileExists: caps.fileExists,
    readText: caps.readText,
    gitHeadSha: caps.gitHeadSha,
    workspaceFingerprint: caps.workspaceFingerprint,
    specMigrationStatus: caps.specMigrationStatus,
    assessBuildRevision: caps.assessBuildRevision,
    currentStep: caps.currentStep ?? 'verify',
    tasksThroughStep: caps.tasksThroughStep,
    afkQueued: caps.afkQueued,
    dependencyStates: caps.dependencyStates,
    requiredOutput: caps.requiredOutput,
  }
}

// ── 旧事件 → 基础 guard 组合（默认 workflow 语义在 IR 下的形状，测试本地构造）──────────
const EXPLORE_DOC_SET: CompiledGuardConfig = { type: 'field-nonempty', field: 'design_doc' }
const EXPLORE_DOC_FILE: CompiledGuardConfig = { type: 'file-exists', path: { kind: 'field', field: 'design_doc' } }
const EXPLORE_EXIT: readonly CompiledGuardConfig[] = [EXPLORE_DOC_SET, EXPLORE_DOC_FILE]

const SPEC_PLAN_SET: CompiledGuardConfig = { type: 'field-nonempty', field: 'plan', when: NON_PM }
const SPEC_PLAN_FILE: CompiledGuardConfig = { type: 'file-exists', path: { kind: 'field', field: 'plan' }, when: NON_PM }
const SPEC_EXIT: readonly CompiledGuardConfig[] = [SPEC_PLAN_SET, SPEC_PLAN_FILE]

const BUILD_MODE_SET: CompiledGuardConfig = { type: 'field-nonempty', field: 'build_mode' }
const BUILD_ISO_SET: CompiledGuardConfig = { type: 'field-nonempty', field: 'isolation' }
const BUILD_ISO_ENUM: CompiledGuardConfig = { type: 'field-in', field: 'isolation', values: ['branch', 'worktree'] }
const BUILD_OVERRIDE: CompiledGuardConfig = { type: 'full-direct-override' }
const BUILD_EXIT: readonly CompiledGuardConfig[] = [BUILD_MODE_SET, BUILD_ISO_SET, BUILD_ISO_ENUM, BUILD_OVERRIDE]

const VERIFY_REPORT_SET: CompiledGuardConfig = { type: 'field-nonempty', field: 'verification_report' }
const VERIFY_REPORT_FILE: CompiledGuardConfig = { type: 'file-exists', path: { kind: 'field', field: 'verification_report' } }
const VERIFY_BRANCH: CompiledGuardConfig = { type: 'field-equals', field: 'branch_status', value: 'handled' }
const VERIFY_AGENT: CompiledGuardConfig = { type: 'field-equals', field: 'agent_review_result', value: 'pass', when: NON_PM }
const VERIFY_CODEX: CompiledGuardConfig = { type: 'field-equals', field: 'codex_review_result', value: 'pass', when: NON_PM }
const BARRIER: CompiledGuardConfig = { type: 'build-head-unchanged', field: 'build_sha' }
const VERIFY_EXIT: readonly CompiledGuardConfig[] = [
  VERIFY_REPORT_SET, VERIFY_REPORT_FILE, VERIFY_BRANCH, VERIFY_AGENT, VERIFY_CODEX, BARRIER,
]

describe('老仓 state-transition.sh cmd_transition 前置校验语义对照', () => {
  describe('explore-complete（L96-102）', () => {
    it('L97-99：design_doc 空串 → field-nonempty failed（isUnset 空串支）', async () => {
      const out = await evaluateGuards(EXPLORE_EXIT, makeInput({ design_doc: '' }, { fileExists: () => true }))
      expect(out).toEqual([
        { guard: EXPLORE_DOC_SET, decision: { kind: 'failed', guardType: 'field-nonempty', field: 'design_doc', actual: '' } },
      ])
    })

    it("L78-80：design_doc 字面 'null'（init heredoc 哨兵）→ failed", async () => {
      const out = await evaluateGuards(EXPLORE_EXIT, makeInput({ design_doc: 'null' }, { fileExists: () => true }))
      expect(out).toEqual([
        { guard: EXPLORE_DOC_SET, decision: { kind: 'failed', guardType: 'field-nonempty', field: 'design_doc', actual: 'null' } },
      ])
    })

    it('L98：fileExists 注入且文件不存在 → file-exists failed', async () => {
      const out = await evaluateGuards(EXPLORE_EXIT, makeInput({ design_doc: 'docs/design.md' }, { fileExists: () => false }))
      expect(out.map((e) => e.decision)).toEqual([
        { kind: 'passed' },
        { kind: 'failed', guardType: 'file-exists', field: 'design_doc', actual: 'docs/design.md' },
      ])
    })

    it('字段非空且文件存在 → 双双 passed（L96-101 校验体通过）', async () => {
      const seen: string[] = []
      const out = await evaluateGuards(
        EXPLORE_EXIT,
        makeInput({ design_doc: 'docs/design.md' }, { fileExists: (p) => { seen.push(p); return true } }),
      )
      expect(out.map((e) => e.decision)).toEqual([{ kind: 'passed' }, { kind: 'passed' }])
      expect(seen).toEqual(['docs/design.md']) // 探测的路径 = 字段值（L98 fileExists(dd)）
    })

    it('L92-93：fileExists 未注入 → 文件面 skipped（降级视为存在），字段面照常评估', async () => {
      const out = await evaluateGuards(EXPLORE_EXIT, makeInput({ design_doc: 'docs/design.md' }))
      expect(out.map((e) => e.decision)).toEqual([
        { kind: 'passed' },
        { kind: 'skipped', capability: 'fileExists' },
      ])
    })
  })

  describe('spec-complete（L103-114）', () => {
    it('L107：track=pm → NON_PM 谓词不命中，plan 两 guard 整体不适用（零 decision）', async () => {
      const out = await evaluateGuards(SPEC_EXIT, makeInput({ plan: '' }, { track: 'pm', fileExists: () => false }))
      expect(out).toEqual([])
    })

    it('L108-111：track=backend 且 plan 空 → field-nonempty failed', async () => {
      const out = await evaluateGuards(SPEC_EXIT, makeInput({ plan: '' }, { track: 'backend', fileExists: () => true }))
      expect(out).toEqual([
        { guard: SPEC_PLAN_SET, decision: { kind: 'failed', guardType: 'field-nonempty', field: 'plan', actual: '' } },
      ])
    })

    it('track=chat 也要求 plan（P0 NON_PM 谓词：只有 pm 豁免，chat/未知不豁免）', async () => {
      const out = await evaluateGuards(SPEC_EXIT, makeInput({ plan: '' }, { track: 'chat', fileExists: () => true }))
      expect(out.map((e) => e.decision)).toEqual([
        { kind: 'failed', guardType: 'field-nonempty', field: 'plan', actual: '' },
      ])
    })

    it('L109：plan 设了但文件缺失（fileExists 注入）→ file-exists failed', async () => {
      const out = await evaluateGuards(SPEC_EXIT, makeInput({ plan: 'plan.md' }, { track: 'frontend', fileExists: () => false }))
      expect(out.map((e) => e.decision)).toEqual([
        { kind: 'passed' },
        { kind: 'failed', guardType: 'file-exists', field: 'plan', actual: 'plan.md' },
      ])
    })

    it('plan 设了 + fileExists 未注入 → 文件面 skipped（L92-93 口径同 explore）', async () => {
      const out = await evaluateGuards(SPEC_EXIT, makeInput({ plan: 'plan.md' }, { track: 'frontend' }))
      expect(out.map((e) => e.decision)).toEqual([{ kind: 'passed' }, { kind: 'skipped', capability: 'fileExists' }])
    })
  })

  describe('build-complete（L115-128）', () => {
    const BUILD_OK = { build_mode: 'worktree', isolation: 'worktree', preset: 'lite' } as const

    it("L118：build_mode 未设 → field-nonempty failed（'build_mode 必须设置' 对应支）", async () => {
      const out = await evaluateGuards(BUILD_EXIT, makeInput({ ...BUILD_OK, build_mode: '' }))
      expect(out.map((e) => e.decision)).toEqual([
        { kind: 'failed', guardType: 'field-nonempty', field: 'build_mode', actual: '' },
      ])
    })

    it("L119：isolation 未设 → field-nonempty failed（'isolation 必须设置' 对应支）", async () => {
      const out = await evaluateGuards(BUILD_EXIT, makeInput({ ...BUILD_OK, isolation: '' }))
      expect(out.map((e) => e.decision)).toEqual([
        { kind: 'passed' },
        { kind: 'failed', guardType: 'field-nonempty', field: 'isolation', actual: '' },
      ])
    })

    it('L121-123：isolation 脏值 → field-in failed，expected 列出两个合法值', async () => {
      const out = await evaluateGuards(BUILD_EXIT, makeInput({ ...BUILD_OK, isolation: 'container' }))
      expect(out.map((e) => e.decision)).toEqual([
        { kind: 'passed' },
        { kind: 'passed' },
        { kind: 'failed', guardType: 'field-in', field: 'isolation', actual: 'container', expected: ['branch', 'worktree'] },
      ])
    })

    it('isolation=branch / worktree 都放行（L121 合法枚举）', async () => {
      for (const isolation of ['branch', 'worktree']) {
        const out = await evaluateGuards([BUILD_ISO_ENUM], makeInput({ isolation }))
        expect(out.map((e) => e.decision)).toEqual([{ kind: 'passed' }])
      }
    })

    it('L124-126：preset=full ∧ build_mode=direct ∧ direct_override 未设 → full-direct-override failed', async () => {
      const out = await evaluateGuards(
        [BUILD_OVERRIDE],
        makeInput({ preset: 'full', build_mode: 'direct', direct_override: '' }),
      )
      expect(out.map((e) => e.decision)).toEqual([
        { kind: 'failed', guardType: 'full-direct-override', field: 'direct_override', actual: '', expected: ['true'] },
      ])
    })

    it("L124：direct_override='true' 才放行（'false' 等其它字面量都拒绝）", async () => {
      const failed = await evaluateGuards(
        [BUILD_OVERRIDE],
        makeInput({ preset: 'full', build_mode: 'direct', direct_override: 'false' }),
      )
      expect(failed[0]!.decision.kind).toBe('failed')
      const passed = await evaluateGuards(
        [BUILD_OVERRIDE],
        makeInput({ preset: 'full', build_mode: 'direct', direct_override: 'true' }),
      )
      expect(passed.map((e) => e.decision)).toEqual([{ kind: 'passed' }])
    })

    it('L124 合取不成立即放行：preset≠full 或 build_mode≠direct 都 passed', async () => {
      for (const fields of [
        { preset: 'lite', build_mode: 'direct' },
        { preset: 'full', build_mode: 'worktree' },
      ]) {
        const out = await evaluateGuards([BUILD_OVERRIDE], makeInput(fields))
        expect(out.map((e) => e.decision)).toEqual([{ kind: 'passed' }])
      }
    })
  })

  describe('verify-pass（L129-158）', () => {
    const VERIFY_OK = {
      verification_report: 'report.md',
      branch_status: 'handled',
      agent_review_result: 'pass',
      codex_review_result: 'pass',
      isolation: 'branch',
      build_sha: REVISION_TOKEN.value,
    } as const

    it("L130-133：verification_report 空/'null' → field-nonempty failed", async () => {
      for (const raw of ['', 'null']) {
        const out = await evaluateGuards(VERIFY_EXIT, makeInput({ ...VERIFY_OK, verification_report: raw }, { fileExists: () => true }))
        expect(out.map((e) => e.decision)).toEqual([
          { kind: 'failed', guardType: 'field-nonempty', field: 'verification_report', actual: raw },
        ])
      }
    })

    it('L131：report 设了但文件缺失 → file-exists failed', async () => {
      const out = await evaluateGuards(VERIFY_EXIT, makeInput(VERIFY_OK, { fileExists: () => false }))
      expect(out.map((e) => e.decision)).toEqual([
        { kind: 'passed' },
        { kind: 'failed', guardType: 'file-exists', field: 'verification_report', actual: 'report.md' },
      ])
    })

    it('L134-137：branch_status≠handled → field-equals failed，expected=[handled]', async () => {
      const out = await evaluateGuards(
        VERIFY_EXIT,
        makeInput({ ...VERIFY_OK, branch_status: 'open' }, { fileExists: () => true }),
      )
      expect(out.map((e) => e.decision)).toEqual([
        { kind: 'passed' },
        { kind: 'passed' },
        { kind: 'failed', guardType: 'field-equals', field: 'branch_status', actual: 'open', expected: ['handled'] },
      ])
    })

    it('L141-143：非 pm 轨 agent_review_result≠pass → field-equals failed', async () => {
      const out = await evaluateGuards(
        VERIFY_EXIT,
        makeInput({ ...VERIFY_OK, agent_review_result: 'fail' }, { track: 'frontend', fileExists: () => true }),
      )
      expect(out.at(-1)!.decision).toEqual({
        kind: 'failed', guardType: 'field-equals', field: 'agent_review_result', actual: 'fail', expected: ['pass'],
      })
    })

    it('L144-145：非 pm 轨 codex_review_result≠pass → field-equals failed（agent 过了才轮到它）', async () => {
      const out = await evaluateGuards(
        VERIFY_EXIT,
        makeInput({ ...VERIFY_OK, codex_review_result: '' }, { track: 'backend', fileExists: () => true }),
      )
      expect(out.at(-1)!.decision).toEqual({
        kind: 'failed', guardType: 'field-equals', field: 'codex_review_result', actual: '', expected: ['pass'],
      })
    })

    it('L140-141：track=pm → 双 review guard 不适用；其余 guard 照常评估', async () => {
      const out = await evaluateGuards(
        VERIFY_EXIT,
        makeInput(
          { ...VERIFY_OK, agent_review_result: '', codex_review_result: '' },
          { track: 'pm', fileExists: () => true, assessBuildRevision: assessTrustedRevision },
        ),
      )
      // 6 条里 when:NON_PM 的两条被跳过：report 字段/文件 + branch_status + barrier = 4 条全 passed
      expect(out.map((e) => e.decision)).toEqual([
        { kind: 'passed' }, { kind: 'passed' }, { kind: 'passed' }, { kind: 'passed' },
      ])
      expect(out.map((e) => e.guard)).toEqual([VERIFY_REPORT_SET, VERIFY_REPORT_FILE, VERIFY_BRANCH, BARRIER])
    })

    it("build_sha 缺失/null → stable verify-build-revision-untrusted blocker（不再放行）", async () => {
      for (const bsha of ['', 'null']) {
        const out = await evaluateGuards([BARRIER], makeInput({ build_sha: bsha }, { assessBuildRevision: assessTrustedRevision }))
        expect(out[0]?.decision).toMatchObject({ kind: 'failed', blocker: {
          code: 'verify-build-revision-untrusted', reason: bsha === '' ? 'missing' : 'null',
        } })
      }
    })

    it('L150：gitHeadSha 未注入 → capability blocker（revision trust 缺能力时 fail-closed）', async () => {
      const out = await evaluateGuards([BARRIER], makeInput({ build_sha: REVISION_TOKEN.value }))
      expect(out[0]?.decision).toMatchObject({ kind: 'failed', blocker: {
        code: 'verify-build-revision-untrusted', reason: 'capability-unavailable',
      } })
    })

    it('in-place workspace baseline 未接 assessor → capability blocker（不降级读取旧 fingerprint）', async () => {
      let gitCalls = 0
      const baseline = 'workspace:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const out = await evaluateGuards([BARRIER], makeInput(
        { build_sha: baseline },
        {
          gitHeadSha: async () => { gitCalls++; return 'UNUSED' },
          workspaceFingerprint: async () => baseline,
        },
      ))
      expect(out[0]?.decision).toMatchObject({ kind: 'failed', blocker: {
        code: 'verify-build-revision-untrusted', reason: 'capability-unavailable',
      } })
      expect(gitCalls).toBe(0)
    })

    it('in-place workspace baseline 未接 assessor → capability blocker，raw baseline 不作事实', async () => {
      const baseline = 'workspace:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const current = 'workspace:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      const out = await evaluateGuards([BARRIER], makeInput(
        { build_sha: baseline }, { workspaceFingerprint: async () => current },
      ))
      expect(out[0]?.decision).toMatchObject({ kind: 'failed', blocker: {
        code: 'verify-build-revision-untrusted', reason: 'capability-unavailable',
      } })
    })

    it('legacy build_sha 即使 HEAD capability 有值也会被 malformed blocker 拒绝', async () => {
      const out = await evaluateGuards([BARRIER], makeInput({ build_sha: 'abc123' }, { gitHeadSha: async () => '  \n', assessBuildRevision: assessTrustedRevision }))
      expect(out[0]?.decision).toMatchObject({ kind: 'failed', blocker: {
        code: 'verify-build-revision-untrusted', reason: 'malformed',
      } })
    })

    it('legacy bare SHA 即使 HEAD 相等也不 backfill，保持 malformed blocker', async () => {
      const out = await evaluateGuards([BARRIER], makeInput({ build_sha: 'abc123' }, { gitHeadSha: async () => 'abc123\n', assessBuildRevision: assessTrustedRevision }))
      expect(out[0]?.decision).toMatchObject({ kind: 'failed', blocker: {
        code: 'verify-build-revision-untrusted', reason: 'malformed',
      } })
    })

    it('legacy bare SHA 与 HEAD 漂移仍先拒 malformed，不折成普通 head mismatch', async () => {
      const out = await evaluateGuards([BARRIER], makeInput({ build_sha: 'abc123' }, { gitHeadSha: async () => 'def456\n', assessBuildRevision: assessTrustedRevision }))
      expect(out[0]?.decision).toMatchObject({ kind: 'failed', blocker: {
        code: 'verify-build-revision-untrusted', reason: 'malformed',
      } })
    })

    it('缺失 assessor 时不读取 gitHeadSha，直接返回 capability blocker（不泄漏异常）', async () => {
      const boom = vi.fn(async (): Promise<string> => { throw new Error('git rev-parse blew up') })
      const out = await evaluateGuards([BARRIER], makeInput({ build_sha: '' }, { gitHeadSha: boom }))
      expect(out[0]?.decision).toMatchObject({ kind: 'failed', blocker: {
        code: 'verify-build-revision-untrusted', reason: 'capability-unavailable',
      } })
      expect(boom).not.toHaveBeenCalled()
    })

    it("缺失/null 由 assessor 负责求值；guard 不直接读取 gitHeadSha", async () => {
      for (const bsha of ['', 'null']) {
        const spy = vi.fn(async () => 'zzz999')
        const out = await evaluateGuards([BARRIER], makeInput({ build_sha: bsha }, {
          gitHeadSha: spy, assessBuildRevision: assessTrustedRevision,
        }))
        expect(spy).not.toHaveBeenCalled()
        expect(out[0]?.decision).toMatchObject({ kind: 'failed', blocker: {
          code: 'verify-build-revision-untrusted', reason: bsha === '' ? 'missing' : 'null',
        } })
      }
    })

    it.each(['', 'null'])("isolation 没设（%j）：assessor 拿到的 isolation 是 in-place（与 freeze 的默认同一口径）", async (unset) => {
      const seen: string[] = []
      const out = await evaluateGuards([BARRIER], makeInput({ build_sha: 'x', isolation: unset }, {
        assessBuildRevision: async (request) => { seen.push(request.isolation); return assessTrustedRevision(request) },
      }))
      expect(seen).toEqual(['in-place'])
      expect(out).toHaveLength(1)
    })

    it('isolation 是显式的 branch：原样交给 assessor', async () => {
      const seen: string[] = []
      await evaluateGuards([BARRIER], makeInput({ build_sha: 'x', isolation: 'branch' }, {
        assessBuildRevision: async (request) => { seen.push(request.isolation); return assessTrustedRevision(request) },
      }))
      expect(seen).toEqual(['branch'])
    })

    it('全字段齐 + 文件在 + HEAD 对齐 → 6 条全 passed（L129-157 校验体通过）', async () => {
      const out = await evaluateGuards(
        VERIFY_EXIT,
        makeInput(VERIFY_OK, { fileExists: () => true, assessBuildRevision: assessTrustedRevision }),
      )
      expect(out).toHaveLength(6)
      expect(out.every((e) => e.decision.kind === 'passed')).toBe(true)
    })
  })

  it('无专属校验的事件（例如 open-complete）≙ 零 guard → 空输出通行', async () => {
    expect(await evaluateGuards([], makeInput())).toEqual([])
  })
})

describe('旧 v1 guard 语义对照：evaluateStepGuards（workflow/stepGuard.ts L26-48）', () => {
  const TASKS3: CompiledGuardConfig = { type: 'tasks-at-least', n: 3 }

  it('L38-44：tasks.md 计数 ≥ n → passed（勾选/未勾选都计入，flow/guard.ts L194-197 taskCount 口径）', async () => {
    const out = await evaluateGuards([TASKS3], makeInput({}, { readText: () => '- [ ] a\n- [x] b\n- [ ] c\n' }))
    expect(out.map((e) => e.decision)).toEqual([{ kind: 'passed' }])
  })

  it('L41-43：计数不足 → failed，actual=实际计数、expected=[n]', async () => {
    const out = await evaluateGuards([TASKS3], makeInput({}, { readText: () => '- [ ] a\n- [x] b\n' }))
    expect(out.map((e) => e.decision)).toEqual([
      { kind: 'failed', guardType: 'tasks-at-least', actual: '2', expected: ['3'] },
    ])
  })

  it('L17-24：readText 注入但 tasks.md 缺失（undefined）→ 计 0 → failed（缺失≠降级）', async () => {
    const out = await evaluateGuards([TASKS3], makeInput({}, { readText: () => undefined }))
    expect(out.map((e) => e.decision)).toEqual([
      { kind: 'failed', guardType: 'tasks-at-least', actual: '0', expected: ['3'] },
    ])
  })

  it('readText 能力未注入 → skipped（能力缺失才降级，与文件缺失分道）', async () => {
    const out = await evaluateGuards([TASKS3], makeInput())
    expect(out.map((e) => e.decision)).toEqual([{ kind: 'skipped', capability: 'readText' }])
  })

  it('读取路径固定 tasks.md（stepGuard.ts L20 join(changeDirAbs, "tasks.md") 的相对化）', async () => {
    const paths: string[] = []
    await evaluateGuards([TASKS3], makeInput({}, { readText: (p) => { paths.push(p); return '- [ ] a\n- [ ] b\n- [ ] c\n' } }))
    expect(paths).toEqual(['tasks.md'])
  })

  it('nonempty-output 运行期兜底：直接调 handler 抛错（IR 由 compileWorkflow 展开，不含该变体）', () => {
    expect(() => GUARD_HANDLERS['nonempty-output']({ type: 'nonempty-output' }, makeInput())).toThrow(
      /nonempty-output/,
    )
  })

  it('nonempty-output 经 evaluateGuards 同样 fail-loud（reject 而非静默跳过）', async () => {
    // nonempty-output 已被 CompiledGuardConfig（Exclude）静态排除；这里 cast 模拟「绕过编译器」的
    // 越界输入，验运行期注册表兜底仍 fail-loud（reject 而非静默跳过）。
    await expect(evaluateGuards([{ type: 'nonempty-output' } as unknown as CompiledGuardConfig], makeInput())).rejects.toThrow(/nonempty-output/)
  })
})

describe('handler 读值口径（编译产物保证 scalar guard 的 field 非列表；数组 = 绕过编译器）', () => {
  it('field-nonempty 运行期读到数组值 → fail-loud throw（compile.ts 列表闸的运行期兜底，对齐 nonempty-output 兜底先例）', () => {
    expect(() =>
      GUARD_HANDLERS['field-nonempty']({ type: 'field-nonempty', field: 'scope' }, makeInput({ scope: ['a', 'b'] })),
    ).toThrow(/列表字段.*scope.*绕过/)
    expect(() =>
      GUARD_HANDLERS['field-nonempty']({ type: 'field-nonempty', field: 'scope' }, makeInput({ scope: [] })),
    ).toThrow(/列表字段.*scope.*绕过/)
  })

  it('经 evaluateGuards 同样 fail-loud（reject 而非把数组静默折成字符串）', async () => {
    await expect(
      evaluateGuards([{ type: 'field-equals', field: 'related_files', value: 'x' }], makeInput({ related_files: ['x'] })),
    ).rejects.toThrow(/列表字段.*related_files/)
  })

  it("file-exists：字段未设 → failed（未设路径必不存在），不触发 fileExists 探测", async () => {
    const probed: string[] = []
    const out = await GUARD_HANDLERS['file-exists'](
      { type: 'file-exists', path: { kind: 'field', field: 'design_doc' } },
      makeInput({ design_doc: 'null' }, { fileExists: (p) => { probed.push(p); return true } }),
    )
    expect(out).toEqual({ kind: 'failed', guardType: 'file-exists', field: 'design_doc', actual: 'null' })
    expect(probed).toEqual([])
  })
})

describe('evaluateGuards 组合语义', () => {
  it('spec-migration-applied 缺能力或证据非法时失败关闭，明确不需要或已应用时通过', async () => {
    const guard: CompiledGuardConfig = { type: 'spec-migration-applied' }
    await expect(evaluateGuards([guard], makeInput())).resolves.toEqual([{
      guard,
      decision: {
        kind: 'failed',
        guardType: 'spec-migration-applied',
        actual: 'capability-unavailable',
        expected: ['not-required', 'applied'],
      },
    }])
    await expect(evaluateGuards([guard], makeInput({}, {
      specMigrationStatus: async () => ({ kind: 'invalid', reason: 'receipt-mismatch' }),
    }))).resolves.toEqual([{
      guard,
      decision: {
        kind: 'failed',
        guardType: 'spec-migration-applied',
        actual: 'receipt-mismatch',
        expected: ['not-required', 'applied'],
      },
    }])
    await expect(evaluateGuards([guard], makeInput({}, {
      specMigrationStatus: async () => ({ kind: 'not-required' }),
    }))).resolves.toEqual([{ guard, decision: { kind: 'passed' } }])
    await expect(evaluateGuards([guard], makeInput({}, {
      specMigrationStatus: async () => ({ kind: 'applied' }),
    }))).resolves.toEqual([{ guard, decision: { kind: 'passed' } }])
  })

  it('首个 failed 即停：后续 guard 不评估、不触发其能力 IO（旧 case 体首个违反立即 return 的等价）', async () => {
    const gitSpy = vi.fn(async () => 'abc123')
    const out = await evaluateGuards(
      VERIFY_EXIT,
      makeInput({ verification_report: '' }, { fileExists: () => true, gitHeadSha: gitSpy }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.decision.kind).toBe('failed')
    expect(gitSpy).not.toHaveBeenCalled()
  })

  it('skipped（能力缺失）不打断评估：后续 guard 照常跑', async () => {
    const out = await evaluateGuards(
      [EXPLORE_DOC_FILE, EXPLORE_DOC_SET],
      makeInput({ design_doc: 'docs/design.md' }),
    )
    expect(out.map((e) => e.decision)).toEqual([{ kind: 'skipped', capability: 'fileExists' }, { kind: 'passed' }])
  })

  it('when 不命中的 guard 零输出：输出只含适用 guard，顺序 = 声明序', async () => {
    const out = await evaluateGuards(
      [VERIFY_AGENT, VERIFY_BRANCH, VERIFY_CODEX],
      makeInput({ branch_status: 'handled', agent_review_result: '', codex_review_result: '' }, { track: 'pm' }),
    )
    expect(out.map((e) => e.guard)).toEqual([VERIFY_BRANCH])
    expect(out.map((e) => e.decision)).toEqual([{ kind: 'passed' }])
  })

  it('when 命中才评估：非 pm 轨上同一组 guard 全数适用', async () => {
    const out = await evaluateGuards(
      [VERIFY_AGENT, VERIFY_CODEX],
      makeInput({ agent_review_result: 'pass', codex_review_result: 'pass' }, { track: 'ml' }),
    )
    expect(out.map((e) => e.decision)).toEqual([{ kind: 'passed' }, { kind: 'passed' }])
  })
})

describe('通用离开条件（设计 §1b Q5 / Q7 / Q8）', () => {
  const TASKS: CompiledGuardConfig = { type: 'tasks-through-step' }
  const AFK: CompiledGuardConfig = { type: 'not-afk-queued' }
  const DEPS: CompiledGuardConfig = { type: 'dependencies-ended' }

  describe('tasks-through-step', () => {
    it('有未勾任务：失败并把未勾原文放进 detail，按当前步骤向能力取数', async () => {
      const seen: string[] = []
      const out = await evaluateGuards([TASKS], makeInput({}, {
        currentStep: 'build',
        tasksThroughStep: async (step) => {
          seen.push(step)
          return { complete: false, unchecked: ['写测试 (build)', '接线 (build)'] }
        },
      }))
      expect(out).toEqual([
        { guard: TASKS, decision: { kind: 'failed', guardType: 'tasks-through-step', detail: ['写测试 (build)', '接线 (build)'] } },
      ])
      expect(seen).toEqual(['build'])
    })

    it('全部已勾：passed', async () => {
      const out = await evaluateGuards([TASKS], makeInput({}, {
        currentStep: 'build',
        tasksThroughStep: async () => ({ complete: true, unchecked: [] }),
      }))
      expect(out.map((e) => e.decision)).toEqual([{ kind: 'passed' }])
    })

    it('以 complete 为准：complete=false 但没给原文时仍失败（detail 为空数组）', async () => {
      const out = await evaluateGuards([TASKS], makeInput({}, {
        tasksThroughStep: async () => ({ complete: false, unchecked: [] }),
      }))
      expect(out.map((e) => e.decision)).toEqual([{ kind: 'failed', guardType: 'tasks-through-step', detail: [] }])
    })

    it('当前步骤未知（currentStep 空串）：失败关闭，不向能力取数', async () => {
      let called = false
      const out = await evaluateGuards([TASKS], makeInput({}, {
        currentStep: '',
        tasksThroughStep: async () => { called = true; return { complete: true, unchecked: [] } },
      }))
      expect(called).toBe(false)
      expect(out.map((e) => e.decision)).toEqual([
        { kind: 'failed', guardType: 'tasks-through-step', actual: 'current-step-unavailable' },
      ])
    })
  })

  describe('not-afk-queued', () => {
    it('排队中：失败', async () => {
      const out = await evaluateGuards([AFK], makeInput({}, { afkQueued: async () => true }))
      expect(out.map((e) => e.decision)).toEqual([{ kind: 'failed', guardType: 'not-afk-queued', actual: 'queued' }])
    })

    it('未排队：passed', async () => {
      const out = await evaluateGuards([AFK], makeInput({}, { afkQueued: async () => false }))
      expect(out.map((e) => e.decision)).toEqual([{ kind: 'passed' }])
    })
  })

  describe('dependencies-ended', () => {
    it('依赖未结束：失败并只点名未结束的依赖', async () => {
      const out = await evaluateGuards([DEPS], makeInput({}, {
        dependencyStates: async () => [{ name: 'a', ended: true }, { name: 'b', ended: false }, { name: 'c', ended: false }],
      }))
      expect(out.map((e) => e.decision)).toEqual([
        { kind: 'failed', guardType: 'dependencies-ended', detail: ['b', 'c'] },
      ])
    })

    it('依赖全部结束：passed', async () => {
      const out = await evaluateGuards([DEPS], makeInput({}, {
        dependencyStates: async () => [{ name: 'a', ended: true }],
      }))
      expect(out.map((e) => e.decision)).toEqual([{ kind: 'passed' }])
    })

    it('没有依赖：passed', async () => {
      const out = await evaluateGuards([DEPS], makeInput({}, { dependencyStates: async () => [] }))
      expect(out.map((e) => e.decision)).toEqual([{ kind: 'passed' }])
    })
  })

  it('能力缺失时三者都失败（fail-closed），且各自点名缺的能力', async () => {
    const out = await evaluateGuards([TASKS, AFK, DEPS], makeInput(), { stopOnFirstFailure: false })
    expect(out.map((e) => e.decision)).toEqual([
      { kind: 'failed', guardType: 'tasks-through-step', actual: 'capability-unavailable', missingCapability: 'tasksThroughStep' },
      { kind: 'failed', guardType: 'not-afk-queued', actual: 'capability-unavailable', missingCapability: 'afkQueued' },
      { kind: 'failed', guardType: 'dependencies-ended', actual: 'capability-unavailable', missingCapability: 'dependencyStates' },
    ])
  })

  it('能力抛错时失败关闭为 evaluation-error，原始异常文本不外泄', async () => {
    const boom = async (): Promise<never> => { throw new Error('/secret/path 读失败') }
    const out = await evaluateGuards([TASKS, AFK, DEPS], makeInput({}, {
      tasksThroughStep: boom, afkQueued: boom, dependencyStates: boom,
    }), { stopOnFirstFailure: false })
    expect(out.map((e) => e.decision)).toEqual([
      { kind: 'failed', guardType: 'tasks-through-step', actual: 'evaluation-error' },
      { kind: 'failed', guardType: 'not-afk-queued', actual: 'evaluation-error' },
      { kind: 'failed', guardType: 'dependencies-ended', actual: 'evaluation-error' },
    ])
    expect(JSON.stringify(out)).not.toContain('/secret/path')
  })

  it('一次列出全部失败：字段条件与离开条件并存时两者都在结果里（stopOnFirstFailure=false）', async () => {
    const out = await evaluateGuards(
      [{ type: 'field-equals', field: 'pre_verify_review_result', value: 'pass' }, AFK],
      makeInput({ pre_verify_review_result: 'pending' }, { afkQueued: async () => true }),
      { stopOnFirstFailure: false },
    )
    expect(out.filter((e) => e.decision.kind === 'failed').map((e) => e.guard.type)).toEqual(['field-equals', 'not-afk-queued'])
  })

  it('when 谓词不命中的离开条件整体不适用：不取数、不算失败', async () => {
    const out = await evaluateGuards(
      [{ type: 'not-afk-queued', when: { kind: 'track-in', values: ['pm'] } }],
      makeInput({}, { track: 'backend' }),
    )
    expect(out).toEqual([])
  })
})

describe('required-output（必须产出）', () => {
  const REQUIRED: CompiledGuardConfig = { type: 'required-output', path: 'docs/superpowers/specs/*.md' }

  it('满足：passed，并按当前步骤与原样的路径模式向能力取数', async () => {
    const seen: Array<readonly [string, string]> = []
    const out = await evaluateGuards([REQUIRED], makeInput({}, {
      currentStep: 'explore',
      requiredOutput: async (step, pattern) => { seen.push([step, pattern]); return true },
    }))
    expect(out.map((e) => e.decision)).toEqual([{ kind: 'passed' }])
    expect(seen).toEqual([['explore', 'docs/superpowers/specs/*.md']])
  })

  it('不满足：失败，actual 为 missing', async () => {
    const out = await evaluateGuards([REQUIRED], makeInput({}, { requiredOutput: async () => false }))
    expect(out).toEqual([{
      guard: REQUIRED,
      decision: { kind: 'failed', guardType: 'required-output', actual: 'missing', path: 'docs/superpowers/specs/*.md' },
    }])
  })

  it('不满足：failed 决策带上路径模式，{change} 已换成任务名（供客户端显示要写哪个文件）', async () => {
    const guard: CompiledGuardConfig = { type: 'required-output', path: 'openspec/changes/{change}/proposal.md' }
    const out = await evaluateGuards([guard], makeInput({}, { change: 'plan-checkout', requiredOutput: async () => false }))
    expect(out.map((e) => e.decision)).toEqual([
      { kind: 'failed', guardType: 'required-output', actual: 'missing', path: 'openspec/changes/plan-checkout/proposal.md' },
    ])
  })

  it('不满足但任务名未知：路径模式原样给出', async () => {
    const guard: CompiledGuardConfig = { type: 'required-output', path: 'openspec/changes/{change}/proposal.md' }
    const out = await evaluateGuards([guard], makeInput({}, { requiredOutput: async () => false }))
    expect(out.map((e) => e.decision)).toEqual([
      { kind: 'failed', guardType: 'required-output', actual: 'missing', path: 'openspec/changes/{change}/proposal.md' },
    ])
  })

  it('能力缺失：失败关闭并点名 requiredOutput（不降级为跳过）', async () => {
    const out = await evaluateGuards([REQUIRED], makeInput())
    expect(out.map((e) => e.decision)).toEqual([
      {
        kind: 'failed', guardType: 'required-output', actual: 'capability-unavailable', missingCapability: 'requiredOutput',
        path: 'docs/superpowers/specs/*.md',
      },
    ])
  })

  it('能力抛错：失败关闭为 evaluation-error，原始异常文本不外泄', async () => {
    const out = await evaluateGuards([REQUIRED], makeInput({}, {
      requiredOutput: async () => { throw new Error('/secret/path 读失败') },
    }))
    expect(out.map((e) => e.decision)).toEqual([
      { kind: 'failed', guardType: 'required-output', actual: 'evaluation-error', path: 'docs/superpowers/specs/*.md' },
    ])
    expect(JSON.stringify(out)).not.toContain('/secret/path')
  })

  it('当前步骤未知（currentStep 空串）：失败关闭，不向能力取数', async () => {
    let called = false
    const out = await evaluateGuards([REQUIRED], makeInput({}, {
      currentStep: '',
      requiredOutput: async () => { called = true; return true },
    }))
    expect(called).toBe(false)
    expect(out.map((e) => e.decision)).toEqual([
      { kind: 'failed', guardType: 'required-output', actual: 'current-step-unavailable', path: 'docs/superpowers/specs/*.md' },
    ])
  })

  it('when 谓词不命中：整体不适用，不取数', async () => {
    let called = false
    const out = await evaluateGuards(
      [{ ...REQUIRED, when: { kind: 'track-in', values: ['pm'] } }],
      makeInput({}, { track: 'backend', requiredOutput: async () => { called = true; return false } }),
    )
    expect(out).toEqual([])
    expect(called).toBe(false)
  })
})

describe('注册表无运行时替换面', () => {
  it('GUARD_HANDLERS 已冻结：Object.isFrozen + 改写既有键抛 TypeError（严格模式）', () => {
    expect(Object.isFrozen(GUARD_HANDLERS)).toBe(true)
    expect(() => {
      ;(GUARD_HANDLERS as unknown as Record<string, unknown>)['field-nonempty'] = () => ({ kind: 'passed' })
    }).toThrow(TypeError)
  })
})
