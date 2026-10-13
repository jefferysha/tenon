/**
 * 集成 harness 的「升级前创建的在途任务」夹具：新任务一律按工作流 YAML 执行（step-graph）且没有文档契约，
 * 这里造出升级前创建的三种任务——冻结着旧执行模型（阶段清单）计划的 default 任务、冻结着旧文档契约
 * 的 step-graph default 任务（两者的定义都取自 `tools/fixtures/legacy-default-workflow.yaml`），
 * 与按已退役的 standard 工作流创建的任务（它的模板已从仓库删除，只剩任务里冻结的快照）——
 * 用来验证旧任务照旧规则走完。
 * 非 *.test.ts，只给集成测试引用。
 */
import {
  compileDefaultWorkflow,
  compileEffectiveWorkflowPlan,
  compileWorkflow,
  effectiveWorkflowPlanBinding,
  effectiveWorkflowPlanFromIr,
  ensureAgentFreeze,
  parseWorkflow,
  prepareAgentFreeze,
  workflowPlanSnapshot,
} from '@tenon/kernel'
import type { EffectiveWorkflowPlan, WorkflowDef } from '@tenon/kernel'
import { legacyContractDefaultPlan } from '@tenon/kernel/workflow/test-support'
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

/** 一种「升级前创建的任务」：冻结进快照的计划与所在轨道；立项时的文档治理绑定由计划自己的契约决定（同 cmdInit）。 */
interface LegacyChangeSpec {
  /** 冻结进快照的计划（升级前的定义 + 旧执行模型）；由各夹具自己编出，不经 `validateWorkflow`（旧定义带已删除的键）。 */
  readonly plan: EffectiveWorkflowPlan
  readonly track: string
  /** 治理文档语言，缺省中文（同 `tenon init`）。 */
  readonly documentLocale?: 'zh-CN' | 'en'
}

/** 升级前创建的任务共同的可选项。 */
export interface LegacyInitOptions {
  /** 治理文档语言，缺省中文。 */
  readonly documentLocale?: 'zh-CN' | 'en'
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
  const { plan } = spec
  const first = plan.workflow.steps[0]
  if (first === undefined) throw new Error(`harness initLegacyChange: ${plan.id} 没有步骤`)
  const freezeAgent = await prepareAgentFreeze(
    plan.workflow,
    deps.agentLibrary ?? (async () => ({ entries: [], sync: { id: 'agents', state: 'unchanged' as const } })),
  )
  const { changeDir, run } = await deps.runRepo.initChange({
    repoRoot: cwd, name, track: spec.track, reviewSeed: 'pending', preset, creator, clock: deps.clock,
    documentLocale: spec.documentLocale ?? 'zh-CN',
    initialWorkflow: {
      workflow: plan.id,
      phase: first.id,
      ...effectiveWorkflowPlanBinding(plan),
      workflowPlanSnapshot: workflowPlanSnapshot(plan),
      ...(plan.capabilities.documents.policy?.id === 'openspec-v1' ? { openspecContract: true } : {}),
      ...(plan.capabilities.documents.policy?.id === 'document-v1' ? { documentContract: true } : {}),
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

/** 带契约的升级前 default 的选项：`definition` 给了就用它代替升级前的 default 原文（在原文上加一条测试、加几条旧轨道之类）。 */
export interface LegacyDefaultOptions extends LegacyInitOptions {
  readonly definition?: WorkflowDef
}

/** 升级前的 default 计划：不经 `validateWorkflow`（旧定义带已删除的键），直接按 default 的编译入口建。 */
function legacyDefaultChangePlan(
  track: string,
  executionModel: NonNullable<EffectiveWorkflowPlan['executionModel']>,
  definition: WorkflowDef | undefined,
): EffectiveWorkflowPlan {
  return definition === undefined
    ? legacyContractDefaultPlan(track, executionModel)
    : effectiveWorkflowPlanFromIr('default', compileDefaultWorkflow(definition), { track, executionModel })
}

const localeOption = (options: LegacyInitOptions): Pick<LegacyChangeSpec, 'documentLocale'> =>
  options.documentLocale === undefined ? {} : { documentLocale: options.documentLocale }

/**
 * 升级前创建的 default 任务：快照记着 phase-manifest（阶段清单）计划，定义取自升级前（f474225f）的 default
 * 原文（`tools/fixtures/legacy-default-workflow.yaml`），带 `document_contract`，所以是契约模式。
 */
export async function initLegacyDefaultChange(
  deps: CliDeps,
  cwd: string,
  name: string,
  track: string,
  preset: string,
  options: LegacyDefaultOptions = {},
): Promise<number> {
  const plan = legacyDefaultChangePlan(track, 'phase-manifest', options.definition)
  return initLegacyChange(deps, cwd, name, preset, { plan, track, ...localeOption(options) })
}

/**
 * 升级前创建、带文档契约的 default 任务，但已经是 step-graph 执行（现行引擎）：测契约本身（scaffold / record /
 * 按 kind 读取 / `pending_documents` / `register-field`）的集成测试用它，断言与升级前逐字相同。
 */
export async function initLegacyContractDefaultChange(
  deps: CliDeps,
  cwd: string,
  name: string,
  track: string,
  preset: string,
  options: LegacyDefaultOptions = {},
): Promise<number> {
  const plan = legacyDefaultChangePlan(track, 'step-graph', options.definition)
  return initLegacyChange(deps, cwd, name, preset, { plan, track, ...localeOption(options) })
}

/**
 * 升级前创建、定义里带已删除的键（`inputs` / `outputs` / `artifacts` / `document_contract`）的自定义 workflow 任务：
 * 定义解析后不经 `validateWorkflow` 直接编译、冻结进快照，其后命令按冻结的快照行事，不再读项目里的 YAML。
 * 平铺工作流的轨道是与工作流同名的隐式轨道（同 `tenon init`）。
 */
export async function initLegacyWorkflowChange(
  deps: CliDeps,
  cwd: string,
  name: string,
  source: string,
  options: LegacyInitOptions & { readonly track?: string; readonly preset: string },
): Promise<number> {
  const definition = parseWorkflow(source)
  const track = options.track ?? definition.name
  const plan = effectiveWorkflowPlanFromIr(definition.name, compileWorkflow(definition), { track, executionModel: 'step-graph' })
  return initLegacyChange(deps, cwd, name, options.preset, { plan, track, ...localeOption(options) })
}

/** 升级前创建的 standard 任务：平铺工作流、step-graph 执行模型、轨道 standard，定义取自已退役模板的原文。 */
export async function initLegacyStandardChange(
  deps: CliDeps,
  cwd: string,
  name: string,
  preset: string,
): Promise<number> {
  return initLegacyChange(deps, cwd, name, preset, {
    plan: compileEffectiveWorkflowPlan('standard', parseWorkflow(LEGACY_STANDARD_WORKFLOW_YAML), {
      track: 'standard', executionModel: 'step-graph',
    }),
    track: 'standard',
  })
}
