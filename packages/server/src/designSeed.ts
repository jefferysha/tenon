/**
 * DESIGN.md 起步文件：把资源目录里的一条 design-md 条目取到项目根目录。
 *
 * 目录本身只存链接，品牌内容从不进插件包——这里是它唯一一次落盘，且只落到已注册的项目根。
 * 落盘的是「起步」而非成品：没有 `schema: tenon-design/v1` 标记，前端任务的就绪检查照样拦它。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ResourceEntry } from '@tenon/kernel'

export const DESIGN_SEED_MAX_BYTES = 512 * 1024
const FETCH_TIMEOUT_MS = 10_000

export type DesignSeedFetch = (url: string) => Promise<{ ok: boolean; status: number; text: string }>

/** 默认抓取器：https、2xx、10 秒超时、512 KiB 上限，全部不满足即失败。 */
export const httpsDesignSeedFetch: DesignSeedFetch = async (url) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'text/plain' } })
    const text = await response.text()
    return { ok: response.ok, status: response.status, text }
  } finally {
    clearTimeout(timer)
  }
}

export interface DesignSeedFailure {
  readonly ok: false
  readonly code: 'not-design-md' | 'exists' | 'fetch-failed'
  readonly error: string
}
export type DesignSeedFetched = { readonly ok: true; readonly text: string } | DesignSeedFailure
export type DesignSeedWritten = { readonly ok: true; readonly path: 'DESIGN.md'; readonly bytes: number } | DesignSeedFailure

function seedUrl(entry: ResourceEntry): string | null {
  const url = entry.links.design_md
  return url !== undefined && url.startsWith('https://') ? url : null
}

/** 取回条目的 DESIGN.md 原文；任何非 2xx、超限、非 https、网络故障都是 fetch-failed。 */
export async function fetchDesignSeed(entry: ResourceEntry, get: DesignSeedFetch): Promise<DesignSeedFetched> {
  if (entry.category !== 'design-md') return { ok: false, code: 'not-design-md', error: `${entry.id} 不是 DESIGN.md 资源` }
  const url = seedUrl(entry)
  if (url === null) return { ok: false, code: 'fetch-failed', error: 'DESIGN.md 获取失败：链接不是 https' }
  let response: { ok: boolean; status: number; text: string }
  try {
    response = await get(url)
  } catch (error) {
    return { ok: false, code: 'fetch-failed', error: `DESIGN.md 获取失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) return { ok: false, code: 'fetch-failed', error: `DESIGN.md 获取失败：${response.status}` }
  const bytes = new TextEncoder().encode(response.text).length
  if (bytes === 0 || bytes > DESIGN_SEED_MAX_BYTES) {
    return { ok: false, code: 'fetch-failed', error: `DESIGN.md 获取失败：大小 ${bytes} 字节` }
  }
  return { ok: true, text: response.text }
}

/** 写到 `<root>/DESIGN.md`；已存在时不覆盖。 */
export function writeDesignSeed(root: string, text: string): DesignSeedWritten {
  try {
    writeFileSync(join(root, 'DESIGN.md'), text, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return { ok: false, code: 'exists', error: 'DESIGN.md 已存在' }
    return { ok: false, code: 'fetch-failed', error: `DESIGN.md 写入失败：${code ?? String(error)}` }
  }
  return { ok: true, path: 'DESIGN.md', bytes: new TextEncoder().encode(text).length }
}
