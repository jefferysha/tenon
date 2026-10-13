#!/usr/bin/env node
/**
 * generate-default-workflow.mjs（G2 P4）——从 templates/workflows/default.yaml 的步骤展示元数据
 * 生成只读 TS 数据表 packages/kernel/src/workflow/default-workflow.generated.ts。
 *
 * 生成物只含两份内建工作流原文（default / design-system）与 default 的步骤展示元数据（id / label）。
 * 文档产出不再有声明表：Tenon 在离开步骤时观察实际产出，必须产出写成 `required-output` 守卫，由工作流 YAML 自己带着。
 * 本脚本零第三方依赖（只用 node: 内建），自带窄 YAML 扫描器（不 import kernel 的 parse.ts——codegen 只需 Node、
 * 不需 TS build），fail-loud：结构违例即 throw 非零退出，不产出残缺表。
 *
 * 用法：node tools/generate-default-workflow.mjs        # 生成/覆盖 generated 文件
 * 幂等：同一 default.yaml 重跑产出逐字节一致。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')
const DEFAULT_YAML = join(REPO_ROOT, 'templates', 'workflows', 'default.yaml')
const OUT_FILE = join(REPO_ROOT, 'packages', 'kernel', 'src', 'workflow', 'default-workflow.generated.ts')
const SOURCE_REL = 'templates/workflows/default.yaml'
const DESIGN_SYSTEM_YAML = join(REPO_ROOT, 'templates', 'workflows', 'design-system.yaml')
const DESIGN_SYSTEM_REL = 'templates/workflows/design-system.yaml'

const indentOf = (line) => line.length - line.trimStart().length

function fail(msg) {
  throw new Error(`generate-default-workflow: ${msg}`)
}

/**
 * 窄扫 default.yaml：抽取 name + 每个 step 的 id/label 与分支的 label/spec。
 * label 是 dashboard Todo 投影的默认步骤展示元数据；其余 step 字段（gate/skills/guards/transitions 以及升级前
 * 模板里的 inputs/outputs/artifacts）一律跳过。
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
      let spec
      let branchSteps
      while (i < lines.length) {
        const inner = lines[i] ?? ''
        if (inner.trim() === '') { i++; continue }
        if (indentOf(inner) <= 2) break
        const labelMatch = /^\s*label:\s*(.+?)\s*$/.exec(inner)
        if (labelMatch) { label = labelMatch[1]; i++; continue }
        // `spec: openspec | none` 决定哪些分支是「受 OpenSpec 治理的七阶段骨架」（见 generate 的 metaSteps）。
        const specMatch = /^\s*spec:\s*(openspec|none)\s*$/.exec(inner)
        if (specMatch) { spec = specMatch[1]; i++; continue }
        // 升级前模板的分支文档契约与路由 / 自动化设置由 kernel parse 负责；生成器只跳过这些块（缩进深于键行的全部行）。
        if (/^\s*(document_contract|route|automation):\s*(\{.*\})?\s*$/.test(inner)) {
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
      tracks[id] = { label, ...(spec === undefined ? {} : { spec }), steps: branchSteps }
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
    let label
    while (i < lines.length) {
      const l = lines[i] ?? ''
      if (l.trim() === '') { i++; continue }
      if (indentOf(l) <= stepIndent) break // 下一个 step / EOF
      // 只认步骤自己的 label（键缩进 = `- ` 之后那一列）；tests 等子项里的 label 属于子项。
      const labelMatch = indentOf(l) === stepIndent + 2 ? /^\s*label:\s*(.+?)\s*$/.exec(l) : null
      if (labelMatch) label = labelMatch[1]
      i++ // 其余 step 字段行——跳过
    }
    steps.push({ id, label })
  }
  return { steps, next: i }
}

/** fail-loud 校验：name=default、同一分支（或顶层 steps）内 step id 唯一。分支之间是各自完整的 pipeline，可以同名。 */
export function validateDefaultWorkflow(parsed) {
  if (parsed.name !== 'default') fail(`workflow name 必须是 'default'（实际 '${parsed.name}'）`)
  const branches = [parsed.steps, ...Object.values(parsed.tracks ?? {}).map((branch) => branch.steps)]
  for (const steps of branches) {
    const seen = new Set()
    for (const step of steps) {
      if (seen.has(step.id)) fail(`step id '${step.id}' 重复`)
      seen.add(step.id)
    }
  }
  return parsed
}

function renderDefaultStep(step) {
  if (typeof step.label !== 'string' || step.label.trim() === '') {
    fail(`step '${step.id}' 缺非空 label（Todo 阶段展示需要稳定标签）`)
  }
  if (/[\r\n]/.test(step.label)) fail(`step '${step.id}' label 不得含换行`)
  return `  { id: ${JSON.stringify(step.id)}, label: ${JSON.stringify(step.label)} },`
}

/** 默认步骤元数据 + 两份内建工作流原文 → generated TS 文本（DO NOT EDIT 头 + 来源路径 + as const）。 */
export function renderGenerated(steps, yamlText, designSystemYaml = '') {
  const out = []
  out.push('/**')
  out.push(' * DO NOT EDIT —— 生成文件。')
  out.push(` * 由 tools/generate-default-workflow.mjs 从 ${SOURCE_REL} 生成。`)
  out.push(' * 重新生成：npm run generate:default-workflow')
  out.push(` * 来源：${SOURCE_REL}、${DESIGN_SYSTEM_REL}`)
  out.push(' *')
  out.push(' * 含两份内建工作流原文与稳定排序的 default step 元数据（通用分支）；查询在手写层 todo-projection.ts。')
  out.push(' * 改 default.yaml 后须重跑生成（CI freshness 门禁逐字节校验）。')
  out.push(' */')
  out.push(`export const DEFAULT_WORKFLOW_SOURCE = ${JSON.stringify(yamlText)}`)
  out.push('')
  out.push(`export const DESIGN_SYSTEM_WORKFLOW_SOURCE = ${JSON.stringify(designSystemYaml)}`)
  out.push('')
  out.push('export const DEFAULT_WORKFLOW_STEPS = [')
  for (const step of steps) out.push(renderDefaultStep(step))
  out.push('] as const')
  return out.join('\n') + '\n'
}

/** default.yaml + design-system.yaml → generated TS 文本（纯函数，供测试与 main 复用）。 */
export function generate(yamlText, designSystemYaml = '') {
  const parsed = validateDefaultWorkflow(parseDefaultWorkflow(yamlText))
  // 步骤元数据（Todo 投影的阶段标签）：有顶层 steps 用之，否则取第一条受 OpenSpec 治理的分支（`spec: none` 的轻量分支
  // 只有五步，不是 default 的七阶段骨架；它排在最前也不能被选中）。分支全是 `spec: none` 时退回第一条。
  const branches = Object.values(parsed.tracks ?? {})
  const skeleton = branches.find((branch) => branch.spec !== 'none') ?? branches[0]
  const metaSteps = parsed.steps.length > 0 ? parsed.steps : (skeleton?.steps ?? [])
  if (metaSteps.length === 0) fail('default.yaml 没有任何阶段（steps 或 tracks 至少一个）')
  return renderGenerated(metaSteps, yamlText, designSystemYaml)
}

function main() {
  const yamlText = readFileSync(DEFAULT_YAML, 'utf8')
  const generated = generate(yamlText, readFileSync(DESIGN_SYSTEM_YAML, 'utf8'))
  writeFileSync(OUT_FILE, generated, 'utf8')
  process.stdout.write(`generated ${OUT_FILE}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}
