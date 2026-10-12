/**
 * M5 路由表生成：把「所有可用工作流」里每条分支的 `route` 变成一张有界、纯数据的打分表。
 * 本文件是纯函数——加载工作流文件（项目 → 全局存储 → 插件模板）在 router-sources.ts，落缓存在 router-cache.ts，
 * `router.sh` 只读缓存。分支只是工作流 YAML 里的 `tracks.<id>`；没有 `tracks:` 的平铺工作流只有一条隐式分支，
 * 轨道 id 就是工作流名，顶层 `route` 是它的路由数据。
 */
import { sha256Hex } from '../sha256.js'
import type { WorkflowIR } from '../workflow/ir.js'
import { listTracks } from '../workflow/resolve-track.js'

export const ROUTER_SCHEMA = 'router.v6'

/** 路由表是有界的：行数超过它时多出的行不参与路由（并警告）。`router.sh` 以同一个数读缓存。 */
export const MAX_ROUTER_ROWS = 64

/** 随插件发布的内建工作流：它们的分支可以直接路由，自定义工作流的分支必须先让用户选择。 */
const BUILTIN_ROUTER_WORKFLOWS: readonly string[] = ['default', 'design-system']

export function isBuiltinRouterWorkflow(id: string): boolean {
  return BUILTIN_ROUTER_WORKFLOWS.includes(id)
}

/** 工作流文件来自哪一层；越靠前越优先（项目文件遮住全局，全局遮住模板）。 */
export type RouterSourceScope = 'project' | 'global' | 'template'

/**
 * 一份工作流文件及其编译结果。`source` 是文件原文：`sourceDigest` 覆盖所有文件的内容，
 * 包括被更高优先级的同名文件遮住的那些（删掉遮蔽者就会换一份生效）。
 */
export interface RouterWorkflowSource {
  readonly id: string
  readonly scope: RouterSourceScope
  readonly source: string
  readonly ir: WorkflowIR | Error
  readonly builtin: boolean
}

export interface RouterRow {
  readonly workflow: string
  /** 分支 id；平铺工作流的隐式分支用工作流名。 */
  readonly track: string
  readonly label: string
  /** 分支声明了 `route`。没有 route 的分支在表里（可点名），但绝不参与打分。 */
  readonly routable: boolean
  readonly priority: number
  readonly keywords: readonly string[]
  readonly exclude: readonly string[]
  /** 被排除词挡掉、又没有分支认领时落到的分支。 */
  readonly fallback: boolean
  readonly builtin: boolean
}

export interface RouterTable {
  readonly schema: typeof ROUTER_SCHEMA
  /** 全部工作流文件内容的 SHA-256；任何一份变化都使缓存失效。 */
  readonly sourceDigest: string
  readonly rows: readonly RouterRow[]
  /** 被跳过的工作流等一行一条的说明；不进缓存。 */
  readonly warnings: readonly string[]
}

/**
 * 摘要的字节流约定（`router.sh` 在命中缓存时用 shell 重算同一个流，所以这里不能随意改）：
 * 每份文件依次是 `<范围>/<文件名>\n`、文件原文、`\n`；文件按「项目、全局、模板」的范围顺序、范围内按文件名字节序。
 */
export function routerSourceDigest(sources: readonly RouterWorkflowSource[]): string {
  return sha256Hex(sources.map((s) => `${s.scope}/${s.id}.yaml\n${s.source}\n`).join(''))
}

function failure(source: RouterWorkflowSource): Error | undefined {
  return source.ir instanceof Error ? source.ir : undefined
}

function firstLine(error: Error): string {
  return (error.message.split('\n')[0] ?? '').slice(0, 200)
}

function builtinRank(id: string): number {
  const index = BUILTIN_ROUTER_WORKFLOWS.indexOf(id)
  return index === -1 ? BUILTIN_ROUTER_WORKFLOWS.length : index
}

function byWorkflow(a: string, b: string): number {
  return builtinRank(a) - builtinRank(b) || (a < b ? -1 : a > b ? 1 : 0)
}

function rowsOf(source: RouterWorkflowSource, ir: WorkflowIR): RouterRow[] {
  const rows = listTracks(ir).map((branch): RouterRow => ({
    workflow: source.id,
    track: branch.id,
    label: branch.label,
    routable: branch.route !== undefined,
    priority: branch.route?.priority ?? 0,
    keywords: branch.route?.keywords ?? [],
    exclude: branch.route?.exclude ?? [],
    fallback: branch.route?.fallback ?? false,
    builtin: source.builtin,
  }))
  // Array.prototype.sort 稳定：同优先级保持声明顺序。
  return rows.sort((a, b) => b.priority - a.priority)
}

/**
 * `sources` 按优先级给出（同名的项目文件在全局文件之前、全局在模板之前）。同名工作流取第一份能编译的；
 * 排在它前面的坏文件各警告一行，全都坏则整个工作流跳过并警告，其余工作流照常路由。
 */
export function buildRouterTable(sources: readonly RouterWorkflowSource[]): RouterTable {
  const warnings: string[] = []
  const groups = new Map<string, RouterWorkflowSource[]>()
  for (const source of sources) groups.set(source.id, [...(groups.get(source.id) ?? []), source])

  const chosen: Array<{ readonly source: RouterWorkflowSource; readonly ir: WorkflowIR }> = []
  for (const group of groups.values()) {
    const index = group.findIndex((source) => failure(source) === undefined)
    for (const source of index === -1 ? group : group.slice(0, index)) {
      const error = failure(source)
      if (error !== undefined) warnings.push(`工作流 '${source.id}'（${source.scope}）未参与路由：${firstLine(error)}`)
    }
    const winner = group[index]
    if (winner !== undefined && !(winner.ir instanceof Error)) chosen.push({ source: winner, ir: winner.ir })
  }

  chosen.sort((a, b) => byWorkflow(a.source.id, b.source.id))
  const all = chosen.flatMap(({ source, ir }) => rowsOf(source, ir))
  if (all.length > MAX_ROUTER_ROWS) {
    warnings.push(`路由表最多 ${MAX_ROUTER_ROWS} 行，多出的 ${all.length - MAX_ROUTER_ROWS} 行未参与路由`)
  }
  return {
    schema: ROUTER_SCHEMA,
    sourceDigest: routerSourceDigest(sources),
    rows: all.slice(0, MAX_ROUTER_ROWS),
    warnings,
  }
}
