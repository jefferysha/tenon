/**
 * 窄解析器 —— 仅支持 CONTRACT §1 子集（flat `key: value` + 4 个列表字段的块序列 +
 * 单层去引号 + 尾部不透明历史区）。禁 yaml 包：通用解析器的引号/锚点语义会
 * 悄悄偏离老内核三读取器（grep/sed / pyyaml-fallback / dashboard）契约。
 */
import {
  FIELD_ORDER,
  LIST_FIELDS,
  QuoteGateError,
  PRE_VERIFY_REVIEW_DEFAULT,
  PRE_VERIFY_REVIEW_FIELD,
  REVIEW_GATE_FIELDS,
  REVIEW_GATE_FIELD_DEFAULTS,
  type FieldName,
  type PipelineState,
} from '../types.js'
import {
  parseProjectionMetadataLines, parseRunMetadataLines,
  serializeProjectionMetadataLines, serializeRunMetadataLines,
} from './run-metadata.js'

const KNOWN_FIELDS: ReadonlySet<string> = new Set(FIELD_ORDER)
const LIST_FIELD_SET: ReadonlySet<string> = new Set(LIST_FIELDS)
const REVIEW_GATE_FIELD_SET: ReadonlySet<string> = new Set(REVIEW_GATE_FIELDS)
/** 块序列项前缀（两空格 + `- `），对齐老内核 yaml_append_list_item / trim_history 的 `^  - ` */
const LIST_ITEM_PREFIX = '  - '
const KEY_RE = /^([A-Za-z0-9_]+):(.*)$/

/**
 * 单层去引号 —— 口径同老内核 state-lib.sh `_unquote_scalar`：
 * 三条件才剥（长度≥2、首尾同字符、是 " 或 '），只剥最外一层、不递归。
 */
export function unquoteScalar(s: string): string {
  if (s.length >= 2) {
    const first = s.charAt(0)
    const last = s.charAt(s.length - 1)
    if (first === last && (first === '"' || first === "'")) return s.slice(1, -1)
  }
  return s
}

/**
 * 全量 46 字段骨架，缺省空串（CONTRACT §1：写回时缺省字段写空串）；
 * `workflow` 例外，缺省 `'default'`——下游需能直接判断"是否为默认 workflow"，
 * 不应该还要处理"空串等价于 default"这种隐式约定。
 */
export function emptyFields(): Record<FieldName, string | string[]> {
  const fields = {} as Record<FieldName, string | string[]>
  for (const f of FIELD_ORDER) {
    fields[f] = f === 'workflow'
      ? 'default'
      : f === PRE_VERIFY_REVIEW_FIELD
        ? PRE_VERIFY_REVIEW_DEFAULT
        : REVIEW_GATE_FIELD_SET.has(f)
          ? REVIEW_GATE_FIELD_DEFAULTS[f as typeof REVIEW_GATE_FIELDS[number]]
        : ''
  }
  return fields
}

/**
 * 四闸 —— 对齐老内核 yaml_set：值含换行/回车、「: 」、「 #」或首字符为引号 → fail-loud 拒写。
 * 时间戳的「:」无空格、不触闸；空串无首字符、不触引号闸（序列化为 ""）。
 */
export function quoteGate(field: FieldName, value: string): void {
  if (value.includes('\n') || value.includes('\r')) {
    throw new QuoteGateError(field, 'value contains a newline/carriage return (would inject fake fields)')
  }
  if (value.includes(': ')) {
    throw new QuoteGateError(field, 'value contains ": " (would break YAML parsing)')
  }
  if (value.includes(' #')) {
    throw new QuoteGateError(field, 'value contains " #" (would be eaten as an inline comment)')
  }
  const first = value.charAt(0)
  if (first === '"' || first === "'") {
    throw new QuoteGateError(field, 'value starts with a quote (would break YAML parsing)')
  }
}

