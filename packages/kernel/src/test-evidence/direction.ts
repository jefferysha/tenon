/**
 * 测试方向 = 创作模板。把一个方向加进步骤时，它的字段被整份抄进步骤 YAML，步骤测试项自此自包含：
 * 改方向或删方向都不影响已有工作流与在跑的任务（父设计 X7、本任务 D1）。
 *
 * 文件语法与步骤测试项同一份实现（workflow/parse-tests.ts、serialize-tests.ts），只是键写在顶层、
 * 没有 `direction` 键、`label` 必填。值域校验复用 compileStepTests，避免两套闭集漂移。
 */
import { compileStepTests } from '../workflow/compile-tests.js'
import { parseTestBody } from '../workflow/parse-tests.js'
import { serializeTestBody } from '../workflow/serialize-tests.js'
import type { StepTestDef } from '../workflow/types.js'

export interface TestDirectionDef extends Omit<StepTestDef, 'id' | 'direction' | 'required' | 'keep_runs' | 'label'> {
  /** 等于文件名主干。 */
  readonly id: string
  /** 直接展示，不翻译。 */
  readonly label: string
}

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

function fail(message: string): never {
  throw new Error(`test direction 解析错误：${message}`)
}

export function parseTestDirection(content: string): TestDirectionDef {
  const lines = content.split('\n')
  const idLines = lines.filter((line) => /^id:/.test(line))
  if (idLines.length !== 1) fail('必须恰好有一行顶层 id')
  const id = (/^id:\s*(\S+)\s*$/.exec(idLines[0] ?? '')?.[1] ?? '')
  if (!ID_RE.test(id)) fail(`id '${id}' 含非法字符（仅允许 a-zA-Z0-9_-，≤64）`)
  const body = ['direction: placeholder', ...lines.filter((line) => !/^id:/.test(line))]
  let parsed: StepTestDef
  try {
    parsed = parseTestBody(id, { lines: body, i: 0 }, -1)
  } catch (error) {
    return fail(error instanceof Error ? error.message.replace('workflow 解析错误：', '') : String(error))
  }
  if (parsed.label === undefined) fail(`方向 '${id}' 缺 label`)
  if (parsed.required !== undefined || parsed.keep_runs !== undefined) {
    fail(`方向 '${id}' 不接受 required / keep_runs（属于步骤测试项）`)
  }
  const { direction: _direction, id: _id, required: _required, keep_runs: _keepRuns, label, ...rest } = parsed
  try {
    compileStepTests([{ ...rest, label, id, direction: id }], `test-direction ${id}`)
  } catch (error) {
    return fail(error instanceof Error ? error.message.replace(/^compileWorkflow: [^:]*: /u, '') : String(error))
  }
  return { ...rest, id, label }
}

export function serializeTestDirection(def: TestDirectionDef): string {
  const { id, ...rest } = def
  return `${['id: ' + id, ...serializeTestBody(rest, '')].join('\n')}\n`
}

/** 把方向抄成步骤测试项；id 与已有项冲突时追加 `-2`、`-3` …。 */
export function testFromDirection(direction: TestDirectionDef, existingIds: ReadonlySet<string>): StepTestDef {
  let id = direction.id
  for (let suffix = 2; existingIds.has(id); suffix++) id = `${direction.id}-${suffix}`
  const { id: _id, ...rest } = direction
  return { ...rest, id, direction: direction.id, required: true }
}
