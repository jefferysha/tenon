/**
 * Identity resolution: `TENON_USER` → `<configRoot>/user.json` → git config. A present but invalid
 * higher source makes the identity missing; it never falls through to a lower one.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolveProductPaths } from '../product-paths.js'
import {
  normalizeUserName, userSlug, validateUserId,
  type TenonUserResolution, type UserSource,
} from './user.js'

const MAX_CONFIG_BYTES = 4096

function userFrom(rawId: string, rawName: string | undefined, source: UserSource): TenonUserResolution {
  const id = validateUserId(rawId)
  if (id === null) return { missing: true, invalid: source }
  return { id, name: normalizeUserName(rawName, id), slug: userSlug(id), source, trust: 'declared' }
}

function gitConfig(repoRoot: string | undefined, key: string, env: NodeJS.ProcessEnv): string | null {
  const args = repoRoot === undefined ? ['config', '--global', '--get', key] : ['config', '--get', key]
  try {
    const value = execFileSync('git', args, {
      cwd: repoRoot, env, timeout: 1500, maxBuffer: 4096, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim()
    return value === '' ? null : value
  } catch {
    return null
  }
}

/** Regular file of at most 4096 bytes with a valid string `id`; `name` optional; extra keys ignored. */
export function readUserConfig(path: string): { id: string; name: string } | 'absent' | 'invalid' {
  let size: number
  try {
    const info = lstatSync(path)
    if (!info.isFile()) return 'invalid'
    size = info.size
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'invalid'
  }
  if (size > MAX_CONFIG_BYTES) return 'invalid'
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return 'invalid'
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'invalid'
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || (record.name !== undefined && typeof record.name !== 'string')) return 'invalid'
  const id = validateUserId(record.id)
  return id === null ? 'invalid' : { id, name: normalizeUserName(record.name, id) }
}

export function resolveTenonUser(repoRoot?: string, env: NodeJS.ProcessEnv = process.env): TenonUserResolution {
  const envId = (env.TENON_USER ?? '').trim()
  if (envId !== '') return userFrom(envId, env.TENON_USER_NAME, 'env')
  const home = env.HOME?.trim()
  const config = readUserConfig(resolveProductPaths({ env, ...(home ? { homeDir: home } : {}) }).userConfigPath)
  if (config === 'invalid') return { missing: true, invalid: 'config' }
  if (config !== 'absent') return userFrom(config.id, config.name, 'config')
  const email = gitConfig(repoRoot, 'user.email', env)
  if (email === null) return { missing: true }
  return userFrom(email, gitConfig(repoRoot, 'user.name', env) ?? undefined, 'git')
}

/** Atomic temp + rename; refuses a symlink or non-file target. Throws `用户邮箱非法` on a bad id. */
export async function writeUserConfig(path: string, input: { id: string; name?: string }): Promise<void> {
  const id = validateUserId(input.id)
  if (id === null) throw new Error(`用户邮箱非法: ${input.id}`)
  await mkdir(dirname(path), { recursive: true })
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing !== null && !existing.isFile()) throw new Error(`user.json 不是普通文件: ${path}`)
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify({ id, name: normalizeUserName(input.name, id) })}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
