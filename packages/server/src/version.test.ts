import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  SERVER_VERSION, displayVersion, resolvePayloadReleaseId, resolveReleaseChannel, resolveReleaseVersion,
} from './version.js'

describe('resolveReleaseVersion', () => {
  test('takes the Codex plugin manifest as the runtime release and takeover version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-release-version-'))
    await mkdir(join(root, '.codex-plugin'), { recursive: true })
    await writeFile(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ version: '0.2.0' }), 'utf8')

    expect(resolveReleaseVersion(root)).toBe('0.2.0')
  })

  test('falls back to the Claude manifest, then the stable library fallback for damaged metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-release-version-'))
    await mkdir(join(root, '.claude-plugin'), { recursive: true })
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.2.1' }), 'utf8')
    expect(resolveReleaseVersion(root)).toBe('0.2.1')

    await writeFile(join(root, '.claude-plugin', 'plugin.json'), '{ bad json', 'utf8')
    expect(resolveReleaseVersion(root)).toBe(SERVER_VERSION)
  })
})

describe('resolvePayloadReleaseId', () => {
  test('recognizes only the immutable managed payload parent directory', () => {
    expect(resolvePayloadReleaseId(`/runtime/releases/sha256-${'a'.repeat(64)}/payload`))
      .toBe(`sha256-${'a'.repeat(64)}`)
    expect(resolvePayloadReleaseId('/workspace/tenon')).toBeUndefined()
    expect(resolvePayloadReleaseId('/runtime/releases/not-a-release/payload')).toBeUndefined()
  })
})

describe('resolveReleaseChannel', () => {
  const releaseId = `sha256-${'a'.repeat(64)}`

  async function payloadWithManifest(manifest: unknown): Promise<string> {
    const release = await mkdtemp(join(tmpdir(), 'pipeline-release-channel-'))
    const payload = join(release, 'payload')
    await mkdir(payload, { recursive: true })
    await writeFile(join(release, 'release.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8')
    return payload
  }

  test('a managed payload whose release.json carries devSource is a dev channel with its commit', async () => {
    const payload = await payloadWithManifest({
      version: 2, releaseId, devSource: { kind: 'dev', commit: 'abcdef0123456789abcdef0123456789abcdef01' },
    })
    expect(resolveReleaseChannel(payload)).toEqual({ kind: 'dev', commit: 'abcdef0123456789abcdef0123456789abcdef01' })
  })

  test('a stable manifest, a damaged one, a bad commit and a non-payload root are all just stable', async () => {
    expect(resolveReleaseChannel(await payloadWithManifest({ version: 2, releaseId }))).toBeUndefined()
    expect(resolveReleaseChannel(await payloadWithManifest('{ bad json'))).toBeUndefined()
    expect(resolveReleaseChannel(await payloadWithManifest({ devSource: { kind: 'dev', commit: 'xyz' } }))).toBeUndefined()
    expect(resolveReleaseChannel('/workspace/tenon')).toBeUndefined()
  })

  test('only the commit is taken from devSource; the repository path never leaves release.json', async () => {
    const payload = await payloadWithManifest({
      version: 2, releaseId,
      devSource: { kind: 'dev', commit: 'abcdef0123456789abcdef0123456789abcdef01', repoRealpath: '/Users/secret/repo' },
    })
    expect(JSON.stringify(resolveReleaseChannel(payload))).not.toContain('/Users/secret')
  })
})

describe('displayVersion', () => {
  test('appends +dev.<sha7> for a dev channel and leaves a stable version alone', () => {
    expect(displayVersion('0.3.2', { kind: 'dev', commit: 'abcdef0123456789abcdef0123456789abcdef01' })).toBe('0.3.2+dev.abcdef0')
    expect(displayVersion('0.3.2', undefined)).toBe('0.3.2')
  })
})
