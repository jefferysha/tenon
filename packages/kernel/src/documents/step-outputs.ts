/**
 * 步骤产出的应用层（设计「模块与接缝」）：转换在锁内调用它记录产出与校验读取，status / Dashboard / 守卫只读它的视图。
 *
 * 写入口（startStepVisit / recordStepExit / recordInputReads）都是账本的读-改-写，调用方必须已持有任务锁。
 * 观察问题（非 git、git 失败、改动过多）一律降级为 unavailable / truncated，不抛给转换；
 * 账本损坏、run 状态损坏这类 Tenon 自己的状态问题照实抛出，不当作「没有产出」悄悄覆盖。
 */
import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { readSkillInvocationEventsForApplication } from '../skill-invocation/repository.js'
import { readCurrentRunRevision } from '../state/run-revision-store.js'
import {
  MAX_VISIT_OUTPUTS,
  MAX_VISIT_READS,
  readStepOutputLedger,
  upsertVisit,
  writeStepOutputLedger,
  type StepInputRead,
  type StepObservation,
  type StepOutputLedger,
  type StepOutputRecord,
  type StepVisitRecord,
} from '../state/step-output-ledger.js'
import {
  captureCheckpoint,
  compareCheckpoint,
  isObservedPath,
  workingFileShas,
  type FileChange,
  type StepCheckpoint,
} from '../workspace/step-checkpoint.js'
import {
  attributeSkill,
  handoffInputs,
  isInputRead,
  matchesOutputPattern,
  staticPatternDirectory,
  validateOutputPattern,
  type HandoffInput,
  type SkillLoad,
} from './step-outputs-model.js'

export interface StepOutputsContext { readonly root: string; readonly changeDir: string; readonly change: string }
export interface StepVisitRef { readonly runId: string; readonly sequence: number; readonly step: string }
export interface StepInputView extends HandoffInput { readonly read: boolean }
export interface StepIoView { readonly inputs: readonly StepInputView[]; readonly outputs: readonly StepOutputRecord[] }
export interface StepOutputsView {
  readonly visit: StepVisitRef | null
  readonly observation: StepObservation
  readonly inputs: readonly StepInputView[]
  readonly outputs: readonly StepOutputRecord[]
  /** 每个步骤最近一次访问的输入输出（当前步骤用实时比较）。 */
  readonly steps: Readonly<Record<string, StepIoView>>
  /** 本 run 里每个步骤产出过（新增或修改）且现在存在的路径。 */
  readonly produced: Readonly<Record<string, readonly string[]>>
}

const SCAN_ENTRY_LIMIT = 10_000

/** 项目根是任务目录（<root>/openspec/changes/<change>）往上三级。 */
export function stepOutputsContextFor(changeDir: string): StepOutputsContext {
  const resolved = resolve(changeDir)
  return { root: resolve(resolved, '..', '..', '..'), changeDir, change: basename(resolved) }
}

const sameVisit = (visit: StepVisitRecord, ref: { readonly runId: string; readonly sequence: number }): boolean =>
  visit.run_id === ref.runId && visit.sequence === ref.sequence

/** 账本里这次访问的记录；步骤对不上说明状态被手改过，那条记录不可信，当作没有。 */
const recordOf = (ledger: StepOutputLedger, ref: StepVisitRef): StepVisitRecord | undefined =>
  ledger.visits.find((visit) => sameVisit(visit, ref) && visit.step === ref.step)

const newVisit = (ref: StepVisitRef, at: string, checkpoint: StepCheckpoint | null): StepVisitRecord => ({
  run_id: ref.runId, sequence: ref.sequence, step: ref.step, entered_at: at, checkpoint, exit: null, outputs: [], reads: [],
})

async function currentVisitOf(ctx: StepOutputsContext): Promise<StepVisitRef | null> {
  const revision = await readCurrentRunRevision(ctx.changeDir)
  const metadata = revision?.state.runMetadata
  const phase = revision?.state.fields.phase
  if (metadata === undefined || typeof phase !== 'string' || phase === '') return null
  return { runId: metadata.runId, sequence: metadata.transitionSequence, step: phase }
}

