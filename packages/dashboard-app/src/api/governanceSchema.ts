import type {
  WbActionConfig,
  WbArtifactConfig,
  WbDocumentContract,
  WbFieldRef,
  WbGuardConfig,
  WbSkillEntry,
  WbSkillRef,
  WbStepDef,
  WbTrackPredicate,
  WbTransition,
  WbWorkflowDef,
  WbEffectiveIo,
  WbIoSlot, WbTrackBranch, WbBranchProjection, WbSkillFiles, WbSkillFile,
  WbStepTest, WbTestInput, WbTestMetric, WbTestOutput, WbTestOutputKind,
} from './governanceTypes'
import {
  DEFAULT_WB_DECOMPOSITION_POLICY,
  DEFAULT_WB_INTERACTION_POLICY,
  DEFAULT_WB_REVIEW_BUDGET_POLICY,
  type WbDecompositionMode,
  type WbDecompositionPolicy,
  type WbDecompositionStrategy,
  type WbDecompositionTarget,
  type WbInteractionMode,
  type WbInteractionPolicy,
  type WbReviewBudgetPolicy,
} from './governanceTypes'

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function decodeArray<T>(value: unknown, decode: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null
  const entries: T[] = []
  for (const entry of value) {
    const decoded = decode(entry)
    if (decoded === null) return null
    entries.push(decoded)
  }
  return entries
}

function decodeSkillSource(value: unknown): WbSkillEntry['source'] | null {
  return value === 'local-plugin'
    || value === 'external-marketplace'
    || value === 'builtin'
    || value === 'user'
    ? value
    : null
}

function decodeSkillTier(value: unknown): WbSkillEntry['tier'] | null {
  return value === 'mandatory'
    || value === 'recommended'
    || value === 'conditional'
    || value === 'optional'
    ? value
    : null
}

function decodeSkillEntry(value: unknown): WbSkillEntry | null {
  const item = record(value)
  if (!item || typeof item.name !== 'string' || typeof item.installed !== 'boolean') return null
  const source = decodeSkillSource(item.source)
  if (source === null) return null
  if (!optionalString(item.description) || !optionalString(item.installCmd) || !optionalString(item.version)) return null
  if (item.available !== undefined && typeof item.available !== 'boolean') return null
  const tier = item.tier === undefined ? undefined : decodeSkillTier(item.tier)
  if (tier === null) return null
  return {
    name: item.name,
    installed: item.installed,
    source,
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(tier === undefined ? {} : { tier }),
    ...(item.available === undefined ? {} : { available: item.available }),
    ...(item.installCmd === undefined ? {} : { installCmd: item.installCmd }),
    ...(item.version === undefined ? {} : { version: item.version }),
  }
}

export function decodeSkillsRegistry(value: unknown): WbSkillEntry[] | null {
  const body = record(value)
  return body ? decodeArray(body.skills, decodeSkillEntry) : null
}

function decodeField(value: unknown): WbFieldRef | null {
  const item = record(value)
  if (!item || typeof item.field !== 'string') return null
  if (item.type !== 'string' && item.type !== 'file_path' && item.type !== 'boolean') return null
  return { field: item.field, type: item.type }
}

function decodeSkill(value: unknown): WbSkillRef | null {
  const item = record(value)
  if (!item
    || !allowedKeys(item, ['id', 'kind', 'review_lane', 'depends_on'])
    || typeof item.id !== 'string'
    || (item.kind !== undefined && item.kind !== 'work' && item.kind !== 'review')
    || !optionalString(item.review_lane)
    || (item.depends_on !== undefined && !strings(item.depends_on))) return null
  const kind = item.kind ?? 'work'
  if ((kind === 'review') !== (item.review_lane !== undefined)) return null
  return {
    id: item.id,
    ...(item.kind === undefined ? {} : { kind }),
    ...(item.review_lane === undefined ? {} : { review_lane: item.review_lane }),
    ...(item.depends_on === undefined ? {} : { depends_on: item.depends_on }),
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return keys.length === sortedExpected.length
    && keys.every((key, index) => key === sortedExpected[index])
}

function allowedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(value).every((key) => allowedSet.has(key))
}

