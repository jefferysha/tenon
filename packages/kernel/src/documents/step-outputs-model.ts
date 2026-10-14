/**
 * 步骤产出的纯规则（设计 §4–§6）：文档判定、来源标注、直接上游交接、读取判定、必须产出的路径模式。
 * 不读盘、不起进程；读盘与 git 在 state/step-output-ledger.ts 与 workspace/step-checkpoint.ts。
 */
import type { StepInputRead, StepOutputLedger } from '../state/step-output-ledger.js'

const DOCUMENT_EXTENSION = /\.(?:md|mdx|markdown)$/iu
const ORCHESTRATOR_SKILLS: ReadonlySet<string> = new Set(['tenon', 'tenon:tenon'])

export function isDocumentPath(path: string): boolean {
  return DOCUMENT_EXTENSION.test(path)
}

export interface SkillLoad { readonly skill: string; readonly at: string }

/** 修改时间之前（按秒）最后加载的技能；`recorded_at` 只到秒，所以两边都取整秒比较。 */
export function attributeSkill(mtimeMs: number, loads: readonly SkillLoad[]): string | null {
  if (!Number.isFinite(mtimeMs)) return null
  const second = Math.floor(mtimeMs / 1000)
  let picked: { readonly skill: string; readonly at: number } | null = null
  for (const load of loads) {
    if (ORCHESTRATOR_SKILLS.has(load.skill)) continue
    const at = Math.floor(Date.parse(load.at) / 1000)
    if (!Number.isFinite(at) || at > second) continue
    if (picked === null || at >= picked.at) picked = { skill: load.skill, at }
  }
  return picked?.skill ?? null
}

export interface HandoffInput { readonly path: string; readonly sha256: string; readonly fromStep: string; readonly skill: string | null }

/** 交接给 `sequence` 这次访问的输入：同一 run 里上一次访问（转入当前步骤的那次）新增或修改的文档；更早的不交接。 */
export function handoffInputs(ledger: StepOutputLedger, runId: string, sequence: number): readonly HandoffInput[] {
  const upstream = ledger.visits.find((visit) => visit.run_id === runId && visit.sequence === sequence - 1)
  if (upstream === undefined) return []
  const inputs: HandoffInput[] = []
  for (const output of upstream.outputs) {
    if (output.change === 'deleted' || output.sha256 === null || !isDocumentPath(output.path)) continue
    inputs.push({ path: output.path, sha256: output.sha256, fromStep: upstream.step, skill: output.skill })
  }
  return inputs
}

/** 回执摘要等于上游记下的摘要或文件当前的摘要都算读过：读完上游版本后本步再改它，回执仍有效。 */
export function isInputRead(input: HandoffInput, reads: readonly StepInputRead[], currentSha: string | null): boolean {
  return reads.some((read) => read.path === input.path && (read.sha256 === input.sha256 || read.sha256 === currentSha))
}

const PLACEHOLDER = /\{([^}]*)\}/gu
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u

export function validateOutputPattern(pattern: string): string | null {
  if (pattern.trim() === '') return 'required-output 的 path 不能为空'
  if (CONTROL_CHARS.test(pattern)) return 'required-output 的 path 不能含控制字符'
  if (pattern.startsWith('/') || /^[A-Za-z]:/u.test(pattern)) return `required-output 的 path 必须是项目相对路径：${pattern}`
  if (pattern.includes('\\')) return `required-output 的 path 必须用 / 分隔：${pattern}`
  const segments = pattern.split('/')
  if (segments.includes('..')) return `required-output 的 path 不能含 ..：${pattern}`
  if (segments.some((segment) => segment === '' || segment === '.')) return `required-output 的 path 不能含空段或 . 段：${pattern}`
  for (const match of pattern.matchAll(PLACEHOLDER)) {
    if (match[1] !== 'change') return `required-output 的 path 只支持 {change} 占位：${pattern}`
  }
  if (segments.some((segment) => segment !== '**' && segment.includes('**'))) return `required-output 的 ** 必须单独占一段：${pattern}`
  return null
}

