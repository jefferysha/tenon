/**
 * 编排接口的 `stepIo`：每步的输入、输出与必须产出，两种文档模式同一个形状，Dashboard 只认它。
 *
 * 分流只看冻结计划的 `capabilities.documents.mode`：
 *   · observed（新任务）：Tenon 离开步骤时观察到的真实产出与交接来的输入，读自步骤产出账本（`readStepOutputs`，与
 *     `tenon status`、转换同源）；必须产出 = 该步的 `required-output` 守卫，满足与否交给 `requiredOutputSatisfied`；
 *   · contract（升级前创建的任务）：`.pipeline-documents.json` 的记录按冻结契约归到步骤，没有必须产出。
 *
 * 只读、不加锁。不返回摘要、访问 id、正文或绝对路径——路径一律相对项目根。
 */
import { basename, dirname, join, relative } from 'node:path'
import {
  currentDocumentStepVisitId, DocumentLedgerError, readDocumentLedger, readStepOutputs, requiredOutputSatisfied,
  StepOutputLedgerError, stepRequiredOutputs,
  type DocumentGovernancePolicy, type DocumentKind, type DocumentRecord, type EffectiveWorkflowPlan, type PipelineState,
  type StepOutputsContext, type StepOutputsView,
} from '@tenon/kernel'
import { archivedDocumentPath } from './endedTasks.js'

export interface StepIoFile {
  /** 相对项目根。 */
  readonly path: string
  /** 观察模式：本步对它做了什么；契约模式没有这一项。 */
  readonly change?: 'added' | 'modified' | 'deleted'
  /** 来源技能；推断不出来是 null。 */
  readonly skill: string | null
  /** 输入：它由哪一步产出。 */
  readonly fromStep?: string
  /** 输入：本步是否读过。 */
  readonly read?: boolean
}

export interface StepIoEntry {
  readonly inputs: readonly StepIoFile[]
  readonly outputs: readonly StepIoFile[]
  /** 本步的必须产出（`required-output` 守卫）；契约模式恒为空。 */
  readonly required: readonly { readonly path: string; readonly produced: boolean }[]
}

export type ChangeStepIo = Readonly<Record<string, StepIoEntry>>

export interface ChangeStepIoInput {
  readonly root: string
  readonly changeDir: string
  readonly changeName: string
  readonly plan: EffectiveWorkflowPlan
  readonly state: PipelineState
}

const ARCHIVE_ROOT = join('openspec', 'changes', 'archive')
/** 账本读不了（损坏）时的退路：没有访问记录；修复办法由出口报告里的阻断给出，这里不让整个编排读失败。 */
const UNAVAILABLE_VIEW: StepOutputsView = { visit: null, observation: 'unavailable', inputs: [], outputs: [], steps: {}, produced: {} }
const EMPTY_ENTRY: StepIoEntry = { inputs: [], outputs: [], required: [] }

function scalar(state: PipelineState, field: 'track' | 'phase'): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : value ?? ''
}

/** 已结束任务：整个任务目录搬进了 `openspec/changes/archive/`。 */
const isEnded = (root: string, changeDir: string): boolean => relative(root, dirname(changeDir)) === ARCHIVE_ROOT

/** 已结束任务登记的路径还是搬家前的：改到现在的位置，显示的路径才对得上盘上的文件。 */
const locate = (ended: boolean, changeDir: string) => (path: string): string => (ended ? archivedDocumentPath(path, basename(changeDir)) : path)

/** 计划里的每一步都有条目（还没到的步骤输入输出为空，必须产出照列）。 */
async function entriesOf(plan: EffectiveWorkflowPlan, entryOf: (stepId: string) => Promise<StepIoEntry> | StepIoEntry): Promise<ChangeStepIo> {
  const entries = await Promise.all(plan.workflow.steps.map(async (step): Promise<[string, StepIoEntry]> => [step.id, await entryOf(step.id)]))
  return Object.fromEntries(entries)
}

