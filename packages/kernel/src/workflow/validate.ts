import { compileDefaultWorkflow, compileWorkflow } from './compile.js'
import { validateDefaultWorkflowStructure, validateDocumentContract } from './document-contract.js'
import { isDefaultWorkflowName, isValidWorkflowName } from './identifier.js'
import { WorkflowTrackBranchError } from './track-branch-error.js'
import type { WorkflowDef, StepDef, WorkflowDocumentContractV1 } from './types.js'
export { WorkflowTrackBranchError } from './track-branch-error.js'

function detectCycle(skillIds: string[], dependsOn: Map<string, string[]>): string[] {
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map(skillIds.map((id) => [id, WHITE]))
  const errors: string[] = []

  function visit(id: string, path: string[]): void {
    color.set(id, GRAY)
    for (const dep of dependsOn.get(id) ?? []) {
      if (color.get(dep) === GRAY) {
        errors.push(`循环依赖：${[...path, id, dep].join(' -> ')}`)
        continue
      }
      if (color.get(dep) === WHITE) visit(dep, [...path, id])
    }
    color.set(id, BLACK)
  }

  for (const id of skillIds) {
    if (color.get(id) === WHITE) visit(id, [])
  }
  return errors
}

// G16：serialize 原样写出、parse 用 (\S+) 读回的每一类标识符，字符集越出这个范围就可能
// 「保存成功、下次打不开」（如含空格）。与 dashboard 客户端表单、server 路由层 name 校验
// 同一条规则；此处是绕过 UI 直调已鉴权 HTTP 时的唯一服务端后盾。
const IDENT_RE = /^[a-zA-Z0-9_-]+$/
/**
 * skill id 允许命名空间冒号（插件 skill 如 `superpowers:brainstorming`、`commit-commands:commit`）。
 * skill-tracker.sh 落的是命名空间全名、internal-skill-gate 按全名匹配 step.skills[].id——workflow 必须能
 * 声明带冒号的 skill id。parse.ts 用 `\S+` 本就接受冒号,validate 此前用 IDENT_RE 拒绝致两处不一致,自定义
 * workflow 无法 gate 占多数的命名空间 skill（superpowers、commit-commands 等插件下的 skill）。`plugin:skill` 形态,
 * 每段仍是 IDENT_RE 字符集,允许多级（`a:b:c`）以防未来更深命名空间。
 */
const SKILL_IDENT_RE = /^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*$/

interface WorkflowBranch {
  readonly track: string
  readonly label?: string
  readonly documentContract?: WorkflowDocumentContractV1
  readonly steps: readonly StepDef[]
}

/** 有 tracks 的工作流：分支 = 每条 track（key = track id，契约取分支自己的）；否则只有单条 pipeline（key ''）。 */
export function workflowBranches(wf: WorkflowDef): ReadonlyArray<WorkflowBranch> {
  const tracks = Object.entries(wf.tracks ?? {})
  if (tracks.length === 0) {
    return [{ track: '', ...(wf.documentContract === undefined ? {} : { documentContract: wf.documentContract }), steps: wf.steps }]
  }
  return tracks.map(([track, branch]) => ({
    track,
    ...(branch.label === undefined ? {} : { label: branch.label }),
    ...(branch.documentContract === undefined ? {} : { documentContract: branch.documentContract }),
    steps: branch.steps,
  }))
}

/** 单条分支 → 单 pipeline 定义：分支的 steps 与文档契约提到顶层，tracks 去掉。 */
function branchDefinition(wf: WorkflowDef, branch: WorkflowBranch): WorkflowDef {
  const { tracks: _tracks, documentContract: _documentContract, ...rest } = wf
  return {
    ...rest,
    ...(branch.documentContract === undefined ? {} : { documentContract: branch.documentContract }),
    steps: branch.steps,
  }
}

/**
 * 按 change 的 track 选中分支（结果不再携带 tracks，分支契约提到顶层）：
 * 有 tracks → 命中该分支；未给 track（无轨道语境：指纹 / 文档策略 / 生成器）→ 第一条分支；给了却没有 → 抛错，不兜底。
 * 无 tracks → 顶层 steps 与顶层契约。
 */
