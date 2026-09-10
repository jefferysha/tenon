import type { WorkflowParseCursor } from './parse-document-contract.js'
import type { SkillRef } from './types.js'

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function parseInlineList(raw: string): string[] {
  const trimmed = raw.trim()
  if (trimmed === '[]') return []
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new Error(`workflow 解析错误：期望 [a, b] 形态的单行列表，实际 '${raw}'`)
  }
  return trimmed.slice(1, -1).split(',').map((value) => value.trim()).filter((value) => value.length > 0)
}

export function parseSkillRefs(cur: WorkflowParseCursor, baseIndent: number): SkillRef[] {
  const skills: SkillRef[] = []
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) < baseIndent) break
    const idMatch = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line)
    if (!idMatch) break
    const id = idMatch[1] ?? ''
    const childIndent = indentOf(line) + 2
    cur.i++
    let depends_on: string[] | undefined
    let kind: SkillRef['kind']
    let review_lane: string | undefined
    while (cur.i < cur.lines.length) {
      const next = cur.lines[cur.i] ?? ''
      if (next.trim() === '') { cur.i++; continue }
      if (indentOf(next) < childIndent) break
      const depMatch = /^\s*depends_on:\s*(\[.*\])\s*$/.exec(next)
      const kindMatch = /^\s*kind:\s*(work|review)\s*$/.exec(next)
      const laneMatch = /^\s*review_lane:\s*(\S+)\s*$/.exec(next)
      if (depMatch) {
        if (depends_on !== undefined) throw new Error(`workflow 解析错误：skill '${id}' 重复声明 depends_on`)
        depends_on = parseInlineList(depMatch[1] ?? '')
      } else if (kindMatch) {
        if (kind !== undefined) throw new Error(`workflow 解析错误：skill '${id}' 重复声明 kind`)
        kind = kindMatch[1] as SkillRef['kind']
      } else if (laneMatch) {
        if (review_lane !== undefined) throw new Error(`workflow 解析错误：skill '${id}' 重复声明 review_lane`)
        review_lane = laneMatch[1]
      } else throw new Error(`workflow 解析错误：skill '${id}' 出现未知字段行 '${next.trim()}'`)
      cur.i++
    }
    skills.push({
      id,
      ...(kind === undefined ? {} : { kind }),
      ...(review_lane === undefined ? {} : { review_lane }),
      ...(depends_on === undefined ? {} : { depends_on }),
    })
  }
  return skills
}