// 模式按「段」匹配而不是编译成正则：用户写的模式进不了回溯，最坏是模式段数 × 路径段数的多项式时间。
type Token = { readonly kind: 'literal'; readonly char: string } | { readonly kind: 'star' } | { readonly kind: 'any' }
type PatternPart = readonly Token[] | 'globstar'

/** 任务名按字面展开，里头的 * ? 不会变成通配。 */
function segmentTokens(segment: string, change: string): Token[] {
  const tokens: Token[] = []
  segment.split('{change}').forEach((piece, index) => {
    if (index > 0) for (const char of change) tokens.push({ kind: 'literal', char })
    for (const char of piece) {
      if (char === '*') { if (tokens.at(-1)?.kind !== 'star') tokens.push({ kind: 'star' }) }
      else tokens.push(char === '?' ? { kind: 'any' } : { kind: 'literal', char })
    }
  })
  return tokens
}

/** 段内匹配：`*` 任意长度、`?` 一个字符；回到最近的 `*` 重试，不递归。 */
function matchSegment(tokens: readonly Token[], text: readonly string[]): boolean {
  let tokenIndex = 0
  let textIndex = 0
  let starToken = -1
  let starText = 0
  while (textIndex < text.length) {
    const token = tokens[tokenIndex]
    if (token?.kind === 'star') {
      starToken = tokenIndex
      starText = textIndex
      tokenIndex += 1
    } else if (token !== undefined && (token.kind === 'any' || token.char === text[textIndex])) {
      tokenIndex += 1
      textIndex += 1
    } else if (starToken >= 0) {
      starText += 1
      textIndex = starText
      tokenIndex = starToken + 1
    } else {
      return false
    }
  }
  while (tokens[tokenIndex]?.kind === 'star') tokenIndex += 1
  return tokenIndex === tokens.length
}

/** `**` 匹配零段或多段；(模式位置, 路径位置) 记忆化，每对只算一次。 */
function matchParts(parts: readonly PatternPart[], segments: readonly (readonly string[])[]): boolean {
  const memo = new Map<number, boolean>()
  const walk = (partIndex: number, segmentIndex: number): boolean => {
    if (partIndex === parts.length) return segmentIndex === segments.length
    const key = partIndex * (segments.length + 1) + segmentIndex
    const known = memo.get(key)
    if (known !== undefined) return known
    const part = parts[partIndex]
    const segment = segments[segmentIndex]
    const matched = part === 'globstar'
      ? walk(partIndex + 1, segmentIndex) || (segment !== undefined && walk(partIndex, segmentIndex + 1))
      : part !== undefined && segment !== undefined && matchSegment(part, segment) && walk(partIndex + 1, segmentIndex + 1)
    memo.set(key, matched)
    return matched
  }
  return walk(0, 0)
}

export function matchesOutputPattern(pattern: string, change: string, path: string): boolean {
  const parts = pattern.split('/').map((segment): PatternPart => (segment === '**' ? 'globstar' : segmentTokens(segment, change)))
  return matchParts(parts, path.split('/').map((segment) => Array.from(segment)))
}

/**
 * 模式里第一个带通配符的段之前的目录（`{change}` 已展开）：观察不可用时只需要在这里往下找文件。
 * 模式不带通配符时 `exact` 为真，`directory` 就是那个文件本身。
 */
export function staticPatternDirectory(pattern: string, change: string): { readonly directory: string; readonly exact: boolean } {
  const segments = pattern.split('/')
  const fixed: string[] = []
  for (const segment of segments) {
    if (/[*?]/u.test(segment)) break
    fixed.push(segment.replaceAll('{change}', change))
  }
  return { directory: fixed.join('/'), exact: fixed.length === segments.length }
}
