/**
 * 分支新键的写回（parse-track-branch.ts 的反向）：键序固定 `spec`、`route`、`automation`，缺省键不写。
 * `route` 的空 `exclude` 与 false `fallback` 不写（parse 读回时补同样的默认值，往返保真）。
 * 平铺工作流顶层的 `route` 与分支里的 `route` 是同一种写法，只差缩进。
 */
import type { TrackBranchDef, TrackRoute } from './types.js'

/** `pad` 是 `route:` 键的前导空格（顶层为空，`tracks.<id>` 下的字段为 4 空格）。 */
export function serializeRoute(route: TrackRoute, pad: string): string[] {
  const sub = `${pad}  `
  return [
    `${pad}route:`,
    `${sub}keywords: [${route.keywords.join(', ')}]`,
    ...(route.exclude.length === 0 ? [] : [`${sub}exclude: [${route.exclude.join(', ')}]`]),
    `${sub}priority: ${route.priority}`,
    ...(route.fallback ? [`${sub}fallback: true`] : []),
  ]
}

/** `pad` 是分支键的前导空格（`tracks.<id>` 下的字段为 4 空格）。 */
export function serializeBranchPolicy(branch: TrackBranchDef, pad: string): string[] {
  const sub = `${pad}  `
  const { spec, route, automation } = branch
  return [
    ...(spec === undefined ? [] : [`${pad}spec: ${spec}`]),
    ...(route === undefined ? [] : serializeRoute(route, pad)),
    ...(automation === undefined ? [] : [
      `${pad}automation:`,
      `${sub}eligible: ${automation.eligible}`,
      `${sub}enqueue_after_spec: ${automation.enqueueAfterSpec}`,
    ]),
  ]
}