/**
 * 解析 `.pipeline.yaml` 全文：
 * - 自顶向下消费「已知字段」行（含列表字段的块序列续行）；
 * - 已知字段之后尝试识别内部提交元数据三行块（W1 第二增量，run-metadata.ts）——匹配则消费，
 *   不匹配（含损坏/截断）则原样交还，不吞任何字节；
 * - 再往后第一行未知 key / 非 key 行起，整段到 EOF 作 opaqueTail 逐字保留
 *   （老内核 tools_history:/prompts_history:/transitions_history: base64 区块与
 *   pipeline_mode 等未知平字段都落在这里——读跳过、写回原样）。
 */
export function parsePipeline(content: string): PipelineState {
  const lines = content.split('\n')
  const fields = emptyFields()
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const m = KEY_RE.exec(line)
    if (!m) break
    const key = m[1] ?? ''
    if (!KNOWN_FIELDS.has(key)) break
    const field = key as FieldName
    const rest = (m[2] ?? '').trim()
    i++
    if (LIST_FIELD_SET.has(field)) {
      if (rest === '') {
        // 块序列：`key:` 换行 + 两空格 `- item`
        const items: string[] = []
        while (i < lines.length && (lines[i] ?? '').startsWith(LIST_ITEM_PREFIX)) {
          items.push(unquoteScalar((lines[i] ?? '').slice(LIST_ITEM_PREFIX.length).trim()))
          i++
        }
        fields[field] = items
      } else if (rest === '[]') {
        fields[field] = []
      } else {
        // flat 标量（如 `scope: null` / 逗号串）保持 string
        fields[field] = unquoteScalar(rest)
      }
    } else {
      fields[field] = unquoteScalar(rest)
    }
  }
  const { metadata, consumedLines } = parseRunMetadataLines(lines.slice(i))
  i += consumedLines
  const projection = parseProjectionMetadataLines(lines.slice(i))
  i += projection.consumedLines
  return {
    fields,
    ...(metadata === undefined ? {} : { runMetadata: metadata }),
    ...(projection.metadata === undefined ? {} : { projectionMetadata: projection.metadata }),
    opaqueTail: lines.slice(i).join('\n'),
  }
}

/**
 * 严格按 FIELD_ORDER 写回；每个值过四闸。review-gate 是一组可选的出口收据：内存/canonical
 * state 始终拥有完整 receipt 字段，但这些值全空时不污染既有 YAML projection；任一值存在时整组写出，
 * 防止 pending/approved receipt 被拆成不完整的半组。FIELD_ORDER 之后写内部提交元数据三行块
 * （runMetadata 存在时；不进 FIELD_ORDER，不受四闸约束——值恒为 repository 生成的 UUID/整数，
 * 不含用户输入）；再拼回 opaqueTail。空串标量写 `""`（对齐老内核 heredoc 的 automation_* 空值
 * 表示），空列表写 `[]`。
 */
export function serializePipeline(
  state: PipelineState,
  options: { readonly omitFields?: readonly FieldName[] } = {},
): string {
  const out: string[] = []
  // Omitted fields (the companion-backed logical fields of an N-1 projection) are absent from the
  // wire state; they neither produce a line nor count as a live receipt value.
  const omitted: ReadonlySet<string> = new Set(options.omitFields ?? [])
  const hasReviewGateReceipt = REVIEW_GATE_FIELDS.some((field) => {
    if (omitted.has(field)) return false
    const value = state.fields[field]
    return Array.isArray(value) ? value.length > 0 : value !== '' && !(field === 'review_acknowledged_via' && value === 'unknown')
  })
  for (const field of FIELD_ORDER) {
    if (omitted.has(field)) continue
    if (REVIEW_GATE_FIELD_SET.has(field) && !hasReviewGateReceipt) continue
    const value = state.fields[field] ?? ''
    if (Array.isArray(value)) {
      for (const item of value) quoteGate(field, item)
      if (value.length === 0) {
        out.push(`${field}: []`)
      } else {
        out.push(`${field}:`)
        for (const item of value) out.push(`${LIST_ITEM_PREFIX}${item}`)
      }
    } else {
      quoteGate(field, value)
      out.push(`${field}: ${value === '' ? '""' : value}`)
    }
  }
  out.push(...serializeRunMetadataLines(state.runMetadata))
  out.push(...serializeProjectionMetadataLines(state.projectionMetadata))
  return out.join('\n') + '\n' + state.opaqueTail
}
