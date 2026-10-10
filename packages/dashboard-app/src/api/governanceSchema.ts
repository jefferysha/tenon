import type {
  WbBranchProjection, WbEffectiveIo, WbIoSlot, WbSkillFile, WbSkillFiles, WbStepDef, WbTrackBranch,
  WbWorkflowDef,
} from './governanceTypes'
import {
  allowedKeys, decodeArray, decodeDecompositionPolicy, decodeField, decodeInteractionPolicy,
  decodeSkill, decodeSkillSource, decodeStepAgents, optionalString, record,
} from './governanceBaseDecoders'
import {
  decodeArtifact, decodeDocumentContract, decodeGuard, decodeStepTest, decodeTransition,
} from './governanceRuleDecoders'
import { decodeStepTestPolicy } from './governanceTestPolicyDecoder'

export { decodeSkillsRegistry } from './governanceBaseDecoders'

function decodeStep(value: unknown): WbStepDef | null {
  const step = record(value)
  if (!step || typeof step.id !== 'string' || typeof step.label !== 'string') return null
  if (step.reviewLanes !== undefined) return null
  if (step.gate !== null && step.gate !== 'review' && step.gate !== 'auto') return null
  if (!optionalString(step.prompt)) return null
  // 与 kernel 的 max_rounds 同一取值口径（1–20 的整数）；越界即整份作废，合法值原样保留。
  if (step.maxRounds !== undefined && !(Number.isInteger(step.maxRounds) && (step.maxRounds as number) >= 1 && (step.maxRounds as number) <= 20)) return null
  const skills = decodeArray(step.skills, decodeSkill)
  const inputs = decodeArray(step.inputs, decodeField)
  const outputs = decodeArray(step.outputs, decodeField)
  const artifacts = step.artifacts === undefined ? undefined : decodeArray(step.artifacts, decodeArtifact)
  const tests = step.tests === undefined ? undefined : decodeArray(step.tests, decodeStepTest)
  if (tests === null) return null
  const testPolicy = step.test_policy === undefined ? undefined : decodeStepTestPolicy(step.test_policy)
  if (testPolicy === null) return null
  const agents = step.agents === undefined ? undefined : decodeStepAgents(step.agents)
  if (agents === null) return null
  const guards = decodeArray(step.guards, decodeGuard)
  const transitions = decodeArray(step.transitions, decodeTransition)
  if (skills === null || inputs === null || outputs === null || artifacts === null || guards === null || transitions === null) return null
  return {
    id: step.id,
    label: step.label,
    gate: step.gate,
    ...(step.prompt === undefined ? {} : { prompt: step.prompt }),
    ...(step.maxRounds === undefined ? {} : { maxRounds: step.maxRounds as number }),
    skills,
    inputs,
    outputs,
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(tests === undefined ? {} : { tests }),
    ...(testPolicy === undefined ? {} : { test_policy: testPolicy }),
    ...(agents === undefined ? {} : { agents }),
    guards,
    transitions,
  }
}

function decodeIoSlot(value: unknown): WbIoSlot | null {
  const slot = record(value)
  if (!slot || typeof slot.id !== 'string') return null
  const consumers = decodeArray(slot.consumers, (item) => typeof item === 'string' ? item : null)
  if (consumers === null) return null
  if (slot.kind === 'document') {
    const producers = decodeArray(slot.producers, (item) => typeof item === 'string' ? item : null)
    if (producers === null) return null
    if (slot.role !== 'produce' && slot.role !== 'update' && slot.role !== 'read' && slot.role !== 'require') return null
    if (slot.scope !== 'change' && slot.scope !== 'project') return null
    return { kind: 'document', id: slot.id, role: slot.role, scope: slot.scope, producers, consumers }
  }
  if (slot.kind === 'field') {
    if (slot.type !== 'string' && slot.type !== 'file_path' && slot.type !== 'boolean') return null
    if (slot.producer !== null && typeof slot.producer !== 'string') return null
    return { kind: 'field', id: slot.id, type: slot.type, producer: slot.producer, consumers }
  }
  return null
}

export function decodeEffectiveIo(value: unknown): WbEffectiveIo | null {
  const body = record(value)
  if (!body) return null
  const out: WbEffectiveIo = {}
  for (const [stepId, raw] of Object.entries(body)) {
    const step = record(raw)
    if (!step) return null
    const inputs = decodeArray(step.inputs, decodeIoSlot)
    const outputs = decodeArray(step.outputs, decodeIoSlot)
    if (inputs === null || outputs === null) return null
    out[stepId] = { inputs, outputs }
  }
  return out
}