async function observedStepIo(input: ChangeStepIoInput): Promise<ChangeStepIo> {
  const { plan, state, changeName, changeDir } = input
  const ended = isEnded(input.root, changeDir)
  const ctx: StepOutputsContext = { root: input.root, changeDir, change: changeName }
  let view: StepOutputsView
  try {
    // 已结束任务不与检查点实时比较：它的最后一步早已离开，之后仓库里的改动不是它的产出。
    view = await readStepOutputs(ctx, { live: !ended })
  } catch (error) {
    if (!(error instanceof StepOutputLedgerError)) throw error
    view = UNAVAILABLE_VIEW
  }
  const track = scalar(state, 'track')
  const place = locate(ended, changeDir)
  return entriesOf(plan, async (stepId) => {
    const io = Object.hasOwn(view.steps, stepId) ? view.steps[stepId] : undefined
    // 已结束任务的必须产出不求值：任务目录已搬走，路径模式里的 {change} 对不上，Dashboard 的结束详情只看实际产出。
    const required = ended ? [] : await Promise.all(stepRequiredOutputs(plan, stepId, track).map(async (pattern) => ({
      path: pattern.replaceAll('{change}', changeName),
      produced: await requiredOutputSatisfied(ctx, view, stepId, pattern),
    })))
    return {
      inputs: (io?.inputs ?? []).map((file) => ({ path: place(file.path), skill: file.skill, fromStep: file.fromStep, read: file.read })),
      outputs: (io?.outputs ?? []).map((file) => ({ path: place(file.path), change: file.change, skill: file.skill })),
      required,
    }
  })
}

/** 同一路径登记在多个 kind 下（如 plan 与 superpower-plan）只列一次。 */
function uniqueByPath(files: readonly StepIoFile[]): StepIoFile[] {
  const seen = new Set<string>()
  return files.filter((file) => !seen.has(file.path) && seen.add(file.path))
}

async function contractRecords(changeDir: string): Promise<{ readonly records: readonly DocumentRecord[]; readonly visitId: string | undefined }> {
  let records: readonly DocumentRecord[] = []
  let visitId: string | undefined
  try {
    records = (await readDocumentLedger(changeDir))?.records ?? []
  } catch (error) {
    if (!(error instanceof DocumentLedgerError)) throw error
  }
  try {
    visitId = await currentDocumentStepVisitId(changeDir)
  } catch (error) {
    if (!(error instanceof DocumentLedgerError)) throw error
  }
  return { records, visitId }
}

async function contractStepIo(input: ChangeStepIoInput, policy: DocumentGovernancePolicy | undefined): Promise<ChangeStepIo> {
  const { plan, state, changeDir } = input
  if (policy === undefined) return entriesOf(plan, () => EMPTY_ENTRY)
  const { records, visitId } = await contractRecords(changeDir)
  const phase = scalar(state, 'phase')
  const place = locate(isEnded(input.root, changeDir), changeDir)
  const ownerOf = (kind: DocumentKind): string | undefined =>
    policy.steps.find((stepId) => (policy.outputsByStep[stepId] ?? []).some((requirement) => requirement.kind === kind))
  /** 当前步骤按本次访问的回执判定；其余步骤看有没有在那一步读过当前内容。 */
  const readIn = (record: DocumentRecord, stepId: string): boolean => record.reads.some((receipt) =>
    receipt.phase === stepId
    && receipt.sha256 === record.sha256
    && (stepId !== phase || (visitId !== undefined && receipt.visitId === visitId)))
  return entriesOf(plan, (stepId) => {
    const owned = new Set([...(policy.outputsByStep[stepId] ?? []), ...(policy.mutableByStep[stepId] ?? [])].map((requirement) => requirement.kind))
    const reads = new Set(policy.readsByStep[stepId] ?? [])
    return {
      inputs: uniqueByPath(records.filter((record) => reads.has(record.kind)).map((record) => {
        const fromStep = ownerOf(record.kind)
        return { path: place(record.path), skill: record.producer, ...(fromStep === undefined ? {} : { fromStep }), read: readIn(record, stepId) }
      })),
      outputs: uniqueByPath(records.filter((record) => owned.has(record.kind)).map((record) => ({ path: place(record.path), skill: record.producer }))),
      required: [],
    }
  })
}

export function changeStepIo(input: ChangeStepIoInput): Promise<ChangeStepIo> {
  const documents = input.plan.capabilities.documents
  return documents.mode === 'contract' ? contractStepIo(input, documents.policy) : observedStepIo(input)
}