export function selectTrackBranch(wf: WorkflowDef, track: string | undefined): WorkflowDef {
  const branches = workflowBranches(wf)
  const branch = Object.keys(wf.tracks ?? {}).length === 0 || track === undefined || track === ''
    ? branches[0]
    : branches.find((candidate) => candidate.track === track)
  if (branch === undefined) throw new WorkflowTrackBranchError(wf.name, track ?? '')
  return branchDefinition(wf, branch)
}

export function validateWorkflow(
  wf: WorkflowDef,
  options: { readonly origin?: 'custom' | 'default' } = {},
): string[] {
  const errors: string[] = []
  if (!isValidWorkflowName(wf.name)) {
    errors.push(`workflow name '${wf.name}' 含非法字符（允许中文、字母、数字、- 与 _；不允许空格、点或路径符号）`)
  }
  if (Object.keys(wf.tracks ?? {}).length > 0 && wf.steps.length > 0) {
    errors.push('有 tracks 时不得再声明顶层 steps（每条轨道各写自己的阶段）')
  }
  if (Object.keys(wf.tracks ?? {}).length > 0 && wf.documentContract !== undefined) {
    errors.push('有 tracks 时 document_contract 写在 tracks.<id> 下')
  }
  for (const branch of workflowBranches(wf)) {
    const prefix = branch.track === '' ? '' : `tracks.${branch.track}: `
    if (branch.track !== '' && !/^[a-z][a-z0-9_-]{0,31}$/.test(branch.track)) {
      errors.push(`tracks 分支 id '${branch.track}' 非法（小写字母开头，仅 a-z0-9_-，≤32）`)
    }
    if (branch.track !== '' && branch.steps.length === 0) errors.push(`${prefix}分支至少要有一个阶段`)
    errors.push(...validateBranchSteps(branchDefinition(wf, branch), options).map((error) => `${prefix}${error}`))
  }
  return errors
}

