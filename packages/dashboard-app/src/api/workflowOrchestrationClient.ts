/**
 * 编排总览的两个读端点：工作流定义（`GET /api/workflows/:name/orchestration`）与任务冻结计划
 * （`GET /api/change/:name/orchestration`）。响应先过运行时解码，形状不对就当错误，不猜。
 */
import type {
  OrchestrationEntry, OrchestrationFlow, OrchestrationKind, OrchestrationReturn, OrchestrationSource,
} from '@tenon/kernel/workflow/orchestration'
import type { WbEffectiveIo } from './governanceTypes'
import { decodeEffectiveIo } from './governanceSchema'
import { ApiError, isRecord, readJson, stringArray, throwApiError, wrapNetwork } from './transport'

/** 工作台节点的四态：运行中 / 完成 / 等待 / 失败。 */
export type RunStatus = 'running' | 'done' | 'waiting' | 'failed'

export interface FlowEntry extends OrchestrationEntry {
  readonly status?: RunStatus
}

export interface FlowStage {
  readonly id: string
  readonly label: string
  readonly gate: 'review' | 'auto' | null
  readonly entries: readonly FlowEntry[]
}

export interface FlowOrchestration {
  readonly stages: readonly FlowStage[]
  readonly returns: readonly OrchestrationReturn[]
  readonly flows: readonly OrchestrationFlow[]
}

export interface DefinitionOrchestration extends FlowOrchestration {
  readonly workflow: string
  readonly track: string | null
  /** 每步 manifest 叠加的必需技能 token；画草稿时并入声明技能。 */
  readonly overlay: Readonly<Record<string, readonly string[]>>
}

export interface ChangeOrchestration extends FlowOrchestration {
  readonly change: string
  readonly workflow: string
  readonly track: string | null
  readonly current: string
  readonly io: WbEffectiveIo
}

const KINDS: readonly OrchestrationKind[] = ['executor', 'skill', 'test', 'reviewer']
const SOURCES: readonly OrchestrationSource[] = ['declared', 'openspec', 'manifest']
const STATUSES: readonly RunStatus[] = ['running', 'done', 'waiting', 'failed']

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.some((candidate) => candidate === value)
}

function decodeEntry(value: unknown, withStatus: boolean): FlowEntry | null {
  if (!isRecord(value) || !oneOf(value.kind, KINDS) || typeof value.id !== 'string' || typeof value.label !== 'string'
    || typeof value.wave !== 'number' || !Number.isInteger(value.wave) || value.wave < 0 || !stringArray(value.dependsOn)
    || typeof value.required !== 'boolean' || !oneOf(value.source, SOURCES)) return null
  if (withStatus && !oneOf(value.status, STATUSES)) return null
  return {
    kind: value.kind,
    id: value.id,
    label: value.label,
    wave: value.wave,
    dependsOn: [...value.dependsOn],
    required: value.required,
    source: value.source,
    ...(withStatus && oneOf(value.status, STATUSES) ? { status: value.status } : {}),
  }
}

function decodeStage(value: unknown, withStatus: boolean): FlowStage | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.label !== 'string'
    || (value.gate !== null && value.gate !== 'review' && value.gate !== 'auto') || !Array.isArray(value.entries)) return null
  const entries: FlowEntry[] = []
  for (const raw of value.entries) {
    const entry = decodeEntry(raw, withStatus)
    if (entry === null) return null
    entries.push(entry)
  }
  return { id: value.id, label: value.label, gate: value.gate, entries }
}

function decodeReturn(value: unknown): OrchestrationReturn | null {
  if (!isRecord(value) || typeof value.from !== 'string' || typeof value.to !== 'string' || typeof value.event !== 'string') return null
  return { from: value.from, to: value.to, event: value.event }
}

function decodeFlow(value: unknown): OrchestrationFlow | null {
  if (!isRecord(value) || (value.slot !== 'document' && value.slot !== 'field') || typeof value.id !== 'string'
    || typeof value.from !== 'string' || !stringArray(value.producers) || !stringArray(value.to)) return null
  return { slot: value.slot, id: value.id, from: value.from, producers: [...value.producers], to: [...value.to] }
}

function decodeList<T>(value: unknown, decode: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null
  const out: T[] = []
  for (const item of value) {
    const decoded = decode(item)
    if (decoded === null) return null
    out.push(decoded)
  }
  return out
}

function decodeBase(value: Record<string, unknown>, withStatus: boolean): FlowOrchestration | null {
  const stages = decodeList(value.stages, (item) => decodeStage(item, withStatus))
  const returns = decodeList(value.returns, decodeReturn)
  const flows = decodeList(value.flows, decodeFlow)
  if (stages === null || returns === null || flows === null) return null
  return { stages, returns, flows }
}

export function decodeDefinitionOrchestration(value: unknown): DefinitionOrchestration | null {
  if (!isRecord(value) || typeof value.workflow !== 'string' || (value.track !== null && typeof value.track !== 'string') || !isRecord(value.overlay)) return null
  const base = decodeBase(value, false)
  if (base === null) return null
  const overlay: Record<string, readonly string[]> = {}
  for (const [step, tokens] of Object.entries(value.overlay)) {
    if (!stringArray(tokens)) return null
    overlay[step] = [...tokens]
  }
  return { ...base, workflow: value.workflow, track: value.track, overlay }
}

export function decodeChangeOrchestration(value: unknown): ChangeOrchestration | null {
  if (!isRecord(value) || typeof value.change !== 'string' || typeof value.workflow !== 'string'
    || (value.track !== null && typeof value.track !== 'string') || typeof value.current !== 'string') return null
  const base = decodeBase(value, true)
  const io = decodeEffectiveIo(value.io)
  if (base === null || io === null) return null
  return { ...base, change: value.change, workflow: value.workflow, track: value.track, current: value.current, io }
}

async function getDecoded<T>(url: string, decode: (value: unknown) => T | null, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' }, signal })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwApiError(response, '编排读取失败')
  const decoded = decode(await readJson(response))
  if (decoded === null) throw new ApiError('invalid response', response.status)
  return decoded
}

export function fetchWorkflowOrchestration(name: string, root: string, track: string | null, signal?: AbortSignal): Promise<DefinitionOrchestration> {
  const params = new URLSearchParams({ root })
  if (track !== null && track !== '') params.set('track', track)
  return getDecoded(`/api/workflows/${encodeURIComponent(name)}/orchestration?${params.toString()}`, decodeDefinitionOrchestration, signal)
}

export function fetchChangeOrchestration(change: string, root: string, signal?: AbortSignal): Promise<ChangeOrchestration> {
  const params = new URLSearchParams({ root })
  return getDecoded(`/api/change/${encodeURIComponent(change)}/orchestration?${params.toString()}`, decodeChangeOrchestration, signal)
}