const DECOMPOSITION_MODES = ['off', 'suggest', 'auto-safe', 'require-review'] as const
const DECOMPOSITION_TARGETS = ['work-items', 'child-pipelines'] as const
const DECOMPOSITION_STRATEGIES = ['balanced', 'breadth-first', 'depth-first'] as const
const DECOMPOSITION_AUTO_WHEN = [
  'independent-work-items',
  'cross-component-boundary',
  'context-budget-risk',
] as const
const DECOMPOSITION_ASK_WHEN = [
  'ambiguous-requirements',
  'hard-boundary',
  'missing-authorization',
  'limit-exceeded',
] as const
const INTERACTION_MODES = ['interactive', 'recommended-defaults', 'afk'] as const

function isMember<T extends string>(value: unknown, values: readonly T[]): value is T {
  if (typeof value !== 'string') return false
  return values.some((candidate) => candidate === value)
}

function decodeUniqueMembers<T extends string>(value: unknown, values: readonly T[]): T[] | null {
  if (!Array.isArray(value)) return null
  const decoded: T[] = []
  for (const entry of value) {
    if (!isMember(entry, values) || decoded.includes(entry)) return null
    decoded.push(entry)
  }
  return decoded
}

function decodeDecompositionPolicy(value: unknown): WbDecompositionPolicy | null {
  if (value === undefined) {
    return {
      ...DEFAULT_WB_DECOMPOSITION_POLICY,
      auto_when: [],
      ask_when: [],
    }
  }
  const item = record(value)
  if (!item || !allowedKeys(item, [
    'version', 'mode', 'target', 'strategy', 'max_items', 'max_depth', 'auto_when', 'ask_when',
  ])) return null
  // A present policy object is versioned just like the kernel contract; only the whole absent
  // object is a legacy definition that receives safe defaults.
  const version = item.version
  const mode = item.mode ?? DEFAULT_WB_DECOMPOSITION_POLICY.mode
  const target = item.target ?? DEFAULT_WB_DECOMPOSITION_POLICY.target
  const strategy = item.strategy ?? DEFAULT_WB_DECOMPOSITION_POLICY.strategy
  const maxItems = item.max_items ?? DEFAULT_WB_DECOMPOSITION_POLICY.max_items
  const maxDepth = item.max_depth ?? DEFAULT_WB_DECOMPOSITION_POLICY.max_depth
  const autoWhen = item.auto_when === undefined
    ? []
    : decodeUniqueMembers(item.auto_when, DECOMPOSITION_AUTO_WHEN)
  const askWhen = item.ask_when === undefined
    ? []
    : decodeUniqueMembers(item.ask_when, DECOMPOSITION_ASK_WHEN)
  if (version !== 'v1'
    || !isMember<WbDecompositionMode>(mode, DECOMPOSITION_MODES)
    || !isMember<WbDecompositionTarget>(target, DECOMPOSITION_TARGETS)
    || !isMember<WbDecompositionStrategy>(strategy, DECOMPOSITION_STRATEGIES)
    || typeof maxItems !== 'number' || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 32
    || typeof maxDepth !== 'number' || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 4
    || autoWhen === null
    || askWhen === null) return null
  return {
    version: 'v1',
    mode,
    target,
    strategy,
    max_items: maxItems,
    max_depth: maxDepth,
    auto_when: autoWhen,
    ask_when: askWhen,
  }
}

function decodeInteractionPolicy(value: unknown): WbInteractionPolicy | null {
  if (value === undefined) return { ...DEFAULT_WB_INTERACTION_POLICY }
  const item = record(value)
  if (!item || !allowedKeys(item, ['version', 'mode'])) return null
  const version = item.version
  const mode = item.mode ?? DEFAULT_WB_INTERACTION_POLICY.mode
  return version === 'v1' && isMember<WbInteractionMode>(mode, INTERACTION_MODES)
    ? { version: 'v1', mode }
    : null
}

function decodeReviewBudgetPolicy(value: unknown): WbReviewBudgetPolicy | null {
  if (value === undefined) return { ...DEFAULT_WB_REVIEW_BUDGET_POLICY }
  const item = record(value)
  if (!item || !allowedKeys(item, ['version', 'max_attempts'])) return null
  return item.version === 'v1'
    && typeof item.max_attempts === 'number'
    && Number.isInteger(item.max_attempts)
    && item.max_attempts >= 1
    && item.max_attempts <= 20
    ? { version: 'v1', max_attempts: item.max_attempts }
    : null
}

function decodePredicate(value: unknown): WbTrackPredicate | null {
  const item = record(value)
  if (!item
    || !exactKeys(item, ['kind', 'values'])
    || (item.kind !== 'track-in' && item.kind !== 'track-not-in')
    || !strings(item.values)) return null
  return { kind: item.kind, values: item.values }
}

