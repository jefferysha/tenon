/**
 * 项目启用了哪些 agent 客户端：项目内 `.tenon/clients.json`，随项目提交、团队共享
 * （`.tenon/.gitignore` 只忽略每个用户的 local 目录）。
 *
 * 形如 `{ "schema": "tenon-clients/v1", "enabled": ["claude", "codex"] }`：只收宿主表里的客户端 id，
 * 去重并按字母序写出。文件不存在时按已存在的项目级指令文件推断（CLAUDE.md → claude、AGENTS.md → codex、
 * GEMINI.md → gemini）。本模块只做编解码与推断，不碰文件系统。
 */
import { INSTRUCTION_HOSTS } from './hosts.js'

export const PROJECT_CLIENTS_SCHEMA = 'tenon-clients/v1'
/** 相对项目根：目录段 + 文件名。 */
export const PROJECT_CLIENTS_DIRS: readonly string[] = ['.tenon']
export const PROJECT_CLIENTS_FILE = 'clients.json'
export const PROJECT_CLIENTS_MAX_BYTES = 16 * 1024

const KNOWN = new Set(INSTRUCTION_HOSTS.map((host) => host.id))

/** 推断用的「文件 → 客户端」：每个项目级文件取宿主表里第一个声明读它的客户端。 */
const INFERRED_BY_FILE: readonly (readonly [string, string])[] = [
  ['CLAUDE.md', 'claude'],
  ['AGENTS.md', 'codex'],
  ['GEMINI.md', 'gemini'],
]

export type ClientIdsResult = { ok: true; enabled: string[] } | { ok: false; unknown: string[] }

/** 校验并规范化：必须是字符串数组、每个 id 都在宿主表里；去重后按字母序。 */
export function normalizeProjectClients(value: unknown): ClientIdsResult | null {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) return null
  const unknown = value.filter((id) => !KNOWN.has(id))
  if (unknown.length > 0) return { ok: false, unknown: [...new Set(unknown)] }
  return { ok: true, enabled: [...new Set(value)].sort() }
}

export function serializeProjectClients(enabled: readonly string[]): string {
  return `${JSON.stringify({ schema: PROJECT_CLIENTS_SCHEMA, enabled }, null, 2)}\n`
}

/** 解析文件内容；形状、schema 或 id 不对都返回 null（调用方按文件损坏处理，不静默改成推断）。 */
export function parseProjectClients(text: string): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = Object.fromEntries(Object.entries(parsed))
  if (record.schema !== PROJECT_CLIENTS_SCHEMA) return null
  const normalized = normalizeProjectClients(record.enabled)
  return normalized?.ok === true ? normalized.enabled : null
}

/** 没有 clients.json 时按已存在的项目级文件推断。 */
export function inferProjectClients(exists: (file: string) => boolean): string[] {
  return INFERRED_BY_FILE.filter(([file]) => exists(file)).map(([, client]) => client).sort()
}
