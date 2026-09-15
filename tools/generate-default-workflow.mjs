#!/usr/bin/env node
/**
 * generate-default-workflow.mjs（G2 P4）——从 templates/workflows/default.yaml 的显式
 * steps[].artifacts[] 与步骤展示元数据生成只读 TS 数据表
 * packages/kernel/src/workflow/default-workflow.generated.ts。
 *
 * 生成物只含规范化、稳定排序的纯数据（DEFAULT_ARTIFACT_DECLARATIONS），判定逻辑（track predicate
 * 过滤、查询）在手写层 default-artifacts.ts，不进生成物。本脚本零第三方依赖（只用 node: 内建），
 * 自带窄 YAML 扫描器（不 import kernel 的 parse.ts——codegen 只需 Node、不需 TS build），fail-loud：
 * 结构/闭集/谓词任一违例即 throw 非零退出，不产出残缺表。
 *
 * FIELD_ORDER 闭集从 packages/kernel/src/types.ts 就地读取（单一真相源，防与 kernel 漂移）。
 * producer policy 闭集与 kernel workflow/types.ts 的 ArtifactProducerPolicy 对齐（本文件常量镜像）。
 *
 * 用法：node tools/generate-default-workflow.mjs        # 生成/覆盖 generated 文件
 * 幂等：同一 default.yaml 重跑产出逐字节一致（稳定排序 = step 声明序、artifact 声明序）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')
const DEFAULT_YAML = join(REPO_ROOT, 'templates', 'workflows', 'default.yaml')
const KERNEL_TYPES = join(REPO_ROOT, 'packages', 'kernel', 'src', 'types.ts')
const OUT_FILE = join(REPO_ROOT, 'packages', 'kernel', 'src', 'workflow', 'default-workflow.generated.ts')
const SOURCE_REL = 'templates/workflows/default.yaml'

const PRODUCER_POLICIES = new Set(['effective-step-skills', 'effective-phase-skills'])

// track predicate value 须是合法 track id（镜像 kernel tracks/types.ts 的 TRACK_ID_RE）——既杜绝
// 引号/换行/反斜杠等会破坏 generated TS 字符串（注入非法 TS，推迟到 tsc 才炸）的字符，又保证语义合法。
const TRACK_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/

const indentOf = (line) => line.length - line.trimStart().length

function fail(msg) {
  throw new Error(`generate-default-workflow: ${msg}`)
}

/** `[a, b]` 单行 flow-list（同 kernel parse.ts parseInlineList）。 */
function parseInlineList(raw) {
  const t = raw.trim()
  if (t === '[]') return []
  if (!t.startsWith('[') || !t.endsWith(']')) fail(`期望 [a, b] 形态的单行列表，实际 '${raw}'`)
  return t.slice(1, -1).split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

/** 从 kernel types.ts 文本提取 FIELD_ORDER 闭集（`FIELD_ORDER = [ ... ] as const`，去 // 注释后取
 *  单引号 token）。找不到块或空集 → fail-loud（防误判 field 合法域）。 */
export function extractFieldOrder(typesText) {
  const m = /export const FIELD_ORDER\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(typesText)
  if (!m) fail('无法从 packages/kernel/src/types.ts 定位 FIELD_ORDER 块')
  const body = m[1].replace(/\/\/[^\n]*/g, '')
  const fields = [...body.matchAll(/'([^']+)'/g)].map((x) => x[1])
  if (fields.length === 0) fail('FIELD_ORDER 提取为空')
  return fields
}

/**
 * 窄扫 default.yaml：抽取 name + 每个 step 的 id/label 与 artifacts[]（field/type/producerPolicy/requiredWhen）。
 * label 是 dashboard Todo 投影的默认步骤展示元数据；其余 step 字段（gate/skills/inputs/outputs/guards/
 * transitions）跳过。
 * artifact 子字段闭集：type（只 file_path）/ producer_policy / required_when（唯一谓词行 track_in|track_not_in）；
 * 未知子字段行 fail-loud。
 */
export function parseDefaultWorkflow(yamlText) {
  const lines = yamlText.split('\n')
  const nameMatch = /^name:\s*(\S+)\s*$/.exec(lines[0] ?? '')
  if (!nameMatch) fail('第一行必须是 "name: <name>"')
  const stepsIndex = lines.findIndex((line, index) => index > 0 && line.trim() === 'steps:' && indentOf(line) === 0)
  const tracksIndex = lines.findIndex((line, index) => index > 0 && line.trim() === 'tracks:' && indentOf(line) === 0)
  if (stepsIndex < 0 && tracksIndex < 0) fail('缺顶层 "steps:" 或 "tracks:"')
  const parsedSteps = stepsIndex < 0 ? { steps: [], next: tracksIndex } : parseStepItems(lines, stepsIndex + 1, 0)
  const steps = parsedSteps.steps
  const tracks = {}
  let i = parsedSteps.next
  if ((lines[i] ?? '').trim() === 'tracks:' && indentOf(lines[i] ?? '') === 0) {
    i++
    while (i < lines.length) {
      const line = lines[i] ?? ''
      if (line.trim() === '') { i++; continue }
      if (indentOf(line) === 0) break
      const idMatch = /^  ([a-z][a-z0-9_-]{0,31}):\s*$/.exec(line)
      if (!idMatch) fail(`tracks 下每条分支须是两空格缩进的 '<track-id>:'，实际 '${line}'`)
      const id = idMatch[1]
      if (tracks[id] !== undefined) fail(`tracks 重复声明分支 '${id}'`)
      i++
      let label
      let branchSteps
      while (i < lines.length) {
        const inner = lines[i] ?? ''
        if (inner.trim() === '') { i++; continue }
        if (indentOf(inner) <= 2) break
        const labelMatch = /^\s*label:\s*(.+?)\s*$/.exec(inner)
        if (labelMatch) { label = labelMatch[1]; i++; continue }
        // 分支文档契约由 kernel parse 负责；生成器只跳过该块（缩进深于键行的全部行）。
        if (/^\s*document_contract:\s*$/.test(inner)) {
          const blockIndent = indentOf(inner)
          i++
          while (i < lines.length && ((lines[i] ?? '').trim() === '' || indentOf(lines[i] ?? '') > blockIndent)) i++
          continue
        }
        if (/^\s*steps:\s*$/.test(inner)) {
          const parsedBranch = parseStepItems(lines, i + 1, indentOf(inner))
          branchSteps = parsedBranch.steps
          i = parsedBranch.next
          continue
        }
        fail(`分支 '${id}' 出现未知字段行 '${inner.trim()}'`)
      }
      if (branchSteps === undefined) fail(`分支 '${id}' 缺 steps`)
      tracks[id] = { label, steps: branchSteps }
    }
  }
  while (i < lines.length) {
    if ((lines[i] ?? '').trim() !== '') fail(`steps / tracks 之后出现无法识别的内容 '${lines[i].trim()}'`)
    i++
  }
  return { name: nameMatch[1], steps, tracks }
}

/** 连续的 `- id:` 步骤项（缩进 > blockIndent）；遇到缩进 ≤ blockIndent 的非空行即停。 */
function parseStepItems(lines, start, blockIndent) {
  const steps = []
  let i = start
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '') { i++; continue }
    if (indentOf(line) <= blockIndent) break
    const idMatch = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line)
    if (!idMatch) fail(`steps 下每项须以 "- id:" 开头，实际 '${line}'`)
    const stepIndent = indentOf(line)
    const id = idMatch[1]
    i++
    const artifacts = []
    let label
    while (i < lines.length) {
      const l = lines[i] ?? ''
      if (l.trim() === '') { i++; continue }
      if (indentOf(l) <= stepIndent) break // 下一个 step / EOF
      const labelMatch = /^\s*label:\s*(.+?)\s*$/.exec(l)
      if (labelMatch) {
        label = labelMatch[1]
        i++
        continue
      }
      if (/^\s*artifacts:\s*\[\]\s*$/.test(l)) { i++; continue }
      if (/^\s*artifacts:\s*$/.test(l)) {
        const blockIndent = indentOf(l)
        i++
        i = parseArtifactEntries(lines, i, blockIndent, artifacts)
        continue
      }
      i++ // 其余 step 字段行——跳过
    }
    steps.push({ id, label, artifacts })
  }
  return { steps, next: i }
}