/** 本次访问里加载过的技能；技能证据读不了就当没有加载记录（来源记未知），不挡转换。 */
async function skillLoads(ctx: StepOutputsContext, ref: StepVisitRef): Promise<SkillLoad[]> {
  try {
    return (await readSkillInvocationEventsForApplication(ctx.changeDir)).flatMap((event) =>
      event.type === 'invocation-started'
        && event.subject.step_visit.run_id === ref.runId
        && event.subject.step_visit.transition_sequence === ref.sequence
        ? [{ skill: event.payload.skill.id, at: event.recorded_at }]
        : [])
  } catch {
    return []
  }
}

async function modifiedAt(root: string, path: string): Promise<number> {
  try { return (await lstat(join(root, path))).mtimeMs } catch { return Number.NaN }
}

async function toOutputRecords(ctx: StepOutputsContext, ref: StepVisitRef, changes: readonly FileChange[]): Promise<StepOutputRecord[]> {
  const loads = changes.some((change) => change.change !== 'deleted') ? await skillLoads(ctx, ref) : []
  return Promise.all(changes.map(async (change) => ({
    path: change.path,
    change: change.change,
    sha256: change.sha256,
    skill: change.change === 'deleted' ? null : attributeSkill(await modifiedAt(ctx.root, change.path), loads),
  })))
}

async function freshCheckpoint(ctx: StepOutputsContext): Promise<StepCheckpoint | null> {
  const capture = await captureCheckpoint(ctx.root, ctx.change)
  return capture.kind === 'captured' ? capture.checkpoint : null
}

/** 开始一次步骤访问（`tenon init` 与转换调用）：写检查点；采集不到就记没有检查点，离开时按 unavailable 处理。 */
export async function startStepVisit(ctx: StepOutputsContext, visit: StepVisitRef, at: string): Promise<void> {
  const checkpoint = await freshCheckpoint(ctx)
  const ledger = await readStepOutputLedger(ctx.changeDir)
  await writeStepOutputLedger(ctx.changeDir, upsertVisit(ledger, newVisit(visit, at, checkpoint)))
}

interface Observed {
  readonly observation: StepObservation
  readonly outputs: readonly StepOutputRecord[]
  /** 比较时顺带采到的当前检查点，可直接作为下一次访问的起点。 */
  readonly next: StepCheckpoint | null
}

/** 与检查点比较的结果落成账本里的产出与观察状态；超过单次访问上限的截断并记 truncated。 */
async function observeExit(ctx: StepOutputsContext, ref: StepVisitRef, checkpoint: StepCheckpoint | null): Promise<Observed> {
  if (checkpoint === null) return { observation: 'unavailable', outputs: [], next: null }
  const result = await compareCheckpoint(ctx.root, ctx.change, checkpoint)
  if (result.kind !== 'observed') return { observation: result.kind, outputs: [], next: null }
  return {
    observation: result.changes.length > MAX_VISIT_OUTPUTS ? 'truncated' : 'observed',
    outputs: await toOutputRecords(ctx, ref, result.changes.slice(0, MAX_VISIT_OUTPUTS)),
    next: result.current,
  }
}

/**
 * 离开一次步骤访问（转换在所有门禁通过之后、提交之前调用）：比较得到产出、标注来源、写离开记录，并为下一次访问
 * （sequence + 1，步骤 = to）开始新的检查点。按访问身份幂等：提交失败后重试，已离开的访问保留首次算出的产出，
 * 只按这次的事件与目标步骤改写离开记录和下一次访问的步骤（检查点在离开时已清空，无法重算）。
 */
