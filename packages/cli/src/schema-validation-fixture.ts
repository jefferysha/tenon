/**
 * 导出格式的 JSON Schema 校验夹具（ajv）。Agent Trace 的 schema 是公开规范原样入库；OTLP / SARIF / 报告 / note 的 schema
 * 是 Tenon 写出的子集，对象与属性名取自各自的规范。`format` 关键字（uuid、date-time、uri）ajv 默认不校验，这里登记等价的正则。
 * 只给测试用；不进 dist（tsconfig 排除）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import { REPO_ROOT } from './integration-harness.js'

const FORMATS: Readonly<Record<string, RegExp>> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u,
  uri: /^[a-zA-Z][a-zA-Z0-9+.-]*:\S+$/u,
}

export const SCHEMAS = {
  agentTrace: 'packages/kernel/src/evidence-export/schemas/agent-trace-record.schema.json',
  otlp: 'packages/kernel/src/evidence-export/schemas/otlp-trace-export.schema.json',
  evidenceNote: 'packages/kernel/src/evidence-export/schemas/tenon-evidence-note.v1.schema.json',
  sarif: 'packages/kernel/src/ci-verify/schemas/sarif-2.1.0-subset.schema.json',
  verifyReport: 'packages/kernel/src/ci-verify/schemas/tenon-verify-ci.v1.schema.json',
} as const

export type SchemaName = keyof typeof SCHEMAS

export interface SchemaResult {
  readonly valid: boolean
  readonly errors: string
}

export function validateAgainst(name: SchemaName, value: unknown): SchemaResult {
  const schema: unknown = JSON.parse(readFileSync(join(REPO_ROOT, SCHEMAS[name]), 'utf8'))
  const draft2020 = name === 'agentTrace'
  const ajv = draft2020 ? new Ajv2020({ allErrors: true, strict: false }) : new Ajv({ allErrors: true, strict: false })
  for (const [format, pattern] of Object.entries(FORMATS)) ajv.addFormat(format, pattern)
  const validate = ajv.compile(typeof schema === 'object' && schema !== null ? schema : {})
  const valid = validate(value)
  return { valid, errors: valid ? '' : ajv.errorsText(validate.errors, { separator: '\n' }) }
}
