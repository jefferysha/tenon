/**
 * 路由表 → `router.sh` 读的项目缓存（`router.v6`）。
 *
 * 缓存是项目内可写的文件，所以它只能是纯数据：固定字段、`|` 分隔、所有自由文本都是 UTF-8 hex——
 * 没有 shell 赋值、引号或命令替换，hook 逐行校验并解码，绝不 `source` / `eval` 它。
 *
 *   TENON_ROUTER_V6
 *   M|<hex projectRoot>|<sourceDigest>
 *   R|<order>|<priority>|<hex workflow>|<hex track>|<hex label>|<routable>|<fallback>|<builtin>|<hex pattern>|<hex exclude>
 *
 * `pattern` / `exclude` 是关键词表拼成的 `grep -E` 备选式（关键词按字面量转义），空串表示没有。
 */
import type { RouterRow, RouterTable } from './router-table.js'
import { MAX_ROUTER_ROWS } from './router-table.js'

export const ROUTER_CACHE_HEADER = 'TENON_ROUTER_V6'

const ERE_SPECIAL = /[\\^$.|?*+()[\]{}]/gu
/** workflow / track 名会原样进入宿主可读的 dispatch：与 `router.sh` 的 `_route_name_ok` 同一收窄。 */
const NAME_RE = /^[^\s<>|;=\p{Cc}]{1,160}$/u
const MAX_LABEL_CHARS = 64

/** 关键词表 → 不区分大小写匹配用的 ERE 备选式；每个词的正则元字符都转义成字面量，空表给空串。 */
export function routePattern(terms: readonly string[]): string {
  if (terms.length === 0) return ''
  const escaped = terms.map((term) => {
    // 换行会让 grep 把一个模式拆成多个模式，NUL 无法进入 bash 字符串：编译层已拒绝，这里是最后一道门。
    if (term === '' || /[\n\r\0]/u.test(term)) throw new Error(`路由词不合法：${JSON.stringify(term)}`)
    return term.replace(ERE_SPECIAL, '\\$&')
  })
  return `(${escaped.join('|')})`
}

function hex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex')
}

function assertName(value: string, field: 'workflow' | 'track'): void {
  if (!NAME_RE.test(value)) throw new Error(`router cache ${field} 名不合法：${JSON.stringify(value)}`)
}

function encodeRow(row: RouterRow, order: number): string {
  assertName(row.workflow, 'workflow')
  assertName(row.track, 'track')
  if (!Number.isSafeInteger(row.priority) || row.priority < 0) {
    throw new Error(`router cache ${row.workflow}:${row.track} 的 priority 必须是非负安全整数`)
  }
  if (!row.routable && (row.priority !== 0 || row.keywords.length > 0 || row.exclude.length > 0 || row.fallback)) {
    throw new Error(`router cache ${row.workflow}:${row.track} 没有 route，不得带优先级 / 关键词 / 兜底`)
  }
  const label = [...row.label].slice(0, MAX_LABEL_CHARS).join('')
  if (label === '') throw new Error(`router cache ${row.workflow}:${row.track} 的 label 不得为空`)
  return [
    'R', String(order), String(row.priority), hex(row.workflow), hex(row.track), hex(label),
    row.routable ? '1' : '0', row.fallback ? '1' : '0', row.builtin ? '1' : '0',
    hex(routePattern(row.keywords)), hex(routePattern(row.exclude)),
  ].join('|')
}

/** 调用方须把结果写到临时文件、校验完整后再原子 rename 成缓存。 */
export function encodeRouterCache(table: RouterTable, projectRoot: string): string {
  if (projectRoot === '' || projectRoot.includes('\0')) throw new Error('router cache projectRoot 必须为非空且不含 NUL')
  if (!/^[0-9a-f]{64}$/u.test(table.sourceDigest)) throw new Error('router cache sourceDigest 必须为 64 位小写 hex')
  if (table.rows.length > MAX_ROUTER_ROWS) throw new Error(`router cache 行数不得超过 ${MAX_ROUTER_ROWS}（实际 ${table.rows.length}）`)
  const seen = new Set<string>()
  for (const row of table.rows) {
    const key = `${row.workflow}\0${row.track}`
    if (seen.has(key)) throw new Error(`router cache 出现重复的 ${row.workflow}:${row.track}`)
    seen.add(key)
  }
  return [
    ROUTER_CACHE_HEADER,
    `M|${hex(projectRoot)}|${table.sourceDigest}`,
    ...table.rows.map(encodeRow),
  ].join('\n') + '\n'
}