export async function recordStepExit(
  ctx: StepOutputsContext,
  exit: StepVisitRef & { readonly event: string; readonly to: string; readonly at: string },
): Promise<void> {
  const ledger = await readStepOutputLedger(ctx.changeDir)
  const existing = recordOf(ledger, exit)
  const nextRef: StepVisitRef = { runId: exit.runId, sequence: exit.sequence + 1, step: exit.to }
  const stored = ledger.visits.find((visit) => sameVisit(visit, nextRef))
  let exited: StepVisitRecord
  let next: StepVisitRecord
  if (existing !== undefined && existing.exit !== null) {
    exited = { ...existing, exit: { ...existing.exit, event: exit.event, to: exit.to, at: exit.at } }
    next = stored === undefined ? newVisit(nextRef, exit.at, await freshCheckpoint(ctx)) : { ...stored, step: exit.to }
  } else {
    const observed = await observeExit(ctx, exit, existing?.checkpoint ?? null)
    exited = {
      run_id: exit.runId, sequence: exit.sequence, step: exit.step, entered_at: existing?.entered_at ?? exit.at, checkpoint: null,
      exit: { event: exit.event, to: exit.to, at: exit.at, observation: observed.observation },
      outputs: observed.outputs, reads: existing?.reads ?? [],
    }
    next = newVisit(nextRef, exit.at, observed.next ?? await freshCheckpoint(ctx))
  }
  await writeStepOutputLedger(ctx.changeDir, upsertVisit(upsertVisit(ledger, exited), next))
}

interface ResolvedInput { readonly input: HandoffInput; readonly currentSha: string }

/** 直接上游交接来的文档；文件已经不存在的不列入（读取永远做得到，不会因为输入被删而卡死）。 */
async function resolveInputs(ctx: StepOutputsContext, ledger: StepOutputLedger, runId: string, sequence: number): Promise<ResolvedInput[]> {
  const inputs = handoffInputs(ledger, runId, sequence)
  const shas = await workingFileShas(ctx.root, inputs.map((input) => input.path))
  return inputs.flatMap((input, index) => {
    const currentSha = shas[index]
    return typeof currentSha === 'string' ? [{ input, currentSha }] : []
  })
}

const toInputViews = (resolved: readonly ResolvedInput[], visit: StepVisitRecord | undefined): StepInputView[] =>
  resolved.map(({ input, currentSha }) => ({ ...input, read: isInputRead(input, visit?.reads ?? [], currentSha) }))

/** 当前访问的产出与观察状态。`live` 才与检查点实时比较；已离开（提交失败后重试）的访问直接用账本里记下的。 */
async function currentOutputs(
  ctx: StepOutputsContext,
  ref: StepVisitRef,
  record: StepVisitRecord | undefined,
  live: boolean,
): Promise<{ readonly observation: StepObservation; readonly outputs: readonly StepOutputRecord[] }> {
  if (record === undefined) return { observation: 'unavailable', outputs: [] }
  if (record.exit !== null) return { observation: record.exit.observation, outputs: record.outputs }
  if (record.checkpoint === null) return { observation: 'unavailable', outputs: [] }
  if (!live) return { observation: 'observed', outputs: [] }
  const { observation, outputs } = await observeExit(ctx, ref, record.checkpoint)
  return { observation, outputs }
}

async function existingFiles(root: string, paths: ReadonlySet<string>): Promise<Set<string>> {
  const present = await Promise.all([...paths].map(async (path) => {
    try {
      const entry = await lstat(join(root, path))
      return entry.isFile() || entry.isSymbolicLink() ? path : null
    } catch { return null }
  }))
  return new Set(present.flatMap((path) => (path === null ? [] : [path])))
}

