import type { WbTrackBranch, WbTrackRoute, WbTrackSpec, WbWorkflowDef } from '../api/governanceTypes'
import { stableJson } from './draftChanges'

/**
 * 轨道设置：分支的「规范」（`spec`）与路由「关键词」（`route.keywords`）。其它路由项（排除词、优先级、兜底）和
 * 自动化开关只在 YAML 里改，这里碰到已有的 route 时原样保留。
 */

/** 路由词的口径与内核 `compileBranchRoute` 一致：至多 64 个、每个 1–64 字、不含方括号 / 花括号 / 控制字符。 */
const MAX_TERMS = 64
const MAX_TERM_LENGTH = 64
const TERM_RE = /^[^\p{Cc}\p{Zl}\p{Zp},[\]{}]+$/u

/** 补一条新 route 时的优先级：与内建的产品轨道同档，比关键词最宽的轻量轨道低。 */
export const DEFAULT_ROUTE_PRIORITY = 100

/** 一条轨道的设置：规范与路由关键词。 */
export interface TrackSettings {
  readonly spec: WbTrackSpec
  readonly keywords: readonly string[]
}

export type ParsedKeywords = { ok: true; keywords: string[] } | { ok: false }

/** 逗号（英文或中文）分隔的关键词：去空白、去空项、去重，保持首次出现的顺序。 */
export function parseTrackKeywords(text: string): ParsedKeywords {
  const keywords = [...new Set(text.split(/[,，]/u).map((term) => term.trim()).filter((term) => term !== ''))]
  if (keywords.length > MAX_TERMS) return { ok: false }
  return keywords.every((term) => term.length <= MAX_TERM_LENGTH && TERM_RE.test(term)) ? { ok: true, keywords } : { ok: false }
}

/** 分支没写 `spec` 时继承工作流顶层：`openspec: true` 是 openspec，否则 none（与内核的折算同一规则）。 */
function inheritedSpec(def: WbWorkflowDef): WbTrackSpec {
  return def.openspec === true ? 'openspec' : 'none'
}

export function trackSettingsOf(def: WbWorkflowDef, id: string): { spec: WbTrackSpec; keywords: string[] } {
  const branch = def.tracks?.[id]
  return { spec: branch?.spec ?? inheritedSpec(def), keywords: [...(branch?.route?.keywords ?? [])] }
}

function routeWith(route: WbTrackRoute | undefined, keywords: readonly string[]): WbTrackRoute | undefined {
  if (route === undefined) {
    return keywords.length === 0 ? undefined : { keywords: [...keywords], exclude: [], priority: DEFAULT_ROUTE_PRIORITY, fallback: false }
  }
  if (keywords.length === 0 && route.exclude.length === 0 && !route.fallback) return undefined
  return { ...route, keywords: [...keywords] }
}

/**
 * 把设置写进一条分支。规范与继承值相同就不写 `spec` 键（旧文件不用改）；规范是「无」就去掉分支的文档契约
 * （内核不允许 `spec: none` 的分支声明它）。没有这条分支或设置没变时原样返回同一个定义。
 */
export function setTrackSettingsInDef(def: WbWorkflowDef, id: string, settings: TrackSettings): WbWorkflowDef {
  const branch = def.tracks?.[id]
  if (branch === undefined) return def
  const { spec: _spec, route, documentContract, ...rest } = branch
  const nextRoute = routeWith(route, settings.keywords)
  const next: WbTrackBranch = {
    ...rest,
    ...(settings.spec === inheritedSpec(def) ? {} : { spec: settings.spec }),
    ...(settings.spec === 'none' || documentContract === undefined ? {} : { documentContract }),
    ...(nextRoute === undefined ? {} : { route: nextRoute }),
  }
  if (stableJson(next) === stableJson(branch)) return def
  return { ...def, tracks: { ...def.tracks, [id]: next } }
}