/** 解析 `artifacts:` 下的逐条 `- field:` 项（缩进深于 blockIndent），返回消费到的行号。 */
function parseArtifactEntries(lines, start, blockIndent, out) {
  let i = start
  while (i < lines.length) {
    const l = lines[i] ?? ''
    if (l.trim() === '') { i++; continue }
    if (indentOf(l) <= blockIndent) break
    const fieldMatch = /^\s*-\s+field:\s*(\S+)\s*$/.exec(l)
    if (!fieldMatch) {
      // 已过 indentOf(l) <= blockIndent 检查 → 仍在 artifacts 块内。块内任何非 '- field:' 起始项
      // （缺 field / 子字段泄漏 / 格式错）都是畸形，必须 fail-loud——绝不 break 后被外层当"其余
      // step 字段"静默跳过而产出残缺表（违反本脚本 fail-loud 承诺）。
      fail(`artifacts 块内出现非 '- field:' 起始的畸形项：'${l.trim()}'（每条 artifact 必须以 '- field:' 开头、field 值非空）`)
    }
    const itemIndent = indentOf(l)
    const field = fieldMatch[1]
    i++
    let type
    let producerPolicy
    let requiredWhen
    while (i < lines.length) {
      const sl = lines[i] ?? ''
      if (sl.trim() === '') { i++; continue }
      if (indentOf(sl) <= itemIndent) break
      let m
      if ((m = /^\s*type:\s*(\S+)\s*$/.exec(sl))) {
        if (m[1] !== 'file_path') fail(`artifact '${field}' 的 type 只支持 file_path（实际 '${m[1]}'）`)
        type = 'file_path'; i++; continue
      }
      if ((m = /^\s*producer_policy:\s*(\S+)\s*$/.exec(sl))) { producerPolicy = m[1]; i++; continue }
      if (/^\s*required_when:\s*$/.test(sl)) {
        const whenIndent = indentOf(sl)
        i++
        while (i < lines.length && (lines[i] ?? '').trim() === '') i++
        const pl = lines[i] ?? ''
        if (indentOf(pl) <= whenIndent) fail(`artifact '${field}' required_when 缺 track_in/track_not_in 谓词行`)
        const pm = /^\s*(track_in|track_not_in):\s*(\[.*\])\s*$/.exec(pl)
        if (!pm) fail(`artifact '${field}' required_when 谓词只支持 track_in/track_not_in，实际 '${pl.trim()}'`)
        requiredWhen = { kind: pm[1] === 'track_in' ? 'track-in' : 'track-not-in', values: parseInlineList(pm[2]) }
        i++; continue
      }
      fail(`artifact '${field}' 出现未知字段行 '${sl.trim()}'`)
    }
    if (type === undefined) fail(`artifact '${field}' 缺 type`)
    if (producerPolicy === undefined) fail(`artifact '${field}' 缺 producer_policy`)
    out.push(requiredWhen === undefined ? { field, type, producerPolicy } : { field, type, producerPolicy, requiredWhen })
  }
  return i
}