/** 只读视图：当前访问的观察状态、交接输入（含已读）、产出，以及每个步骤最近一次访问的输入输出和产出过的路径。 */
export async function readStepOutputs(ctx: StepOutputsContext, options: { readonly live: boolean }): Promise<StepOutputsView> {
  const ledger = await readStepOutputLedger(ctx.changeDir)
  const ref = await currentVisitOf(ctx)
  if (ref === null) return { visit: null, observation: 'unavailable', inputs: [], outputs: [], steps: {}, produced: {} }
  const record = recordOf(ledger, ref)
  const current = await currentOutputs(ctx, ref, record, options.live)
  const inputs = toInputViews(await resolveInputs(ctx, ledger, ref.runId, ref.sequence), record)
  // 只看本 run 里已经发生的访问：提交失败的重试可能让账本里已有「下一次访问」，它还没有真正开始。
  const happened = ledger.visits.filter((visit) => visit.run_id === ref.runId && visit.sequence <= ref.sequence)
  const latest = new Map<string, StepVisitRecord>()
  for (const visit of happened) {
    const known = latest.get(visit.step)
    if (known === undefined || visit.sequence > known.sequence) latest.set(visit.step, visit)
  }
  const steps = new Map<string, StepIoView>()
  for (const [step, visit] of latest) {
    if (step === ref.step) continue // 当前步骤用上面算好的实时结果
    steps.set(step, { inputs: toInputViews(await resolveInputs(ctx, ledger, ref.runId, visit.sequence), visit), outputs: visit.outputs })
  }
  steps.set(ref.step, { inputs, outputs: current.outputs })
  const producedPaths = new Map<string, Set<string>>()
  const collect = (step: string, outputs: readonly StepOutputRecord[]): void => {
    const paths = producedPaths.get(step) ?? new Set<string>()
    for (const output of outputs) if (output.change !== 'deleted') paths.add(output.path)
    producedPaths.set(step, paths)
  }
  for (const visit of happened) collect(visit.step, visit.outputs)
  collect(ref.step, current.outputs)
  const present = await existingFiles(ctx.root, new Set([...producedPaths.values()].flatMap((paths) => [...paths])))
  const produced = [...producedPaths].map(([step, paths]): [string, string[]] => [step, [...paths].filter((path) => present.has(path)).sort()])
  return {
    visit: ref,
    observation: current.observation,
    inputs,
    outputs: current.outputs,
    steps: Object.fromEntries(steps),
    produced: Object.fromEntries(produced.filter(([, paths]) => paths.length > 0)),
  }
}

export function unreadInputs(view: StepOutputsView): readonly StepInputView[] {
  return view.inputs.filter((input) => !input.read)
}

/** 当前访问的交接输入加上本访问写过的读取回执（回执摘要不折叠成已读布尔，Context Bundle 要逐个核对摘要）。 */
export interface StepHandoffView {
  /** 当前步骤；任务缺 run 状态时为 null（此时没有输入）。 */
  readonly step: string | null
  readonly inputs: readonly HandoffInput[]
  readonly reads: readonly StepInputRead[]
}

/** 只读：不做实时比较，只取直接上游交接来的、现在仍存在的文档和本访问的读取回执。 */
export async function readStepHandoff(ctx: StepOutputsContext): Promise<StepHandoffView> {
  const ledger = await readStepOutputLedger(ctx.changeDir)
  const ref = await currentVisitOf(ctx)
  if (ref === null) return { step: null, inputs: [], reads: [] }
  const resolved = await resolveInputs(ctx, ledger, ref.runId, ref.sequence)
  return { step: ref.step, inputs: resolved.map(({ input }) => input), reads: recordOf(ledger, ref)?.reads ?? [] }
}

/**
 * 写读取回执（`tenon document read` 调用）：对当前内容取 sha256 记进当前访问。`'all'` = 当前所有交接输入；
 * 单个路径必须是交接输入。同路径同摘要不重复记；回执超过上限时丢最旧的。返回本次覆盖到的输入路径。
 */
export async function recordInputReads(ctx: StepOutputsContext, target: 'all' | string, at: string): Promise<readonly string[]> {
  const ref = await currentVisitOf(ctx)
  if (ref === null) throw new Error('没有可读取输入的当前步骤访问：任务缺少 run 状态')
  const ledger = await readStepOutputLedger(ctx.changeDir)
  const record = recordOf(ledger, ref) ?? newVisit(ref, at, null)
  const resolved = await resolveInputs(ctx, ledger, ref.runId, ref.sequence)
  const picked = target === 'all' ? resolved : resolved.filter(({ input }) => input.path === target)
  if (target !== 'all' && picked.length === 0) throw new Error(`${target} 不是本步的交接输入`)
  const fresh = picked.filter(({ input, currentSha }) => !record.reads.some((read) => read.path === input.path && read.sha256 === currentSha))
  if (fresh.length > 0) {
    const reads = [...record.reads, ...fresh.map(({ input, currentSha }) => ({ path: input.path, sha256: currentSha, read_at: at }))]
    await writeStepOutputLedger(ctx.changeDir, upsertVisit(ledger, { ...record, reads: reads.slice(-MAX_VISIT_READS) }))
  }
  return picked.map(({ input }) => input.path)
}

