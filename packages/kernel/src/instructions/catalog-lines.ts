/**
 * 资源目录条目写进指令文件的那几行（叶子模块，只 import 类型）：`compose.ts` 拼 `{{catalog.*}}` 用它，
 * Dashboard 经 `@tenon/kernel/resources/frontend-selection` 预览「将写入」用同一份，两边不各写一套。
 */
import type { CatalogCategory } from './categories.js'

export interface CatalogEntrySummary {
  id: string
  name: string
  category: CatalogCategory
  frameworks: readonly string[]
  license: { spdx: string; redistributable: boolean; attribution: boolean }
  install?: string
  docs_url?: string
}

/** 名称（许可）· 安装 · 文档；不可再分发与需署名的条目各多一行约束（许可证门禁的末端）。 */
export function catalogEntryLines(entry: CatalogEntrySummary): string[] {
  const parts: string[] = []
  if (entry.install) parts.push(`安装 \`${entry.install}\``)
  if (entry.docs_url) parts.push(`文档 ${entry.docs_url}`)
  const lines = [`- ${entry.name}（${entry.license.spdx}）${parts.length > 0 ? `· ${parts.join(' · ')}` : ''}`]
  if (!entry.license.redistributable) lines.push(`- 仅链接：${entry.name} 按安装命令在本项目使用，不再分发其源码`)
  if (entry.license.attribution) lines.push(`- 署名：${entry.name} 需要署名`)
  return lines
}
