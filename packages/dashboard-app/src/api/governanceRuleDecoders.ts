/** Workflow-definition decoders for step rules: predicates, guards, transitions, artifacts, documents, tests. */
import type {
  WbActionConfig, WbArtifactConfig, WbDocumentContract, WbGuardConfig, WbStepTest, WbTestInput,
  WbTestMetric, WbTestOutput, WbTestOutputKind, WbTrackPredicate, WbTransition,
} from './governanceTypes'
import { decodeArray, exactKeys, record, strings } from './governanceBaseDecoders'

export function decodePredicate(value: unknown): WbTrackPredicate | null {
  const item = record(value)
  if (!item
    || !exactKeys(item, ['kind', 'values'])
    || (item.kind !== 'track-in' && item.kind !== 'track-not-in')
    || !strings(item.values)) return null
  return { kind: item.kind, values: item.values }
}

export function withWhen(
  guard: WbGuardConfig,
  when: WbTrackPredicate | undefined,
): WbGuardConfig {
  return when === undefined ? guard : { ...guard, when }
}

export const GUARD_DATA_KEYS = {
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

export function isGuardType(value: string): value is WbGuardConfig['type'] {
  return Object.prototype.hasOwnProperty.call(GUARD_DATA_KEYS, value)
}

export function decodeGuard(value: unknown): WbGuardConfig | null {
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

export function decodeAction(value: unknown): WbActionConfig | null {
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

export function decodeTransition(value: unknown): WbTransition | null {
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

export function decodeArtifact(value: unknown): WbArtifactConfig | null {
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

export function decodeDocumentSlot(value: unknown): WbDocumentContract['slots'][number] | null {
  const item = record(value)
  if (!item || typeof item.kind !== 'string' || typeof item.ownerStep !== 'string' || !strings(item.producers)) return null
  if (item.role !== undefined && item.role !== 'update' && item.role !== 'require') return null
  return { kind: item.kind, ownerStep: item.ownerStep, ...(item.role === undefined ? {} : { role: item.role }), producers: item.producers }
}

export function decodeDocumentRead(value: unknown): WbDocumentContract['reads'][number] | null {
  const item = record(value)
  return item && typeof item.step === 'string' && strings(item.kinds)
    ? { step: item.step, kinds: item.kinds }
    : null
}

export function decodeDocumentContract(value: unknown): WbDocumentContract | null {
  const item = record(value)
  if (!item || item.version !== 'v1') return null
  const slots = decodeArray(item.slots, decodeDocumentSlot)
  const reads = decodeArray(item.reads, decodeDocumentRead)
  return slots === null || reads === null ? null : { version: 'v1', slots, reads }
}

export const TEST_OUTPUT_KINDS: readonly string[] = ['report', 'coverage', 'metrics', 'trace', 'screenshot', 'log', 'other']

export function decodeTestInput(value: unknown): WbTestInput | null {
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

export function decodeTestOutput(value: unknown): WbTestOutput | null {
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

export function decodeTestMetric(value: unknown): WbTestMetric | null {
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

export function decodeStepTest(value: unknown): WbStepTest | null {
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