function withWhen(
  guard: WbGuardConfig,
  when: WbTrackPredicate | undefined,
): WbGuardConfig {
  return when === undefined ? guard : { ...guard, when }
}

const GUARD_DATA_KEYS = {
  'tasks-at-least': ['n'],
  'nonempty-output': [],
  'field-nonempty': ['field'],
  'file-exists': ['path'],
  'field-equals': ['field', 'value'],
  'field-in': ['field', 'values'],
  'full-direct-override': [],
  'build-head-unchanged': ['field'],
  'spec-migration-applied': [],
} as const satisfies Record<WbGuardConfig['type'], readonly string[]>

function isGuardType(value: string): value is WbGuardConfig['type'] {
  return Object.prototype.hasOwnProperty.call(GUARD_DATA_KEYS, value)
}

function decodeGuard(value: unknown): WbGuardConfig | null {
  const item = record(value)
  if (!item || typeof item.type !== 'string' || !isGuardType(item.type)) return null
  const expectedKeys = [
    'type',
    ...GUARD_DATA_KEYS[item.type],
    ...(item.when === undefined ? [] : ['when']),
  ]
  if (!exactKeys(item, expectedKeys)) return null
  const when = item.when === undefined ? undefined : decodePredicate(item.when)
  if (when === null) return null
  switch (item.type) {
    case 'tasks-at-least':
      return typeof item.n === 'number' && Number.isInteger(item.n) && item.n >= 0
        ? withWhen({ type: 'tasks-at-least', n: item.n }, when)
        : null
    case 'nonempty-output':
      return withWhen({ type: 'nonempty-output' }, when)
    case 'full-direct-override':
      return withWhen({ type: 'full-direct-override' }, when)
    case 'field-nonempty':
      return typeof item.field === 'string' ? withWhen({ type: 'field-nonempty', field: item.field }, when) : null
    case 'file-exists': {
      const path = record(item.path)
      return path !== null
        && exactKeys(path, ['kind', 'field'])
        && path.kind === 'field'
        && typeof path.field === 'string'
        ? withWhen({ type: 'file-exists', path: { kind: 'field', field: path.field } }, when)
        : null
    }
    case 'field-equals':
      return typeof item.field === 'string' && typeof item.value === 'string'
        ? withWhen({ type: 'field-equals', field: item.field, value: item.value }, when)
        : null
    case 'field-in': {
      if (typeof item.field !== 'string' || !strings(item.values)) return null
      const [first, ...rest] = item.values
      return first === undefined
        ? null
        : withWhen({ type: 'field-in', field: item.field, values: [first, ...rest] }, when)
    }
    case 'build-head-unchanged':
      return item.field === 'build_sha'
        ? withWhen({ type: 'build-head-unchanged', field: 'build_sha' }, when)
        : null
    case 'spec-migration-applied':
      return withWhen({ type: 'spec-migration-applied' }, when)
    default:
      return null
  }
}

function decodeAction(value: unknown): WbActionConfig | null {
  const item = record(value)
  if (!item || !exactKeys(item, ['type'])) return null
  switch (item.type) {
    case 'freeze-build-sha': return { type: 'freeze-build-sha' }
    case 'mark-verification-passed': return { type: 'mark-verification-passed' }
    case 'mark-verification-failed': return { type: 'mark-verification-failed' }
    case 'reset-pre-verify-review': return { type: 'reset-pre-verify-review' }
    case 'archive-run': return { type: 'archive-run' }
    default: return null
  }
}

function decodeTransition(value: unknown): WbTransition | null {
  const item = record(value)
  if (!item || typeof item.event !== 'string' || typeof item.to !== 'string') return null
  const guards = item.guards === undefined ? undefined : decodeArray(item.guards, decodeGuard)
  const actions = item.actions === undefined ? undefined : decodeArray(item.actions, decodeAction)
  if (guards === null || actions === null) return null
  return {
    event: item.event,
    to: item.to,
    ...(guards === undefined ? {} : { guards }),
    ...(actions === undefined ? {} : { actions }),
  }
}

