/**
 * 资源目录 → 指令模板块的 catalog 端口（instructions/compose.ts 的 CatalogLookup）。
 *
 * 前端块声明 `catalog: [component-lib, icons, …]`，新建项目时选中的条目 id 经本适配器变成块正文里的
 * 「名称（许可）· 安装 · 文档」行；不可再分发与需署名的条目在那里各自多一行约束（许可证门禁的末端）。
 *
 * Dashboard 经 `@tenon/kernel/resources/frontend-selection` 直接 import `resourceEntryLines` 预览「将写入」，
 * 所以本文件只 import 类型与叶子模块 `catalog-lines`，不拉别的运行时依赖。
 */
import { catalogEntryLines, type CatalogEntrySummary } from '../instructions/catalog-lines.js'
import type { CatalogLookup } from '../instructions/compose.js'
import type { ResourceEntry } from './types.js'

export function resourceSummary(entry: ResourceEntry): CatalogEntrySummary {
  const docs = entry.links.docs ?? entry.links.home ?? entry.links.source
  return {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    frameworks: entry.frameworks,
    license: {
      spdx: entry.license.spdx,
      redistributable: entry.license.redistributable,
      attribution: entry.license.attribution,
    },
    ...(entry.install[0] === undefined ? {} : { install: entry.install[0] }),
    ...(docs === undefined ? {} : { docs_url: docs }),
  }
}

/** 一条资源加入前端块后写进指令文件的行（compose 拼 `{{catalog.*}}` 的同一份格式）；预览「将写入」用。 */
export function resourceEntryLines(entry: ResourceEntry): string[] {
  return catalogEntryLines(resourceSummary(entry))
}

/** 目录条目按 id 建索引；未收录的 id 返回 null，compose 会整行省略。 */
export function resourceCatalogLookup(entries: readonly ResourceEntry[]): CatalogLookup {
  const byId = new Map(entries.map((entry) => [entry.id, resourceSummary(entry)]))
  return { get: (id) => byId.get(id) ?? null }
}