const TRACK_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/

/** `tracks.<id>` 分支：可选 label、可选文档契约 + 自己的 steps。 */
function decodeTracks(value: unknown): Record<string, WbTrackBranch> | null {
  const body = record(value)
  if (!body) return null
  const out: Record<string, WbTrackBranch> = {}
  for (const [id, raw] of Object.entries(body)) {
    const branch = record(raw)
    if (!TRACK_ID_RE.test(id) || !branch || !allowedKeys(branch, ['label', 'documentContract', 'steps']) || !optionalString(branch.label)) return null
    const documentContract = branch.documentContract === undefined ? undefined : decodeDocumentContract(branch.documentContract)
    const steps = decodeArray(branch.steps, decodeStep)
    if (steps === null || documentContract === null) return null
    out[id] = {
      ...(branch.label === undefined ? {} : { label: branch.label }),
      ...(documentContract === undefined ? {} : { documentContract }),
      steps,
    }
  }
  return out
}

/** 读接口的分支投影：`_base` + 每条 track 的物化 IO。 */
function decodeBranches(value: unknown): Record<string, WbBranchProjection> | null {
  const body = record(value)
  if (!body) return null
  const out: Record<string, WbBranchProjection> = {}
  for (const [id, raw] of Object.entries(body)) {
    const branch = record(raw)
    if (!branch || !optionalString(branch.label)) return null
    const effectiveIo = decodeEffectiveIo(branch.effectiveIo)
    if (effectiveIo === null) return null
    out[id] = { ...(branch.label === undefined ? {} : { label: branch.label }), effectiveIo }
  }
  return out
}

export function decodeSkillFiles(value: unknown): WbSkillFiles | null {
  const body = record(value)
  if (!body || typeof body.name !== 'string' || typeof body.origin !== 'string') return null
  const source = decodeSkillSource(body.source)
  const files = decodeArray(body.files, (item) => {
    const file = record(item)
    if (!file || typeof file.path !== 'string' || file.path === '' || typeof file.bytes !== 'number' || file.bytes < 0) return null
    return { path: file.path, bytes: file.bytes }
  })
  if (source === null || files === null) return null
  return { name: body.name, source, origin: body.origin, files }
}

export function decodeSkillFile(value: unknown): WbSkillFile | null {
  const body = record(value)
  if (!body || typeof body.path !== 'string' || typeof body.text !== 'string') return null
  return { path: body.path, text: body.text }
}

export function decodeWorkflowDefinition(value: unknown): WbWorkflowDef | null {
  const body = record(value)
  if (!body || typeof body.name !== 'string') return null
  if (body.source !== undefined && body.source !== 'builtin' && body.source !== 'project' && body.source !== 'global') return null
  const effectiveIo = body.effectiveIo === undefined ? undefined : decodeEffectiveIo(body.effectiveIo)
  if (effectiveIo === null) return null
  // 已删除的评审键：出现即拒，不静默丢弃（同 kernel parse 的点名报错）。
  if (body.openspecContract !== undefined || body.reviewBudget !== undefined) return null
  if (body.openspec !== undefined && typeof body.openspec !== 'boolean') return null
  const documentContract = body.documentContract === undefined ? undefined : decodeDocumentContract(body.documentContract)
  const decomposition = decodeDecompositionPolicy(body.decomposition)
  const interaction = decodeInteractionPolicy(body.interaction)
  const steps = decodeArray(body.steps, decodeStep)
  const tracks = body.tracks === undefined ? undefined : decodeTracks(body.tracks)
  const branches = body.branches === undefined ? undefined : decodeBranches(body.branches)
  if (documentContract === null || decomposition === null || interaction === null || steps === null || tracks === null || branches === null) return null
  return {
    name: body.name,
    ...(body.source === undefined ? {} : { source: body.source }),
    ...(effectiveIo === undefined ? {} : { effectiveIo }),
    ...(tracks === undefined ? {} : { tracks }),
    ...(branches === undefined ? {} : { branches }),
    ...(body.openspec === undefined ? {} : { openspec: body.openspec }),
    ...(documentContract === undefined ? {} : { documentContract }),
    decomposition,
    interaction,
    steps,
  }
}