/**
 * fail-loud 校验 + 规范化：name=default、step id 唯一、artifact field（step 内）唯一、field∈FIELD_ORDER、
 * type=file_path、producer_policy 属闭集、required_when 只 track_in/track_not_in 且 values 非空无重复无空串。
 * 返回按声明序排列、只含有 artifact 的 step 的表项 [{ stepId, artifacts }]。
 */
export function validateAndNormalize(parsed, fieldOrder) {
  if (parsed.name !== 'default') fail(`workflow name 必须是 'default'（实际 '${parsed.name}'）`)
  const out = {}
  if (parsed.steps.length > 0) out._base = normalizeBranchSteps(parsed.steps, fieldOrder)
  for (const [track, branch] of Object.entries(parsed.tracks ?? {})) {
    out[track] = normalizeBranchSteps(branch.steps, fieldOrder)
  }
  return out
}

function normalizeBranchSteps(steps, fieldOrder) {
  const fieldSet = new Set(fieldOrder)
  const seenStepIds = new Set()
  const table = []
  for (const step of steps) {
    if (seenStepIds.has(step.id)) fail(`step id '${step.id}' 重复`)
    seenStepIds.add(step.id)
    if (step.artifacts.length === 0) continue
    const seenFields = new Set()
    const artifacts = step.artifacts.map((a) => {
      if (seenFields.has(a.field)) fail(`step '${step.id}' 的 artifact field '${a.field}' 重复`)
      seenFields.add(a.field)
      if (!fieldSet.has(a.field)) fail(`step '${step.id}' 的 artifact field '${a.field}' 不在 FIELD_ORDER 闭集`)
      if (a.type !== 'file_path') fail(`step '${step.id}' 的 artifact '${a.field}' type 必须是 file_path`)
      if (!PRODUCER_POLICIES.has(a.producerPolicy)) {
        fail(`step '${step.id}' 的 artifact '${a.field}' producer_policy '${a.producerPolicy}' 不在闭集 ${[...PRODUCER_POLICIES].join('/')}`)
      }
      if (a.requiredWhen !== undefined) validatePredicate(step.id, a.field, a.requiredWhen)
      return a
    })
    table.push({ stepId: step.id, artifacts })
  }
  return table
}

function validatePredicate(stepId, field, pred) {
  if (pred.kind !== 'track-in' && pred.kind !== 'track-not-in') {
    fail(`step '${stepId}' 的 artifact '${field}' required_when 谓词 kind 非法：${pred.kind}`)
  }
  if (pred.values.length === 0) fail(`step '${stepId}' 的 artifact '${field}' required_when values 不得为空`)
  const seen = new Set()
  for (const v of pred.values) {
    if (typeof v !== 'string' || v === '') fail(`step '${stepId}' 的 artifact '${field}' required_when 含空/非字符串 value`)
    if (!TRACK_ID_RE.test(v)) fail(`step '${stepId}' 的 artifact '${field}' required_when value '${v}' 不是合法 track id（须匹配 ${TRACK_ID_RE}；杜绝引号/换行等破坏 generated TS 的字符）`)
    if (seen.has(v)) fail(`step '${stepId}' 的 artifact '${field}' required_when value '${v}' 重复`)
    seen.add(v)
  }
}

