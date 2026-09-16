/**
 * `artifacts:` 块的窄解析；语义层的 field / policy 校验留在 compileWorkflow。
 */
import type { ArtifactProducerPolicy, WorkflowArtifactConfig } from './types.js'
import type { FieldName } from '../types.js'
import type { TrackPredicate } from './predicates.js'
import type { WorkflowParseCursor as Cursor } from './parse-document-contract.js'
import { indentOf, parseWhenBlock } from './parse-primitives.js'

/** Parse explicit file artifacts; semantic field/policy checks stay in compileWorkflow. */
export function parseArtifactsBlock(cur: Cursor, baseIndent: number): WorkflowArtifactConfig[] {
  const arts: WorkflowArtifactConfig[] = []
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) < baseIndent) break
    const fieldMatch = /^\s*-\s+field:\s*(\S+)\s*$/.exec(line)
    if (!fieldMatch) break
    const itemIndent = indentOf(line)
    cur.i++
    let type: 'file_path' | undefined
    let producerPolicy: ArtifactProducerPolicy | undefined
    let requiredWhen: TrackPredicate | undefined
    while (cur.i < cur.lines.length) {
      const l = cur.lines[cur.i] ?? ''
      if (l.trim() === '') { cur.i++; continue }
      if (indentOf(l) <= itemIndent) break
      let m: RegExpExecArray | null
      if ((m = /^\s*type:\s*(\S+)\s*$/.exec(l))) {
        if (m[1] !== 'file_path') throw new Error(`workflow 解析错误：artifact '${fieldMatch[1]}' 的 type 只支持 file_path（实际 '${m[1]}'）`)
        type = 'file_path'; cur.i++; continue
      }
      if ((m = /^\s*producer_policy:\s*(\S+)\s*$/.exec(l))) { producerPolicy = m[1] as ArtifactProducerPolicy; cur.i++; continue }
      if (/^\s*required_when:\s*$/.test(l)) { const wi = indentOf(l); cur.i++; requiredWhen = parseWhenBlock(cur, wi); continue }
      throw new Error(`workflow 解析错误：artifact '${fieldMatch[1]}' 出现未知字段行 '${l.trim()}'`)
    }
    if (type === undefined) throw new Error(`workflow 解析错误：artifact '${fieldMatch[1]}' 缺 type`)
    if (producerPolicy === undefined) throw new Error(`workflow 解析错误：artifact '${fieldMatch[1]}' 缺 producer_policy`)
    const field = fieldMatch[1]! as FieldName
    arts.push(requiredWhen === undefined ? { field, type, producerPolicy } : { field, type, producerPolicy, requiredWhen })
  }
  return arts
}