/** 观察不可用时的退化判定：在模式的静态前缀目录下有界地找一个匹配的普通文件。 */
async function matchingFileExists(ctx: StepOutputsContext, pattern: string): Promise<boolean> {
  const { directory, exact } = staticPatternDirectory(pattern, ctx.change)
  const start = join(ctx.root, directory)
  try {
    const entry = await lstat(start)
    if (exact) return entry.isFile() && isObservedPath(directory, ctx.change)
    // 起点目录不能是指向项目外的符号链接：只查项目内的文件。
    const rootReal = await realpath(ctx.root)
    const startReal = await realpath(start)
    if (!entry.isDirectory() || (startReal !== rootReal && !startReal.startsWith(`${rootReal}${sep}`))) return false
  } catch {
    return false
  }
  const segments = pattern.split('/').length
  const maxDepth = pattern.split('/').includes('**') ? Number.POSITIVE_INFINITY : segments - (directory === '' ? 0 : directory.split('/').length)
  let seen = 0
  const walk = async (relative: string, depth: number): Promise<boolean> => {
    let entries
    try { entries = await readdir(join(ctx.root, relative), { withFileTypes: true }) } catch { return false }
    for (const entry of entries) {
      seen += 1
      if (seen > SCAN_ENTRY_LIMIT) return false
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        const descend = depth < maxDepth && !entry.name.startsWith('.') && entry.name !== 'node_modules'
        if (descend && await walk(path, depth + 1)) return true
      } else if (entry.isFile() && matchesOutputPattern(pattern, ctx.change, path) && isObservedPath(path, ctx.change)) {
        return true
      }
    }
    return false
  }
  return walk(directory, 1)
}

/**
 * 必须产出是否满足：观察可用时，本 run 里这一步的某次访问产出过匹配的新增 / 修改文件且文件现在还在
 * （回到同一步不要求重写，进入前就有的历史文件不算）；观察不可用时退化为存在匹配的文件。非法模式失败关闭。
 */
export async function requiredOutputSatisfied(ctx: StepOutputsContext, view: StepOutputsView, step: string, pattern: string): Promise<boolean> {
  if (validateOutputPattern(pattern) !== null) return false
  if (view.observation !== 'observed') return matchingFileExists(ctx, pattern)
  const paths = Object.hasOwn(view.produced, step) ? view.produced[step] ?? [] : []
  return paths.some((path) => matchesOutputPattern(pattern, ctx.change, path))
}

/**
 * 守卫与快照用的必须产出判定，结果与对实时视图调 `requiredOutputSatisfied` 相同，但先走不跑 git 的两条捷径：
 * 账本里已离开的访问产出过（文件仍在）就满足；模式下一个匹配的文件都没有就不可能满足。只有两者都定不下来时才调
 * `live` 取当前访问的实时比较。
 */
export async function requiredOutputMet(
  ctx: StepOutputsContext,
  step: string,
  pattern: string,
  live: () => Promise<StepOutputsView>,
): Promise<boolean> {
  if (validateOutputPattern(pattern) !== null) return false
  const recorded = await readStepOutputs(ctx, { live: false })
  if (await requiredOutputSatisfied(ctx, recorded, step, pattern)) return true
  // 观察不可用时上面已按文件存在判定，实时视图同样不可用，结论不变。
  if (recorded.observation !== 'observed' || !await matchingFileExists(ctx, pattern)) return false
  return requiredOutputSatisfied(ctx, await live(), step, pattern)
}