/** 单条 artifact → TS 对象字面量行（缩进 pad）。键序固定：kind/field/type/producerPolicy/requiredWhen。 */
function renderArtifact(a, pad) {
  const lines = [`${pad}{`]
  lines.push(`${pad}  kind: 'file',`)
  lines.push(`${pad}  field: '${a.field}',`)
  lines.push(`${pad}  type: 'file_path',`)
  lines.push(`${pad}  producerPolicy: '${a.producerPolicy}',`)
  if (a.requiredWhen !== undefined) {
    lines.push(`${pad}  requiredWhen: {`)
    lines.push(`${pad}    kind: '${a.requiredWhen.kind}',`)
    lines.push(`${pad}    values: [${a.requiredWhen.values.map((v) => `'${v}'`).join(', ')}],`)
    lines.push(`${pad}  },`)
  }
  lines.push(`${pad}},`)
  return lines
}

function renderDefaultStep(step) {
  if (typeof step.label !== 'string' || step.label.trim() === '') {
    fail(`step '${step.id}' 缺非空 label（Todo 阶段展示需要稳定标签）`)
  }
  if (/[\r\n]/.test(step.label)) fail(`step '${step.id}' label 不得含换行`)
  return `  { id: ${JSON.stringify(step.id)}, label: ${JSON.stringify(step.label)} },`
}

/** 规范化表 + 默认步骤元数据 → generated TS 文本（DO NOT EDIT 头 + 来源路径 + as const）。 */
export function renderGenerated(table, steps, yamlText) {
  const out = []
  out.push('/**')
  out.push(' * DO NOT EDIT —— 生成文件。')
  out.push(` * 由 tools/generate-default-workflow.mjs 从 ${SOURCE_REL} 生成。`)
  out.push(' * 重新生成：npm run generate:default-workflow')
  out.push(` * 来源：${SOURCE_REL}`)
  out.push(' *')
  out.push(' * 含稳定排序的 default step 元数据（通用分支）与按分支（_base + tracks.<id>）的 artifact declaration 纯数据；查询在')
  out.push(' * 手写层 default-artifacts.ts / todo-projection.ts。改 default.yaml 后须重跑生成（CI freshness')
  out.push(' * 门禁逐字节校验）。')
  out.push(' */')
  out.push("import type { DefaultArtifactDeclaration } from './default-artifacts.js'")
  out.push('')
  out.push(`export const DEFAULT_WORKFLOW_SOURCE = ${JSON.stringify(yamlText)}`)
  out.push('')
  out.push('export const DEFAULT_WORKFLOW_STEPS = [')
  for (const step of steps) out.push(renderDefaultStep(step))
  out.push('] as const')
  out.push('')
  out.push('export const DEFAULT_ARTIFACT_DECLARATIONS = {')
  for (const [branch, branchTable] of Object.entries(table)) {
    out.push(`  ${branch}: {`)
    for (const { stepId, artifacts } of branchTable) {
      out.push(`    ${stepId}: [`)
      for (const a of artifacts) out.push(...renderArtifact(a, '      '))
      out.push('    ],')
    }
    out.push('  },')
  }
  out.push('} as const satisfies Readonly<Record<string, Readonly<Record<string, readonly DefaultArtifactDeclaration[]>>>>')
  return out.join('\n') + '\n'
}

/** default.yaml + kernel types.ts → generated TS 文本（纯函数，供测试与 main 复用）。 */
export function generate(yamlText, typesText) {
  const fieldOrder = extractFieldOrder(typesText)
  const parsed = parseDefaultWorkflow(yamlText)
  const table = validateAndNormalize(parsed, fieldOrder)
  // 步骤元数据（Todo 投影的阶段标签）：有顶层 steps 用之，否则取第一条分支（default 各分支共享七阶段骨架）。
  const firstBranch = Object.values(parsed.tracks ?? {})[0]
  const metaSteps = parsed.steps.length > 0 ? parsed.steps : (firstBranch?.steps ?? [])
  if (metaSteps.length === 0) fail('default.yaml 没有任何阶段（steps 或 tracks 至少一个）')
  return renderGenerated(table, metaSteps, yamlText)
}

function main() {
  const yamlText = readFileSync(DEFAULT_YAML, 'utf8')
  const typesText = readFileSync(KERNEL_TYPES, 'utf8')
  const generated = generate(yamlText, typesText)
  writeFileSync(OUT_FILE, generated, 'utf8')
  process.stdout.write(`generated ${OUT_FILE}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}
