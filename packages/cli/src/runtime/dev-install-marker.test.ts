import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  encodeInstallChannel, installChannelPath, parseInstallChannel,
  readInstallChannelMarker, removeInstallChannelMarker, writeInstallChannelMarker, type DevInstallMarker,
} from './dev-install-marker.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const MARKER: DevInstallMarker = {
  host: 'claude',
  releaseId: `sha256-${'a'.repeat(64)}`,
  installedAt: '2026-10-07T12:00:00Z',
  devSource: {
    kind: 'dev', repoRealpath: '/work/tenon repo', commit: 'b'.repeat(40), dirty: true,
    worktreeDigest: 'c'.repeat(40), skillsIndexDigest: 'absent',
  },
}

describe('install-channel marker', () => {
  test('round-trips, one key per line, channel=dev first', () => {
    const text = encodeInstallChannel(MARKER)
    expect(text.split('\n')[0]).toBe('channel=dev')
    expect(text).toContain('repo=/work/tenon repo\n')
    expect(parseInstallChannel(text)).toEqual(MARKER)
  })

  test('rejects control characters when encoding and incomplete or unknown content when parsing', () => {
    expect(() => encodeInstallChannel({
      ...MARKER, devSource: { ...MARKER.devSource, repoRealpath: '/work/te\nnon' },
    })).toThrow('控制字符')
    expect(parseInstallChannel('channel=dev\nhost=claude\n')).toBeNull()
    expect(parseInstallChannel(`${encodeInstallChannel(MARKER)}surprise=1\n`)).toBeNull()
    expect(parseInstallChannel(encodeInstallChannel(MARKER).replace('channel=dev', 'channel=stable'))).toBeNull()
  })

  test('reads back a written marker and treats a missing or damaged one as absent', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'tenon-marker-read-'))
    roots.push(configRoot)
    expect(readInstallChannelMarker(configRoot)).toBeNull()
    writeInstallChannelMarker(configRoot, MARKER)
    expect(readInstallChannelMarker(configRoot)).toEqual(MARKER)
    writeFileSync(installChannelPath(configRoot), 'garbage\n', 'utf8')
    expect(readInstallChannelMarker(configRoot)).toBeNull()
  })

  test('writes atomically under the config root and removes idempotently', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'tenon-marker-'))
    roots.push(configRoot)
    const nested = join(configRoot, 'config')
    writeInstallChannelMarker(nested, MARKER)
    expect(readFileSync(installChannelPath(nested), 'utf8')).toBe(encodeInstallChannel(MARKER))
    removeInstallChannelMarker(nested)
    expect(existsSync(installChannelPath(nested))).toBe(false)
    expect(() => removeInstallChannelMarker(nested)).not.toThrow()
    mkdirSync(join(configRoot, 'empty'))
    expect(() => removeInstallChannelMarker(join(configRoot, 'empty'))).not.toThrow()
  })

  test('a failed rename leaves no temp file behind and does not touch what is at the target', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'tenon-marker-fail-'))
    roots.push(configRoot)
    // A non-empty directory at the marker path makes rename(file -> directory) fail after the temp file was written.
    const target = installChannelPath(configRoot)
    mkdirSync(target)
    writeFileSync(join(target, 'keep'), 'x', 'utf8')
    expect(() => writeInstallChannelMarker(configRoot, MARKER)).toThrow()
    expect(readdirSync(configRoot)).toEqual(['install-channel'])
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('x')
  })
})