function validateBranchSteps(
  wf: WorkflowDef,
  options: { readonly origin?: 'custom' | 'default' },
): string[] {
  const errors: string[] = []
  const producedByEarlierStep = new Set<string>()
  const allStepIds = new Set(wf.steps.map((s) => s.id))
  // 测试 id 在整条分支内唯一：`tenon test run <change> <id>` 只给 id，跨步骤重名就无从定位。
  const testOwner = new Map<string, string>()

  wf.steps.forEach((step) => {
    if (!IDENT_RE.test(step.id)) {
      errors.push(`step id '${step.id}' 含非法字符（仅允许 a-zA-Z0-9_-）`)
    }
    for (const lane of step.reviewLanes ?? []) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(lane)) {
        errors.push(`step '${step.id}' 的 Review lane '${lane}' 含非法字符`)
      }
    }
    for (const skill of step.skills) {
      if (!SKILL_IDENT_RE.test(skill.id)) {
        errors.push(`step '${step.id}' 的 skill id '${skill.id}' 含非法字符（仅允许 a-zA-Z0-9_- 及命名空间冒号，如 superpowers:brainstorming）`)
      }
    }
    for (const ref of [...step.inputs, ...step.outputs]) {
      if (!IDENT_RE.test(ref.field)) {
        errors.push(`step '${step.id}' 的字段 '${ref.field}' 含非法字符（仅允许 a-zA-Z0-9_-）`)
      }
    }
    for (const test of step.tests ?? []) {
      const owner = testOwner.get(test.id)
      if (owner !== undefined) {
        errors.push(`测试 id '${test.id}' 在分支内重复（step '${owner}' 与 '${step.id}'）`)
        continue
      }
      testOwner.set(test.id, step.id)
    }
    const transitionEvents = new Set<string>()
    for (const t of step.transitions) {
      if (!IDENT_RE.test(t.event)) {
        errors.push(`step '${step.id}' 的 transitions 里 event '${t.event}' 含非法字符（仅允许 a-zA-Z0-9_-）`)
      }
      if (transitionEvents.has(t.event)) {
        errors.push(`step '${step.id}' 的 transitions 重复声明 event '${t.event}'`)
      }
      transitionEvents.add(t.event)
    }
    const skillIds = step.skills.map((s) => s.id)
    const dependsOn = new Map(step.skills.map((s) => [s.id, [...(s.depends_on ?? [])]]))

    for (const skill of step.skills) {
      for (const dep of skill.depends_on ?? []) {
        if (!skillIds.includes(dep)) {
          errors.push(`step '${step.id}' 的 skill '${skill.id}' 依赖了同 step 内不存在的 '${dep}'`)
        }
      }
    }
    errors.push(...detectCycle(skillIds, dependsOn).map((e) => `step '${step.id}': ${e}`))

    for (const input of step.inputs) {
      if (!producedByEarlierStep.has(input.field)) {
        errors.push(`step '${step.id}' 的 inputs 字段 '${input.field}' 不对应任何更早 step 的 outputs`)
      }
    }
    for (const output of step.outputs) producedByEarlierStep.add(output.field)

    // 每条 transition 的 to 必须指向同一 workflow 里真实存在的 step id——否则
    // tenon transition 在真运行时才会发现走不到，属于本该在保存时就拦下的错误。
    for (const t of step.transitions) {
      if (!allStepIds.has(t.to)) {
        errors.push(`step '${step.id}' 的 transitions 里 event '${t.event}' 的 to '${t.to}' 不存在`)
      }
    }

  })

  // A workflow may have multiple explicit terminal nodes (for example done and escalated). The
  // real structural error is an unreachable node, not a terminal's array position.
  if (wf.steps.length > 0) {
    const entryStep = wf.steps[0]
    if (!entryStep) return errors
    const reachable = new Set<string>()
    const queue = [entryStep.id]
    while (queue.length > 0) {
      const id = queue.shift()
      if (id === undefined) break
      if (reachable.has(id)) continue
      reachable.add(id)
      const step = wf.steps.find((candidate) => candidate.id === id)
      for (const transition of step?.transitions ?? []) {
        if (allStepIds.has(transition.to) && !reachable.has(transition.to)) queue.push(transition.to)
      }
    }
    for (const step of wf.steps) {
      if (!reachable.has(step.id)) errors.push(`step '${step.id}' 从首 step '${entryStep.id}' 不可达`)
    }
  }

  errors.push(...validateDocumentContract(wf, options))

  // 深校验（G2 P2）：复用 compileWorkflow 做新 guard/action 变体 + FIELD_ORDER 字段闭集 + 列表
  // 字段互斥 + artifact 形状的结构校验——不在本文件再抄一份闭集判定，避免与编译器漂移。
  // compileWorkflow 是 fail-loud 首错即抛；本层是收集式校验，故 try/catch 收编为一条错误、追加
  // 在既有图/标识符校验之后（既有错误恒先收齐，不被 compile 首错抢断），loadWorkflow 据此拒含
  // 畸形新字段的文件。合法 workflow 编译无错 → 不追加，行为逐字不变。
  try {
    if (options.origin === 'default') compileDefaultWorkflow(wf)
    else compileWorkflow(wf)
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e))
  }

  return errors
}

/**
 * 存储边界校验（文件 / HTTP 写入）：在 validateWorkflow 之上，存储键为 'default' 的定义还必须保住
 * 七阶段骨架（顺序 / 流转 / 评审门禁 / 运行时字段）——项目覆盖文件替代内建模板参与 phase-manifest 运行，
 * 骨架一破运行时就无所依凭。compileEffectiveWorkflowPlan 等内存入口不走本函数（测试夹具可用精简 default）。
 */
export function validateWorkflowForStorage(name: string, wf: WorkflowDef): string[] {
  const origin = isDefaultWorkflowName(name) ? 'default' : 'custom'
  const errors = validateWorkflow(wf, { origin })
  if (isDefaultWorkflowName(origin)) {
    if (wf.openspec !== true) errors.push('default 必须保持 openspec: true')
    for (const branch of workflowBranches(wf)) {
      const prefix = branch.track === '' ? '' : `tracks.${branch.track}: `
      errors.push(...validateDefaultWorkflowStructure(branchDefinition(wf, branch)).map((error) => `${prefix}${error}`))
    }
  }
  return errors
}
