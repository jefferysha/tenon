/**
 * 集成 harness 的「升级前创建的在途任务」夹具：新任务一律按工作流 YAML 执行（step-graph），
 * 这里造出升级前创建的两种任务——冻结着旧执行模型（阶段清单）计划的 default 任务，
 * 与按已退役的 standard 工作流创建的任务（它的模板已从仓库删除，只剩任务里冻结的快照）——
 * 用来验证旧任务照旧规则走完。
 * 非 *.test.ts，只给集成测试引用。
 */
import {
  compileEffectiveWorkflowPlan,
  effectiveWorkflowPlanBinding,
  ensureAgentFreeze,
  loadWorkflow,
  parseWorkflow,
  prepareAgentFreeze,
  workflowPlanSnapshot,
} from '@tenon/kernel'
import type { PlanOptions, WorkflowDef } from '@tenon/kernel'
import { recordHistory } from './commands/fields.js'
import type { CliDeps } from './deps.js'
import { autoDiscoverCatalog } from './test-system/auto-discover.js'
import { requireActor } from './userIdentity.js'

/**
 * 已退役的 standard 工作流模板原文（升级前的 `templates/workflows/standard.yaml`，逐字照抄）：
 * 平铺工作流，open → build（TDD 技能 + diff-risk 探针 + 单测）→ verify（评审门，评审者 code-review、security）→ done / escalated。
 * 模板已不在仓库里；留在这里只为造出「升级前创建」的 standard 任务。
 */
