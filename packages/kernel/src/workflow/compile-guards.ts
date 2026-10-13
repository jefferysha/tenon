import { FIELD_ORDER, LIST_FIELDS, type FieldName } from '../types.js'
import { validateOutputPattern } from '../documents/step-outputs-model.js'
import type { FieldRef, StepDef } from './types.js'
import { GUARD_DATA_KEYS } from './types.js'
import type { TrackPredicate } from './predicates.js'
import { fieldEqualsValueUnrepresentableReason } from './representable.js'
import type { CompiledGuardConfig } from './ir.js'

const KNOWN_FIELDS: ReadonlySet<string> = new Set(FIELD_ORDER)
const LIST_FIELD_SET: ReadonlySet<string> = new Set(LIST_FIELDS)
const WHEN_ALLOWED_KEYS: ReadonlySet<string> = new Set(['kind', 'values'])
const PATH_ALLOWED_KEYS: ReadonlySet<string> = new Set(['kind', 'field'])

function compileError(path: string, message: string): never {
  throw new Error(`compileWorkflow: ${path}: ${message}`)
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

function rejectExtraKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      compileError(path, `出现该变体不接受的附加键 '${key}'（闭集：${[...allowed].join('/')}）`)
    }
  }
}

function stringArray(value: unknown, path: string): string[] {
  return asArray(value, path).map((item, index) => {
    if (typeof item !== 'string') {
      compileError(`${path}[${index}]`, `必须是字符串（实际 ${JSON.stringify(item)}）`)
    }
    return item
  })
}

function knownField(value: unknown, path: string): FieldName {
  if (typeof value !== 'string' || !KNOWN_FIELDS.has(value)) {
    compileError(path, `'${String(value)}' 不是已知状态字段（../types.ts FIELD_ORDER 闭集）`)
  }
  return value as FieldName
}

function scalarField(value: unknown, path: string): FieldName {
  const field = knownField(value, path)
  if (LIST_FIELD_SET.has(field)) {
    compileError(path, `'${field}' 是列表字段（../types.ts LIST_FIELDS），scalar guard 不定义列表语义`)
  }
  return field
}

export function compileWhen(value: unknown, path: string): TrackPredicate | undefined {
  if (value === undefined) return undefined
  const record = asRecord(value, path)
  if (record.kind !== 'track-in' && record.kind !== 'track-not-in') {
    compileError(`${path}.kind`, `必须是 'track-in' | 'track-not-in'（实际 ${JSON.stringify(record.kind)}）`)
  }
  const values = stringArray(record.values, `${path}.values`)
  rejectExtraKeys(record, WHEN_ALLOWED_KEYS, path)
  return { kind: record.kind, values }
}

function withWhen<T extends object>(config: T, when: TrackPredicate | undefined): T & { when?: TrackPredicate } {
  return when === undefined ? config : { ...config, when }
}

/**
 * required-output 的路径模式：语法与安全校验归 validateOutputPattern（拒绝空串、绝对路径、`..`、反斜杠、未知占位符等），
 * 这里另要求首尾无空白——YAML 里 `path:` 读回会去掉首尾空白，留着它们会让保存后的模式悄悄变了。
 * 错误点名所在步骤（stepId 只在步骤编译入口已知；auto-gate 等内部调用不涉及 required-output）。
 */
function requiredOutputPattern(value: unknown, path: string, stepId: string | undefined): string {
  if (typeof value !== 'string') compileError(path, `必须是字符串（实际 ${JSON.stringify(value)}）`)
  const problem = validateOutputPattern(value)
    ?? (value === value.trim() ? null : `required-output 的 path 不能以空白开头或结尾：${JSON.stringify(value)}`)
  if (problem !== null) compileError(path, `${stepId === undefined ? '' : `step '${stepId}'：`}${problem}`)
  return value
}

