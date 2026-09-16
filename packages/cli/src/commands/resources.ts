/**
 * `tenon resources list/show` —— 资源目录的只读视图，agent 在开发中按框架、类别、关键字查条目。
 *
 * 筛选谓词直接用 kernel 的 filterResources，与 Dashboard 逐条一致；本命令只负责取数与排版。
 * 退出码：0 成功；1 一切错误（未知枚举值 / 未知 id / 目录读不出来）。JSON 模式 stdout 只放 JSON。
 */
import {
  RESOURCE_CATEGORIES, RESOURCE_FRAMEWORKS, RESOURCE_STYLING, filterResources, licenseModes,
  type ResourceCategory, type ResourceEntry, type ResourceFramework, type ResourceLicenseMode,
  type ResourceQuery, type ResourceStyling, type StoredResource,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'

const LICENSE_MODES = ['redistributable', 'link-only', 'attribution'] as const

export interface ResourcesListOpts {
  category?: string
  framework?: string
  styling?: string
  license?: string
  query?: string
  json?: boolean
}

const CATEGORY_LABEL: Record<ResourceCategory, string> = {
  'component-lib': '组件库',
  blocks: '区块',
  template: '模板',
  icons: '图标',
  animation: '动画',
  'motion-components': '动效组件',
  'design-md': 'DESIGN.md',
  state: '状态管理',
  styling: '样式',
}

const COMMERCIAL_LABEL = { free: '免费', freemium: '部分收费', paid: '收费' } as const

function pick<T extends string>(value: string | undefined, values: readonly T[], field: string): T | undefined {
  if (value === undefined) return undefined
  if (!(values as readonly string[]).includes(value)) throw new Error(`${field} 只接受：${values.join(', ')}`)
  return value as T
}

export function resourceQueryFrom(opts: ResourcesListOpts): ResourceQuery {
  const category = pick<ResourceCategory>(opts.category, RESOURCE_CATEGORIES, '--category')
  const framework = pick<ResourceFramework>(opts.framework, RESOURCE_FRAMEWORKS, '--framework')
  const styling = pick<ResourceStyling>(opts.styling, RESOURCE_STYLING, '--styling')
  const license = pick<ResourceLicenseMode>(opts.license, LICENSE_MODES, '--license')
  return {
    ...(category === undefined ? {} : { category }),
    ...(framework === undefined ? {} : { framework }),
    ...(styling === undefined ? {} : { styling }),
    ...(license === undefined ? {} : { license }),
    ...(opts.query === undefined ? {} : { text: opts.query }),
  }
}

const licenseText = (entry: ResourceEntry): string => [
  entry.license.spdx,
  entry.license.redistributable ? '可再分发' : '仅链接',
  COMMERCIAL_LABEL[entry.license.commercial],
  ...(entry.license.attribution ? ['需署名'] : []),
].join(' · ')

function pad(value: string, width: number): string {
  const size = [...value].reduce((total, char) => total + (/[一-鿿　-〿]/u.test(char) ? 2 : 1), 0)
  return value + ' '.repeat(Math.max(1, width - size))
}

async function catalog(deps: CliDeps): Promise<{ resources: readonly StoredResource[]; errors: readonly unknown[] }> {
  if (!deps.resourceCatalog) throw new Error('资源目录未装配')
  return deps.resourceCatalog()
}

export async function cmdResourcesList(deps: CliDeps, opts: ResourcesListOpts): Promise<0 | 1> {
  let query: ResourceQuery
  try {
    query = resourceQueryFrom(opts)
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
  try {
    const loaded = await catalog(deps)
    const rows = filterResources([...loaded.resources], query)
    if (opts.json) {
      deps.io.out(JSON.stringify({ entries: rows.map((row) => row.entry), errors: loaded.errors }, null, 2))
      return 0
    }
    if (rows.length === 0) deps.io.out('无资源')
    for (const row of rows) {
      deps.io.out(`${pad(row.entry.id, 26)}${pad(CATEGORY_LABEL[row.entry.category], 12)}${pad(licenseText(row.entry), 34)}${row.entry.name}`)
    }
    return 0
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
}

function showText(deps: CliDeps, stored: StoredResource): void {
  const entry = stored.entry
  deps.io.out(`${entry.name}（${entry.id}）`)
  deps.io.out(`类别：${CATEGORY_LABEL[entry.category]}`)
  deps.io.out(`来源：${stored.source === 'builtin' ? '内置' : '自定义'}`)
  deps.io.out(`许可：${licenseText(entry)}`)
  deps.io.out(`许可证：${entry.license.url}`)
  if (entry.license.notice) deps.io.out(`声明：${entry.license.notice}`)
  if (entry.use) deps.io.out(`场景：${entry.use}`)
  deps.io.out(`框架：${entry.frameworks.length === 0 ? '任意' : entry.frameworks.join(', ')}`)
  deps.io.out(`样式：${entry.styling.length === 0 ? '任意' : entry.styling.join(', ')}`)
  for (const line of entry.install) deps.io.out(`安装：${line}`)
  if (entry.skills.length > 0) deps.io.out(`技能：${entry.skills.join(', ')}`)
  for (const [key, value] of Object.entries(entry.links)) deps.io.out(`${key}：${value}`)
  deps.io.out(`核验：${entry.verified_at}`)
}

export async function cmdResourcesShow(deps: CliDeps, id: string, opts: { json?: boolean }): Promise<0 | 1> {
  try {
    const loaded = await catalog(deps)
    const stored = loaded.resources.find((item) => item.entry.id === id)
    if (!stored) {
      deps.io.err(`ERROR: 未知资源：${id}`)
      return 1
    }
    if (opts.json) {
      deps.io.out(JSON.stringify({ ...stored.entry, source: stored.source, modes: licenseModes(stored.entry) }, null, 2))
      return 0
    }
    showText(deps, stored)
    return 0
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
}