const LEGACY_STANDARD_WORKFLOW_YAML = `name: standard
steps:
  - id: open
    label: 立项
    gate: null
    prompt: |-
      用一句话向用户复述目标，并写出可验证的验收标准（哪个失败的用例该变成通过）。目标已经清楚就不提问、不写文档、不加载访谈类技能；含糊到没法开工才问一个问题。
      一开始就能看出要动接口契约、鉴权、依赖、数据迁移或十几个文件，不要在这里硬做：走 scope-expanded，改开 default 任务。
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: open-complete
        to: build
      - event: scope-expanded
        to: escalated
        actions:
          - type: archive-run
  - id: build
    label: 实现
    gate: null
    prompt: |-
      先写（或确认已有）能复现问题、验证新行为的测试，再改代码到测试通过；只改目标需要的文件，不顺手重构。
      改完照 next 跑本阶段测试和改动风险探针 diff-risk。探针不过（改动文件太多，或碰了契约、鉴权、依赖、迁移，或删了测试、改了受保护的测试配置）说明任务超出标准通道：照 next 走 scope-expanded，再新建 default 任务并 tenon set <新任务> depends_on <本任务>；不要为了让探针通过去拆改动、藏文件。
    skills:
      - id: test-driven-development
    inputs: []
    outputs: []
    tests:
      - id: diff-risk
        direction: diff-risk
        command: tenon test diff-risk --json
        label: 改动风险
        timeout_s: 60
        required: true
        pass:
          metrics:
            - name: files_changed
              max: 8
            - name: contract_files
              max: 0
            - name: auth_files
              max: 0
            - name: dependency_files
              max: 0
            - name: migration_files
              max: 0
            - name: deleted_tests
              max: 0
            - name: protected_test_files
              max: 0
    guards: []
    test_policy:
      plan: required
      kinds: [unit]
      run: [unit]
      run_if_registered: [typecheck]
      scope: changed
      files: registered
    transitions:
      - event: build-complete
        to: verify
      - event: scope-expanded
        to: escalated
        actions:
          - type: archive-run
  - id: verify
    label: 验证
    gate: review
    prompt: |-
      先加载验证技能，再照 next 跑全量测试和评审者。派发评审者时，在提示末尾写明用户的原始目标和验收标准，评审者没有规格文档可读。
      评审者给出 medium 及以上的问题就走 verify-fail 回到实现修掉；不要靠重跑评审者换结论。
    skills:
      - id: verification-before-completion
    inputs: []
    outputs: []
    agents:
      reviewers:
        - agent: code-review
          required: true
          block_at: medium
        - agent: security
          required: true
          block_at: medium
    guards: []
    test_policy:
      run: [unit]
      run_if_registered: [regression, typecheck, integration, e2e, playwright, a11y, visual]
      scope: full
      files: registered
    transitions:
      - event: verify-pass
        to: done
        actions:
          - type: mark-verification-passed
          - type: archive-run
      - event: verify-fail
        to: build
        actions:
          - type: mark-verification-failed
      - event: scope-expanded
        to: escalated
        actions:
          - type: archive-run
  - id: done
    label: 完结
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
  - id: escalated
    label: 已升级
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

/** 一种「升级前创建的任务」：工作流定义、所在轨道、冻结进快照的执行模型，以及立项时的文档治理绑定。 */
interface LegacyChangeSpec {
  readonly workflowId: string
  /** 冻结进快照的定义；`undefined` 时按 id 取内建模板（default）。 */
  readonly definition: WorkflowDef | undefined
  readonly track: string
  readonly executionModel: NonNullable<PlanOptions['executionModel']>
  /** 立项时是否带 openspec-v1 文档治理（default 有；平铺的 standard 没有，cmdInit 不设这个值）。 */
  readonly openspecContract: boolean
}

/** 与 cmdInit 同一条装配（agent 冻结、历史、文档语言），只是计划按旧执行模型编出来、冻结进快照。 */
async function initLegacyChange(
  deps: CliDeps,
  cwd: string,
  name: string,
  preset: string,
  spec: LegacyChangeSpec,
): Promise<number> {
  const creator = requireActor(deps)
  if (creator === null) return 1
  const plan = compileEffectiveWorkflowPlan(
    spec.workflowId,
    spec.definition,
    { track: spec.track, executionModel: spec.executionModel },
  )
  const first = plan.workflow.steps[0]
  if (first === undefined) throw new Error(`harness initLegacyChange: ${spec.workflowId} 没有步骤`)
  const freezeAgent = await prepareAgentFreeze(
    plan.workflow,
    deps.agentLibrary ?? (async () => ({ entries: [], sync: { id: 'agents', state: 'unchanged' as const } })),
  )
  const { changeDir, run } = await deps.runRepo.initChange({
    repoRoot: cwd, name, track: spec.track, reviewSeed: 'pending', preset, creator, clock: deps.clock, documentLocale: 'zh-CN',
    initialWorkflow: {
      workflow: spec.workflowId,
      phase: first.id,
      ...effectiveWorkflowPlanBinding(plan),
      workflowPlanSnapshot: workflowPlanSnapshot(plan),
      ...(spec.openspecContract ? { openspecContract: true } : {}),
    },
  })
  if (freezeAgent !== undefined) {
    await ensureAgentFreeze({
      changeDir, runId: run.id, workflowFingerprint: plan.workflowFingerprint, workflow: plan.workflow, resolve: freezeAgent,
    })
  }
  await recordHistory(deps, changeDir, { ts: deps.clock(), kind: 'init', actor: creator })
  // 声明了测试策略而项目还没有测试目录：立项后自动识别（同 cmdInit）。
  if (plan.workflow.steps.some((step) => step.test_policy !== undefined)) await autoDiscoverCatalog(cwd)
  return 0
}

/** 升级前创建的 default 任务：快照记着 phase-manifest（阶段清单）计划。 */
export async function initLegacyDefaultChange(
  deps: CliDeps,
  cwd: string,
  name: string,
  track: string,
  preset: string,
): Promise<number> {
  return initLegacyChange(deps, cwd, name, preset, {
    workflowId: 'default',
    definition: loadWorkflow(cwd, 'default') ?? undefined,
    track,
    executionModel: 'phase-manifest',
    openspecContract: true,
  })
}

/** 升级前创建的 standard 任务：平铺工作流、step-graph 执行模型、轨道 standard，定义取自已退役模板的原文。 */
export async function initLegacyStandardChange(
  deps: CliDeps,
  cwd: string,
  name: string,
  preset: string,
): Promise<number> {
  return initLegacyChange(deps, cwd, name, preset, {
    workflowId: 'standard',
    definition: parseWorkflow(LEGACY_STANDARD_WORKFLOW_YAML),
    track: 'standard',
    executionModel: 'step-graph',
    openspecContract: false,
  })
}
