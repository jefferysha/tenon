import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Fallback for library/test use outside an installed plugin root. */
export const SERVER_VERSION = '0.1.0'
const RELEASE_ID = /^sha256-[a-f0-9]{64}$/

interface PluginManifestVersion {
  readonly version?: unknown
}

function isPluginManifestVersion(value: unknown): value is PluginManifestVersion {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The server's takeover version must be the release version, not a separately maintained package
 * constant.  Otherwise an auto-updated plugin can keep reusing an old dashboard process because
 * both bundles advertise the same stale version.  Codex is preferred because it is the primary
 * native host; Claude remains a compatible fallback for a Claude-only installation.
 */
export function resolveReleaseVersion(pluginRoot: string): string {
  for (const relative of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(pluginRoot, relative), 'utf8'))
      if (isPluginManifestVersion(parsed) && typeof parsed.version === 'string' && /^\d+\.\d+\.\d+$/.test(parsed.version)) {
        return parsed.version
      }
    } catch {
      // A library consumer or a damaged checkout may not have release metadata; retain the
      // established fallback instead of preventing a local diagnostic server from starting.
    }
  }
  return SERVER_VERSION
}

/**
 * A marketplace semantic version is intentionally not enough to identify an activated managed
 * payload: users can update a release's content before bumping that version. The immutable
 * release-store layout gives the server a content-addressed identity without adding a second
 * mutable version register.
 */
export function resolvePayloadReleaseId(pluginRoot: string): string | undefined {
  if (basename(pluginRoot) !== 'payload') return undefined
  const releaseId = basename(dirname(pluginRoot))
  return RELEASE_ID.test(releaseId) ? releaseId : undefined
}

const DEV_COMMIT = /^[0-9a-f]{40}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface ReleaseChannel {
  readonly kind: 'dev'
  readonly commit: string
}

/**
 * 托管 payload 的兄弟文件 release.json 带 devSource 时，这是一份源码开发安装（tenon setup --from-source）。
 * 读不到或不合规一律按正式版处理：channel 只是 health 上的标注，不参与版本抢占。
 * 只取 commit：仓库绝对路径等本机信息不出 release.json。
 */
export function resolveReleaseChannel(pluginRoot: string): ReleaseChannel | undefined {
  if (basename(pluginRoot) !== 'payload') return undefined
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(dirname(pluginRoot), 'release.json'), 'utf8'))
    if (!isRecord(manifest) || !isRecord(manifest.devSource)) return undefined
    const { kind, commit } = manifest.devSource
    return kind === 'dev' && typeof commit === 'string' && DEV_COMMIT.test(commit)
      ? { kind: 'dev', commit }
      : undefined
  } catch {
    return undefined
  }
}

/** 版本徽标：开发安装是 `<version>+dev.<sha7>`，正式版就是 version 本身。 */
export function displayVersion(version: string, channel: ReleaseChannel | undefined): string {
  return channel === undefined ? version : `${version}+dev.${channel.commit.slice(0, 7)}`
}
