/**
 * 选择文件夹：POST /api/fs/choose-folder 调起本机原生对话框；GET /api/fs/list 给页面内目录浏览器列子目录。
 * 两个端点都带 Bearer token；失败抛 InstructionApiError（保留 server code，页面按码显示本地文案）。
 */
import { InstructionApiError } from './instructionsClient'
import { getToken, isRecord, readJson, wrapNetwork } from './transport'

export type FolderPick = { kind: 'picked'; path: string } | { kind: 'cancelled' } | { kind: 'unavailable' }

export interface FolderEntry { name: string; path: string }
export interface FolderListing { dir: string; parent: string | null; home: string; entries: FolderEntry[]; truncated: boolean }

async function request(input: string, init: RequestInit, fallback: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(input, init)
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) {
    let body: unknown = null
    try { body = await readJson(response) } catch { /* 非 JSON 只留状态码 */ }
    const code = isRecord(body) && typeof body.code === 'string' ? body.code : undefined
    const detail = isRecord(body) && typeof body.error === 'string' ? body.error : ''
    throw new InstructionApiError(detail || `${fallback}（${response.status}）`, response.status, detail !== '', code)
  }
  return readJson(response)
}

export function decodeFolderPick(value: unknown): FolderPick | null {
  if (!isRecord(value)) return null
  if (value.ok === true && typeof value.path === 'string' && Object.keys(value).length === 2) return { kind: 'picked', path: value.path }
  if (value.ok === false && value.cancelled === true) return { kind: 'cancelled' }
  if (value.ok === false && value.unavailable === true) return { kind: 'unavailable' }
  return null
}

export function decodeFolderListing(value: unknown): FolderListing | null {
  if (!isRecord(value) || value.ok !== true || typeof value.dir !== 'string' || typeof value.home !== 'string'
    || !(value.parent === null || typeof value.parent === 'string') || typeof value.truncated !== 'boolean' || !Array.isArray(value.entries)) return null
  const entries: FolderEntry[] = []
  for (const item of value.entries) {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.path !== 'string') return null
    entries.push({ name: item.name, path: item.path })
  }
  return { dir: value.dir, parent: value.parent, home: value.home, entries, truncated: value.truncated }
}

export async function chooseFolder(title: string, startDir: string | null): Promise<FolderPick> {
  const body = await request('/api/fs/choose-folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(startDir === null ? { title } : { title, start_dir: startDir }),
  }, '选择文件夹失败')
  const pick = decodeFolderPick(body)
  if (pick === null) throw new InstructionApiError('选择文件夹：响应形状无效', 200, false, undefined)
  return pick
}

/** dir 为空 = 主目录。 */
export async function listFolders(dir: string, hidden: boolean, signal?: AbortSignal): Promise<FolderListing> {
  const query = `dir=${encodeURIComponent(dir)}${hidden ? '&hidden=1' : ''}`
  const body = await request(`/api/fs/list?${query}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${getToken()}` },
    signal,
  }, '目录列表获取失败')
  const listing = decodeFolderListing(body)
  if (listing === null) throw new InstructionApiError('目录列表：响应形状无效', 200, false, undefined)
  return listing
}
