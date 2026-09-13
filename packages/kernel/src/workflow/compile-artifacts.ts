import { FIELD_ORDER, type FieldName } from '../types.js'
import { compileWhen } from './compile-guards.js'
import type { ArtifactProducerPolicy, FieldRef } from './types.js'
import type { ArtifactDeclaration } from './ir.js'

const KNOWN_FIELDS: ReadonlySet<string> = new Set<string>(FIELD_ORDER)
const PRODUCER_POLICIES: ReadonlySet<string> = new Set<ArtifactProducerPolicy>([
  'effective-step-skills',
  'effective-phase-skills',
])
const ARTIFACT_KEYS: ReadonlySet<string> = new Set(['field', 'type', 'kind', 'producerPolicy', 'requiredWhen'])

function compileError(path: string, msg: string): never {
  throw new Error(`compileWorkflow: ${path}: ${msg}`)
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    compileError(path, `必须是对象（实际 ${JSON.stringify(value)}）`)
  }
  return value as Record<string, unknown>
}

function asArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) compileError(path, `必须是数组（实际 ${JSON.stringify(value)}）`)
  return value
}

function rejectExtraKeys(record: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(record)) {
    if (!ARTIFACT_KEYS.has(key)) {
      compileError(path, `出现该变体不接受的附加键 '${key}'（闭集：${[...ARTIFACT_KEYS].join('/')}）`)
    }
  }
}

function nonemptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') compileError(path, `必须是非空字符串（实际 ${JSON.stringify(value)}）`)
  return value
}

function compileArtifact(
  raw: unknown,
  path: string,
  outputs: readonly FieldRef[],
  allowedPolicies: ReadonlySet<string>,
): ArtifactDeclaration {
  const record = asRecord(raw, path)
  rejectExtraKeys(record, path)
  if (record.type !== undefined && record.type !== 'file_path') {
    compileError(`${path}.type`, `必须是 'file_path'（实际 ${JSON.stringify(record.type)}）`)
  }
  if (record.kind !== undefined && record.kind !== 'file') {
    compileError(`${path}.kind`, `必须是 'file'（实际 ${JSON.stringify(record.kind)}）`)
  }
  if (record.producerPolicy !== undefined) {
    if (typeof record.producerPolicy !== 'string' || !PRODUCER_POLICIES.has(record.producerPolicy)) {
      compileError(`${path}.producerPolicy`, `必须是 ${[...PRODUCER_POLICIES].map((p) => `'${p}'`).join(' | ')}（实际 ${JSON.stringify(record.producerPolicy)}）`)
    }
    if (!allowedPolicies.has(record.producerPolicy)) {
      compileError(
        `${path}.producerPolicy`,
        `custom workflow 不允许 producerPolicy '${record.producerPolicy}'（A 契约：custom artifact 只能 ${[...allowedPolicies].map((p) => `'${p}'`).join(' | ')}；effective-phase-skills 仅 default 轨适用）`,
      )
    }
  }
  const producerPolicy = (record.producerPolicy ?? 'effective-step-skills') as ArtifactProducerPolicy
  const field = nonemptyString(record.field, `${path}.field`)
  if (!KNOWN_FIELDS.has(field)) {
    compileError(`${path}.field`, `'${field}' 不是已知状态字段（../types.ts FIELD_ORDER 闭集）`)
  }
  const typedField = field as FieldName
  const ref = outputs.find((output) => output.field === typedField)
  if (!ref) compileError(`${path}.field`, `artifact 只能挂在本 step outputs 声明的字段上（'${typedField}' 不在 outputs 里）`)
  if (ref.type !== 'file_path') {
    compileError(`${path}.field`, `artifact 只许挂 type:'file_path' 的 FieldRef（'${typedField}' 声明为 '${ref.type}'）`)
  }
  const requiredWhen = compileWhen(record.requiredWhen, `${path}.requiredWhen`)
  const base: ArtifactDeclaration = { kind: 'file', field: typedField, producerPolicy }
  return requiredWhen === undefined ? base : { ...base, requiredWhen }
}

/** Compile explicit artifact declarations. Omitted derives known file_path outputs;
 * explicit [] disables derivation; non-empty declarations overlay derived fields. */
export function compileArtifacts(
  rawExplicit: unknown,
  path: string,
  outputs: readonly FieldRef[],
  outputsPath: string,
  allowedPolicies: ReadonlySet<string>,
): ArtifactDeclaration[] {
  const byField = new Map<FieldName, ArtifactDeclaration>()
  const explicit = rawExplicit === undefined ? undefined : asArray(rawExplicit, path)
  // Omitted declarations and non-empty declarations retain the historical
  // derive-then-overlay behavior. An explicit empty list is the sole opt-out.
  if (explicit === undefined || explicit.length > 0) {
    outputs.forEach((output, index) => {
      if (output.type !== 'file_path' || !KNOWN_FIELDS.has(output.field)) return
      const field = output.field as FieldName
      if (byField.has(field)) {
        compileError(`${outputsPath}[${index}].field`, `'${field}' 重复声明（同 field 的 file_path output 已在前面出现）`)
      }
      byField.set(field, { kind: 'file', field, producerPolicy: 'effective-step-skills' })
    })
  }
  if (explicit !== undefined) {
    const seen = new Set<FieldName>()
    explicit.forEach((raw, index) => {
      const artifact = compileArtifact(raw, `${path}[${index}]`, outputs, allowedPolicies)
      if (seen.has(artifact.field)) compileError(`${path}[${index}].field`, `'${artifact.field}' 重复声明`)
      seen.add(artifact.field)
      byField.set(artifact.field, artifact)
    })
  }
  return [...byField.values()]
}