function decodeArtifact(value: unknown): WbArtifactConfig | null {
  const item = record(value)
  if (!item || typeof item.field !== 'string' || item.type !== 'file_path') return null
  if (item.producerPolicy !== 'effective-step-skills' && item.producerPolicy !== 'effective-phase-skills') return null
  const requiredWhen = item.requiredWhen === undefined ? undefined : decodePredicate(item.requiredWhen)
  if (requiredWhen === null) return null
  return {
    field: item.field,
    type: 'file_path',
    producerPolicy: item.producerPolicy,
    ...(requiredWhen === undefined ? {} : { requiredWhen }),
  }
}

function decodeDocumentSlot(value: unknown): WbDocumentContract['slots'][number] | null {
  const item = record(value)
  if (!item || typeof item.kind !== 'string' || typeof item.ownerStep !== 'string' || !strings(item.producers)) return null
  if (item.role !== undefined && item.role !== 'update' && item.role !== 'require') return null
  return { kind: item.kind, ownerStep: item.ownerStep, ...(item.role === undefined ? {} : { role: item.role }), producers: item.producers }
}

function decodeDocumentRead(value: unknown): WbDocumentContract['reads'][number] | null {
  const item = record(value)
  return item && typeof item.step === 'string' && strings(item.kinds)
    ? { step: item.step, kinds: item.kinds }
    : null
}

function decodeDocumentContract(value: unknown): WbDocumentContract | null {
  const item = record(value)
  if (!item || item.version !== 'v1') return null
  const slots = decodeArray(item.slots, decodeDocumentSlot)
  const reads = decodeArray(item.reads, decodeDocumentRead)
  return slots === null || reads === null ? null : { version: 'v1', slots, reads }
}

const TEST_OUTPUT_KINDS: readonly string[] = ['report', 'coverage', 'metrics', 'trace', 'screenshot', 'log', 'other']

function decodeTestInput(value: unknown): WbTestInput | null {
  const input = record(value)
  if (!input) return null
  if (input.kind === 'document' && typeof input.ref === 'string') return { kind: 'document', ref: input.ref }
  if (input.kind === 'file' && typeof input.path === 'string') return { kind: 'file', path: input.path }
  if (input.kind === 'env' && typeof input.name === 'string') return { kind: 'env', name: input.name }
  if (input.kind === 'service' && typeof input.name === 'string') {
    if (input.url === undefined) return { kind: 'service', name: input.name }
    return typeof input.url === 'string' ? { kind: 'service', name: input.name, url: input.url } : null
  }
  return null
}

function decodeTestOutput(value: unknown): WbTestOutput | null {
  const output = record(value)
  if (!output || typeof output.path !== 'string' || output.path === '') return null
  if (output.kind !== undefined && (typeof output.kind !== 'string' || !TEST_OUTPUT_KINDS.includes(output.kind))) return null
  if (output.required !== undefined && typeof output.required !== 'boolean') return null
  return {
    path: output.path,
    ...(output.kind === undefined ? {} : { kind: output.kind as WbTestOutputKind }),
    ...(output.required === undefined ? {} : { required: output.required }),
  }
}

function decodeTestMetric(value: unknown): WbTestMetric | null {
  const metric = record(value)
  if (!metric || typeof metric.name !== 'string' || metric.name === '') return null
  for (const key of ['max', 'min', 'max_regression_pct'] as const) {
    if (metric[key] !== undefined && typeof metric[key] !== 'number') return null
  }
  if (metric.better !== undefined && metric.better !== 'lower' && metric.better !== 'higher') return null
  return {
    name: metric.name,
    ...(metric.max === undefined ? {} : { max: metric.max as number }),
    ...(metric.min === undefined ? {} : { min: metric.min as number }),
    ...(metric.max_regression_pct === undefined ? {} : { max_regression_pct: metric.max_regression_pct as number }),
    ...(metric.better === undefined ? {} : { better: metric.better }),
  }
}

