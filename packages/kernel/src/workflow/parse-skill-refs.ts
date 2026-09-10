import type { WorkflowParseCursor } from './parse-document-contract.js'
import type { TrackPredicate } from './predicates.js'
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
    let when: TrackPredicate | undefined
    while (cur.i < cur.lines.length) {
      const next = cur.lines[cur.i] ?? ''
      if (next.trim() === '') { cur.i++; continue }
      if (indentOf(next) < childIndent) break
      const depMatch = /^\s*depends_on:\s*(\[.*\])\s*$/.exec(next)
      const kindMatch = /^\s*kind:\s*(work|review)\s*$/.exec(next)
      const laneMatch = /^\s*review_lane:\s*(\S+)\s*$/.exec(next)
      if (/^\s*when:\s*$/.test(next)) {
        if (when !== undefined) throw new Error(`workflow 解析错误：skill '${id}' 重复声明 when`)
        const whenIndent = indentOf(next)
        cur.i++
        while (cur.i < cur.lines.length && (cur.lines[cur.i] ?? '').trim() === '') cur.i++
        const predicate = cur.lines[cur.i] ?? ''
        const predicateMatch = /^\s*(track_in|track_not_in):\s*(\[.*\])\s*$/.exec(predicate)
        if (indentOf(predicate) <= whenIndent || !predicateMatch) {
          throw new Error(`workflow 解析错误：skill '${id}' 的 when 只支持 'track_in: [..]' 或 'track_not_in: [..]'`)
        }
        when = { kind: predicateMatch[1] === 'track_in' ? 'track-in' : 'track-not-in', values: parseInlineList(predicateMatch[2] ?? '') }
        cur.i++
        continue
      }
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
      ...(when === undefined ? {} : { when }),
    })
  }
  return skills
}
