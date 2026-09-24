/**
 * 项目启用的 agent 客户端（`<root>/.tenon/clients.json`）的读写，经已注册项目根的受信锚：
 * 目录链逐层 O_NOFOLLOW 打开，目标拒绝 symlink / 非普通文件，写入是同目录临时文件 + fsync + rename。
 *
 * 写入是整份替换（请求体就是完整集合），同样的请求重试结果相同；写前读到的摘要作为比对基准，
 * 读写之间被别人改过就 409，不覆盖。编解码与推断在 kernel（instructions/clients）。
 */
import { join } from 'node:path'
import {
  PROJECT_CLIENTS_DIRS, PROJECT_CLIENTS_FILE, PROJECT_CLIENTS_MAX_BYTES,
  inferProjectClients, normalizeProjectClients, parseProjectClients, serializeProjectClients,
} from '@tenon/kernel'
import { readTrustedFile, writeTrustedFile } from './instructionTrustedFs.js'
import { lstatIfExists, type WorkflowRootAnchor } from './workflowRootAnchor.js'

export type ProjectClientsSource = 'file' | 'inferred'

export type ProjectClientsRead =
  | { ok: true; enabled: string[]; source: ProjectClientsSource; digest: string }
  | { ok: false; status: number; code: string; error: string }

export type ProjectClientsWrite =
  | { ok: true; enabled: string[]; digest_before: string; digest: string }
  | { ok: false; status: number; code: string; error: string; unknown?: string[] }

const failed = (status: number, code: string, error: string): { ok: false; status: number; code: string; error: string } =>
  ({ ok: false, status, code, error })

/** 读 clients.json；不存在时按已存在的项目级指令文件推断。文件损坏、是 symlink 或过大都失败，不静默改成推断。 */
export function readProjectClients(anchor: WorkflowRootAnchor): ProjectClientsRead {
  const read = readTrustedFile(anchor, PROJECT_CLIENTS_DIRS, PROJECT_CLIENTS_FILE, PROJECT_CLIENTS_MAX_BYTES)
  if (read.error) return failed(409, read.error, 'clients.json 不可读')
  if (read.bytes === null) {
    const enabled = inferProjectClients((file) => {
      const entry = lstatIfExists(join(anchor.path, file))
      return entry !== undefined && entry.isFile()
    })
    return { ok: true, enabled, source: 'inferred', digest: read.digest }
  }
  const enabled = parseProjectClients(read.bytes.toString('utf8'))
  if (enabled === null) return failed(409, 'clients-file-invalid', 'clients.json 格式不合法')
  return { ok: true, enabled, source: 'file', digest: read.digest }
}

/**
 * 把项目启用的客户端整份写进 `.tenon/clients.json`（缺 `.tenon/` 时经受信链创建）。
 * 只收宿主表里的客户端 id，去重排序后写出；损坏的旧文件被整份替换。新建项目向导在建好项目后也调用它。
 */
export function writeProjectClients(anchor: WorkflowRootAnchor, enabled: unknown): ProjectClientsWrite {
  const normalized = normalizeProjectClients(enabled)
  if (normalized === null) return failed(400, 'invalid', 'enabled 必须是客户端 id 列表')
  if (!normalized.ok) return { ...failed(400, 'unknown-client', '未知客户端'), unknown: normalized.unknown }
  const current = readTrustedFile(anchor, PROJECT_CLIENTS_DIRS, PROJECT_CLIENTS_FILE, PROJECT_CLIENTS_MAX_BYTES)
  if (current.error) return failed(409, current.error, 'clients.json 不可写')
  const written = writeTrustedFile(
    anchor, PROJECT_CLIENTS_DIRS, PROJECT_CLIENTS_FILE, serializeProjectClients(normalized.enabled), current.digest, PROJECT_CLIENTS_MAX_BYTES,
  )
  if (written.ok) return { ok: true, enabled: normalized.enabled, digest_before: current.digest, digest: written.digest }
  return written.code === 'changed'
    ? failed(409, 'clients-file-changed', 'clients.json 已被外部修改')
    : failed(409, written.code, 'clients.json 不可写')
}
