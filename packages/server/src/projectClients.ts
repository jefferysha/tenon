/**
 * 项目已启用的客户端：项目根下 `.tenon/clients.json`，`{ "schema": "tenon-clients/v1", "enabled": [...] }`。
 * enabled 只收已知客户端 id（kernel INSTRUCTION_HOSTS），去重并排序。写入经受信目录链 + 摘要比对后原子 rename。
 */
import { INSTRUCTION_HOSTS } from '@tenon/kernel'
import { readTrustedFile, writeTrustedFile } from './instructionTrustedFs.js'
import type { WorkflowRootAnchor } from './workflowRootAnchor.js'

export const PROJECT_CLIENTS_SCHEMA = 'tenon-clients/v1'
const DIRS = ['.tenon'] as const
const FILE = 'clients.json'
const MAX_BYTES = 16 * 1024

/** 不是数组、含未知 id 或非字符串 → null；否则去重排序。 */
export function normalizeProjectClients(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const known = new Set(INSTRUCTION_HOSTS.map((host) => host.id))
  if (!value.every((item): item is string => typeof item === 'string' && known.has(item))) return null
  return [...new Set(value)].sort()
}

export function projectClientsText(enabled: readonly string[]): string {
  return `${JSON.stringify({ schema: PROJECT_CLIENTS_SCHEMA, enabled }, null, 2)}\n`
}

/** 以当前盘上摘要为基准原子覆盖；失败抛错（带原因）。 */
export function writeProjectClientsAnchored(anchor: WorkflowRootAnchor, enabled: readonly string[]): void {
  const current = readTrustedFile(anchor, DIRS, FILE, MAX_BYTES)
  if (current.error) throw new Error(`.tenon/${FILE}: ${current.error}`)
  const written = writeTrustedFile(anchor, DIRS, FILE, projectClientsText(enabled), current.digest, MAX_BYTES)
  if (!written.ok) throw new Error(`.tenon/${FILE}: ${written.code}`)
}
