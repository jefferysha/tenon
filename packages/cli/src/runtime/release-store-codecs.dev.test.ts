import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { parseManifest, runtimeReleaseIdV2, stableJson } from './release-store-codecs.js'
import type { RuntimeDevSource, RuntimeReleaseSource } from './types.js'

const DIGEST = 'a'.repeat(64)
const SOURCE: RuntimeReleaseSource = { host: 'claude', pluginVersion: '0.3.2' }
const STABLE = { version: '0.3.2', tag: 'v0.3.2', commit: 'e'.repeat(40) }
const DEV: RuntimeDevSource = {
  kind: 'dev', repoRealpath: '/work/tenon', commit: 'b'.repeat(40), dirty: true,
  worktreeDigest: 'c'.repeat(40), skillsIndexDigest: 'd'.repeat(40),
}

/** 改动前 runtimeReleaseIdV2 的逐字复刻：没有 devSource 的 release id 不得有任何变化。 */
function legacyReleaseIdV2(
  payloadDigest: string,
  source: RuntimeReleaseSource,
  stable?: { version: string; tag: string; commit: string },
): string {
  const hash = createHash('sha256')
  for (const field of [
    'tenon-runtime-release-v2', payloadDigest, source.host, source.pluginVersion,
    stable === undefined ? 'no-stable-target' : 'stable-target',
    stable?.version ?? '', stable?.tag ?? '', stable?.commit ?? '',
  ]) {
    const bytes = Buffer.from(field, 'utf8')
    hash.update(`${bytes.byteLength}:`, 'utf8')
    hash.update(bytes)
  }
  return `sha256-${hash.digest('hex')}`
}

function manifestJson(extra: Record<string, unknown>, devSource?: RuntimeDevSource, stable?: typeof STABLE): string {
  return stableJson({
    version: 2,
    releaseId: runtimeReleaseIdV2(DIGEST, SOURCE, stable, devSource),
    payloadDigest: DIGEST,
    createdAt: '2026-10-07T00:00:00Z',
    source: SOURCE,
    ...extra,
  })
}

describe('runtimeReleaseIdV2 with a development source', () => {
  test('is byte-identical to the previous algorithm when there is no development source', () => {
    expect(runtimeReleaseIdV2(DIGEST, SOURCE)).toBe(legacyReleaseIdV2(DIGEST, SOURCE))
    expect(runtimeReleaseIdV2(DIGEST, SOURCE, STABLE)).toBe(legacyReleaseIdV2(DIGEST, SOURCE, STABLE))
  })

  test('pins a formal release id to a fixed literal for a fixed input', () => {
    expect(runtimeReleaseIdV2(DIGEST, SOURCE))
      .toBe('sha256-421ae497f86d164a9b7b85ecce02480e66a0567b0ba3724fd0ef7a1ed6a4d7d8')
    expect(runtimeReleaseIdV2(DIGEST, SOURCE, STABLE))
      .toBe('sha256-abd306039c847dca1f2404da2ed68116eea818196cb6252eea55594c496d1a28')
  })

  test('every development field is part of the identity', () => {
    const base = runtimeReleaseIdV2(DIGEST, SOURCE, undefined, DEV)
    expect(base).not.toBe(runtimeReleaseIdV2(DIGEST, SOURCE))
    for (const changed of [
      { ...DEV, repoRealpath: '/other' }, { ...DEV, commit: 'f'.repeat(40) }, { ...DEV, dirty: false },
      { ...DEV, worktreeDigest: '1'.repeat(40) }, { ...DEV, skillsIndexDigest: 'absent' },
    ]) {
      expect(runtimeReleaseIdV2(DIGEST, SOURCE, undefined, changed)).not.toBe(base)
    }
  })
})

describe('parseManifest with a development source', () => {
  test('round-trips a development manifest', () => {
    const raw = manifestJson({ devSource: DEV }, DEV)
    expect(parseManifest(raw)).toMatchObject({ version: 2, source: SOURCE, devSource: DEV })
  })

  test('a manifest without devSource still parses and carries none', () => {
    expect(parseManifest(manifestJson({}))).not.toHaveProperty('devSource')
  })

  test.each([
    ['stableTarget together with devSource', () => manifestJson({ devSource: DEV, stableTarget: STABLE }, DEV, STABLE)],
    ['an extra key inside devSource', () => manifestJson({ devSource: { ...DEV, extra: 1 } }, DEV)],
    ['a malformed digest', () => manifestJson({ devSource: { ...DEV, worktreeDigest: 'xyz' } }, { ...DEV, worktreeDigest: 'xyz' })],
    ['a relative repo path', () => manifestJson({ devSource: { ...DEV, repoRealpath: 'tenon' } }, { ...DEV, repoRealpath: 'tenon' })],
    ['a release id that does not cover devSource', () => manifestJson({ devSource: DEV, releaseId: runtimeReleaseIdV2(DIGEST, SOURCE) }, DEV)],
    ['an adapter host', () => {
      const adapter = { host: 'adapter' as const, pluginVersion: '0.3.2' }
      return stableJson({
        version: 2, releaseId: runtimeReleaseIdV2(DIGEST, adapter, undefined, DEV), payloadDigest: DIGEST,
        createdAt: '2026-10-07T00:00:00Z', source: adapter, devSource: DEV,
      })
    }],
  ])('rejects %s', (_label, build) => {
    expect(parseManifest(build())).toBeNull()
  })
})
