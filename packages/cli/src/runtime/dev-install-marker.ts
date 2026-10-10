import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeDevSource } from './types.js'

const MARKER_FILE = 'install-channel'
const OID = /^[0-9a-f]{40}$/
const RELEASE_ID = /^sha256-[0-9a-f]{64}$/
const CONTROL = /[\u0000-\u001f\u007f]/u
const KEYS = [
  'channel', 'host', 'release_id', 'installed_at', 'repo', 'commit', 'dirty', 'worktree_digest', 'skills_index_digest',
] as const

export interface DevInstallMarker {
  readonly host: 'codex' | 'claude'
  readonly releaseId: string
  readonly installedAt: string
  readonly devSource: RuntimeDevSource
}

export function installChannelPath(configRoot: string): string {
  return join(configRoot, MARKER_FILE)
}

/**
 * 一行一个 key=value，hooks/auto-update.sh 与 hooks/source-drift.sh 用 `IFS='=' read -r key value` 读它。
 * 值里不许有控制字符（含换行），否则 bash 端会读错。
 */
export function encodeInstallChannel(marker: DevInstallMarker): string {
  const source = marker.devSource
  const values: Record<(typeof KEYS)[number], string> = {
    channel: 'dev',
    host: marker.host,
    release_id: marker.releaseId,
    installed_at: marker.installedAt,
    repo: source.repoRealpath,
    commit: source.commit,
    dirty: String(source.dirty),
    worktree_digest: source.worktreeDigest,
    skills_index_digest: source.skillsIndexDigest,
  }
  for (const key of KEYS) {
    if (CONTROL.test(values[key])) throw new Error(`install-channel 字段 ${key} 含控制字符`)
  }
  return `${KEYS.map((key) => `${key}=${values[key]}`).join('\n')}\n`
}

export function parseInstallChannel(text: string): DevInstallMarker | null {
  const found = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const index = line.indexOf('=')
    if (index <= 0) return null
    const key = line.slice(0, index)
    if (found.has(key) || !(KEYS as readonly string[]).includes(key)) return null
    found.set(key, line.slice(index + 1))
  }
  if (found.size !== KEYS.length) return null
  const get = (key: (typeof KEYS)[number]): string => found.get(key) ?? ''
  const host = get('host')
  const dirty = get('dirty')
  const skills = get('skills_index_digest')
  if (get('channel') !== 'dev'
    || (host !== 'codex' && host !== 'claude')
    || !RELEASE_ID.test(get('release_id'))
    || get('installed_at') === ''
    || get('repo') === ''
    || !OID.test(get('commit'))
    || (dirty !== 'true' && dirty !== 'false')
    || !OID.test(get('worktree_digest'))
    || (skills !== 'absent' && !OID.test(skills))) return null
  return {
    host,
    releaseId: get('release_id'),
    installedAt: get('installed_at'),
    devSource: {
      kind: 'dev',
      repoRealpath: get('repo'),
      commit: get('commit'),
      dirty: dirty === 'true',
      worktreeDigest: get('worktree_digest'),
      skillsIndexDigest: skills,
    },
  }
}

/** 原子写：同目录临时文件再 rename，hook 永远读不到半截内容；写或 rename 失败都不留临时文件。 */
export function writeInstallChannelMarker(configRoot: string, marker: DevInstallMarker): void {
  mkdirSync(configRoot, { recursive: true })
  const target = installChannelPath(configRoot)
  const temp = `${target}.tmp-${process.pid}`
  try {
    writeFileSync(temp, encodeInstallChannel(marker), { encoding: 'utf8', mode: 0o644 })
    renameSync(temp, target)
  } finally {
    // rename 成功后临时文件已不存在，force 使之成为空操作；失败时清掉，免得残留在配置根里。
    rmSync(temp, { force: true })
  }
}

/** 读标记；缺失、不可读或损坏一律当作没有标记（返回 null），绝不抛错。 */
export function readInstallChannelMarker(configRoot: string): DevInstallMarker | null {
  try {
    return parseInstallChannel(readFileSync(installChannelPath(configRoot), 'utf8'))
  } catch {
    return null
  }
}

/** 正式安装 / 切回正式版成功后清标记；没有标记也不是错误。 */
export function removeInstallChannelMarker(configRoot: string): void {
  rmSync(installChannelPath(configRoot), { force: true })
}
