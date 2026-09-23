/**
 * 新 capability 主规格的 `## Purpose`。
 *
 * 上游 `openspec archive` 为第一次出现的 capability 生成主规格时，Purpose 固定写成
 * `TBD - created by archiving change <c>. Update Purpose after archive.`（specs-apply.js
 * buildSpecSkeleton）。`tenon spec apply` 的差异就取自那次归档，于是每个新 capability 都带着
 * 占位 Purpose 进了 `openspec/specs/`，ship 门禁也拦不住——它只核对回执与盘上字节。
 *
 * 真实的 Purpose 出自 change 自己的 proposal：`### New Capabilities` 下点名该 capability 的那一条
 * 说明优先，否则取 `## Why` 的第一段。两处都只有骨架占位（或没有）时拒绝应用并点名要填哪里，
 * 不把 TBD 写进主规格。
 */

/** 上游占位 Purpose 的那一行（整行）。 */
const UPSTREAM_TBD = /^TBD - created by archiving change .*$/mu

/** 骨架占位行：`> [待填写:open] …` / `> [pending:open] …`（与 kernel 模板渲染器同一记号）。 */
const PLACEHOLDER = /^>\s*\[(?:待填写|pending)[:\]]/u

function sectionBody(markdown: string, heading: RegExp): readonly string[] {
  const lines = markdown.split(/\r?\n/u)
  const start = lines.findIndex((line) => heading.test(line))
  if (start < 0) return []
  const level = /^(#+)/u.exec(lines[start] ?? '')?.[1]?.length ?? 2
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    const next = /^(#+)\s/u.exec(line)
    if (next !== null && (next[1]?.length ?? 0) <= level) break
    body.push(line)
  }
  return body
}

function meaningful(line: string): boolean {
  const text = line.trim()
  return text !== '' && !PLACEHOLDER.test(text) && !/^#+\s/u.test(text)
}

/** `### New Capabilities` 下点名 capability 的那条列表项的说明（`- \`cap\`: 说明`）。 */
function capabilityLine(proposal: string, capability: string): string | undefined {
  const escaped = capability.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const item = new RegExp(`^\\s*[-*+]\\s+\`?${escaped}\`?\\s*[:：-]\\s*(.+)$`, 'u')
  for (const line of sectionBody(proposal, /^#{2,4}\s+New Capabilities\s*$/iu)) {
    const text = item.exec(line)?.[1]?.trim()
    if (text !== undefined && text !== '' && !PLACEHOLDER.test(text)) return text
  }
  return undefined
}

/** `## Why` 的第一段（连续的非空行，去掉引用记号）。 */
function whyParagraph(proposal: string): string | undefined {
  const paragraph: string[] = []
  for (const line of sectionBody(proposal, /^##\s+Why\s*$/iu)) {
    if (meaningful(line)) {
      paragraph.push(line.trim().replace(/^>\s*/u, ''))
    } else if (paragraph.length > 0) {
      break
    }
  }
  const text = paragraph.join(' ').trim()
  return text === '' ? undefined : text
}

export function proposalPurpose(proposal: string | null, capability: string): string | undefined {
  if (proposal === null) return undefined
  return capabilityLine(proposal, capability) ?? whyParagraph(proposal)
}

/** 主规格文本里还有上游占位 Purpose 吗。 */
export function hasPlaceholderPurpose(spec: string): boolean {
  return UPSTREAM_TBD.test(spec)
}

/** 占位行、它的行尾，以及紧随其后的空行（没有空行时不参与匹配）。 */
const PLACEHOLDER_PURPOSE_BLOCK = /^TBD - created by archiving change .*?(\r?\n|$)(\r?\n)?/mu

/**
 * 把上游占位 Purpose 换成 proposal 给出的真实 Purpose；没有占位时原样返回。
 * 返回 undefined = 有占位但 proposal 给不出 Purpose（调用方拒绝应用）。
 */
export function fillPurpose(spec: string, purpose: string | undefined): string | undefined {
  if (!hasPlaceholderPurpose(spec)) return spec
  if (purpose === undefined) return undefined
  // 上游归档重排主规格时吃掉了段间空行（`TBD…` 下一行紧跟 `## Requirements`）：Purpose 段落与下一个
  // 标题之间补回一个空行；已经有空行或占位行就在文件末尾时不动。
  return spec.replace(PLACEHOLDER_PURPOSE_BLOCK, (_match: string, eol: string, blank: string | undefined) =>
    `${purpose}${eol}${blank ?? (eol === '' ? '' : eol)}`)
}