function decodeStepTest(value: unknown): WbStepTest | null {
  const test = record(value)
  if (!test || typeof test.id !== 'string' || test.id === ''
    || typeof test.direction !== 'string' || test.direction === ''
    || typeof test.command !== 'string' || test.command === '') return null
  for (const key of ['cwd', 'label', 'metrics_path'] as const) {
    if (test[key] !== undefined && typeof test[key] !== 'string') return null
  }
  for (const key of ['timeout_s', 'keep_runs'] as const) {
    if (test[key] !== undefined && (typeof test[key] !== 'number' || !Number.isInteger(test[key]))) return null
  }
  if (test.required !== undefined && typeof test.required !== 'boolean') return null
  if (test.scope !== undefined && test.scope !== 'full' && test.scope !== 'known') return null
  let pass: WbStepTest['pass']
  if (test.pass !== undefined) {
    const raw = record(test.pass)
    if (!raw) return null
    if (raw.exit_code !== undefined && (typeof raw.exit_code !== 'number' || !Number.isInteger(raw.exit_code))) return null
    const metrics = raw.metrics === undefined ? undefined : decodeArray(raw.metrics, decodeTestMetric)
    if (metrics === null) return null
    pass = {
      ...(raw.exit_code === undefined ? {} : { exit_code: raw.exit_code as number }),
      ...(metrics === undefined ? {} : { metrics }),
    }
  }
  const inputs = test.inputs === undefined ? undefined : decodeArray(test.inputs, decodeTestInput)
  const outputs = test.outputs === undefined ? undefined : decodeArray(test.outputs, decodeTestOutput)
  if (inputs === null || outputs === null) return null
  return {
    id: test.id,
    direction: test.direction,
    command: test.command,
    ...(test.cwd === undefined ? {} : { cwd: test.cwd as string }),
    ...(test.label === undefined ? {} : { label: test.label as string }),
    ...(test.timeout_s === undefined ? {} : { timeout_s: test.timeout_s as number }),
    ...(test.required === undefined ? {} : { required: test.required }),
    ...(test.keep_runs === undefined ? {} : { keep_runs: test.keep_runs as number }),
    ...(test.scope === undefined ? {} : { scope: test.scope }),
    ...(test.metrics_path === undefined ? {} : { metrics_path: test.metrics_path as string }),
    ...(pass === undefined ? {} : { pass }),
    ...(inputs === undefined ? {} : { inputs }),
    ...(outputs === undefined ? {} : { outputs }),
  }
}

function decodeStep(value: unknown): WbStepDef | null {
  const step = record(value)
  if (!step || typeof step.id !== 'string' || typeof step.label !== 'string') return null
  if (step.gate !== null && step.gate !== 'review' && step.gate !== 'auto') return null
  if (!optionalString(step.prompt)) return null
  if (step.reviewLanes !== undefined && !strings(step.reviewLanes)) return null
  const reviewLanes = step.reviewLanes ?? []
  if (reviewLanes.some((lane) => lane.length === 0) || new Set(reviewLanes).size !== reviewLanes.length) return null
  const skills = decodeArray(step.skills, decodeSkill)
  const inputs = decodeArray(step.inputs, decodeField)
  const outputs = decodeArray(step.outputs, decodeField)
  const artifacts = step.artifacts === undefined ? undefined : decodeArray(step.artifacts, decodeArtifact)
  const tests = step.tests === undefined ? undefined : decodeArray(step.tests, decodeStepTest)
  if (tests === null) return null
  const guards = decodeArray(step.guards, decodeGuard)
  const transitions = decodeArray(step.transitions, decodeTransition)
  if (skills === null || inputs === null || outputs === null || artifacts === null || guards === null || transitions === null) return null
  if (skills.some((skill) => skill.kind === 'review' && !reviewLanes.includes(skill.review_lane ?? ''))) return null
  return {
    id: step.id,
    label: step.label,
    gate: step.gate,
    ...(step.prompt === undefined ? {} : { prompt: step.prompt }),
    ...(step.reviewLanes === undefined ? {} : { reviewLanes }),
    skills,
    inputs,
    outputs,
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(tests === undefined ? {} : { tests }),
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

function decodeEffectiveIo(value: unknown): WbEffectiveIo | null {
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
  if (body.openspecContract !== undefined) return null
  if (body.openspec !== undefined && typeof body.openspec !== 'boolean') return null
  const documentContract = body.documentContract === undefined ? undefined : decodeDocumentContract(body.documentContract)
  const decomposition = decodeDecompositionPolicy(body.decomposition)
  const interaction = decodeInteractionPolicy(body.interaction)
  const reviewBudget = decodeReviewBudgetPolicy(body.reviewBudget)
  const steps = decodeArray(body.steps, decodeStep)
  const tracks = body.tracks === undefined ? undefined : decodeTracks(body.tracks)
  const branches = body.branches === undefined ? undefined : decodeBranches(body.branches)
  if (documentContract === null || decomposition === null || interaction === null || reviewBudget === null || steps === null || tracks === null || branches === null) return null
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
    reviewBudget,
    steps,
  }
}