function compileGuard(raw: unknown, path: string, outputs: readonly FieldRef[], stepId: string | undefined): CompiledGuardConfig[] {
  const record = asRecord(raw, path)
  if (typeof record.type === 'string' && Object.prototype.hasOwnProperty.call(GUARD_DATA_KEYS, record.type)) {
    const dataKeys = GUARD_DATA_KEYS[record.type as keyof typeof GUARD_DATA_KEYS]
    rejectExtraKeys(record, new Set<string>(['type', 'when', ...dataKeys]), path)
  }
  const when = compileWhen(record.when, `${path}.when`)
  switch (record.type) {
    case 'tasks-at-least': {
      const n = record.n
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
        compileError(`${path}.n`, `必须是非负整数（parse.ts 的 \\d+ 口径；实际 ${JSON.stringify(n)}）`)
      }
      return [withWhen({ type: 'tasks-at-least' as const, n }, when)]
    }
    case 'nonempty-output':
      return outputs.map((output) =>
        KNOWN_FIELDS.has(output.field) && !LIST_FIELD_SET.has(output.field)
          ? withWhen({ type: 'field-nonempty' as const, field: output.field as FieldName }, when)
          : withWhen({ type: 'output-present' as const, field: output.field }, when),
      )
    case 'field-nonempty':
      return [withWhen({
        type: 'field-nonempty' as const,
        field: scalarField(record.field, `${path}.field`),
      }, when)]
    case 'file-exists': {
      const target = asRecord(record.path, `${path}.path`)
      if (target.kind !== 'field') {
        compileError(`${path}.path.kind`, `必须是 'field'（实际 ${JSON.stringify(target.kind)}）`)
      }
      const field = scalarField(target.field, `${path}.path.field`)
      rejectExtraKeys(target, PATH_ALLOWED_KEYS, `${path}.path`)
      return [withWhen({ type: 'file-exists' as const, path: { kind: 'field' as const, field } }, when)]
    }
    case 'field-equals': {
      const value = record.value
      if (typeof value !== 'string') {
        compileError(`${path}.value`, `必须是字符串（实际 ${JSON.stringify(value)}）`)
      }
      const unrepresentable = fieldEqualsValueUnrepresentableReason(value)
      if (unrepresentable) compileError(`${path}.value`, unrepresentable)
      return [withWhen({
        type: 'field-equals' as const,
        field: scalarField(record.field, `${path}.field`),
        value,
      }, when)]
    }
    case 'field-in': {
      const values = stringArray(record.values, `${path}.values`)
      if (values.length === 0) compileError(`${path}.values`, '不得是空数组（至少一个合法值）')
      return [withWhen({
        type: 'field-in' as const,
        field: scalarField(record.field, `${path}.field`),
        values: values as [string, ...string[]],
      }, when)]
    }
    case 'full-direct-override':
      return [withWhen({ type: 'full-direct-override' as const }, when)]
    case 'build-head-unchanged':
      if (record.field !== 'build_sha') {
        compileError(
          `${path}.field`,
          `必须是 'build_sha'（barrier 只定义在 build 冻结 SHA 上；实际 ${JSON.stringify(record.field)}）`,
        )
      }
      return [withWhen({ type: 'build-head-unchanged' as const, field: 'build_sha' as const }, when)]
    case 'spec-migration-applied':
      return [withWhen({ type: 'spec-migration-applied' as const }, when)]
    case 'tasks-through-step':
      return [withWhen({ type: 'tasks-through-step' as const }, when)]
    case 'not-afk-queued':
      return [withWhen({ type: 'not-afk-queued' as const }, when)]
    case 'dependencies-ended':
      return [withWhen({ type: 'dependencies-ended' as const }, when)]
    case 'required-output':
      return [withWhen({
        type: 'required-output' as const,
        path: requiredOutputPattern(record.path, `${path}.path`, stepId),
      }, when)]
    default:
      compileError(
        `${path}.type`,
        `未知 guard type ${JSON.stringify(record.type)}（闭集见 types.ts WorkflowGuardConfig）`,
      )
  }
}

export function compileGuards(
  raw: unknown,
  path: string,
  outputs: readonly FieldRef[],
  stepId?: string,
): CompiledGuardConfig[] {
  if (raw === undefined) return []
  return asArray(raw, path).flatMap((guard, index) => compileGuard(guard, `${path}[${index}]`, outputs, stepId))
}

export function compileStepGuards(step: StepDef): CompiledGuardConfig[] {
  const record = asRecord(step, 'step')
  return compileGuards(
    record.guards,
    'step.guards',
    asArray(record.outputs, 'step.outputs') as readonly FieldRef[],
    typeof record.id === 'string' ? record.id : undefined,
  )
}
