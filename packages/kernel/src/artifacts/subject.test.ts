import { describe, expect, it } from 'vitest'
import {
  artifactSubjectId,
  decodeArtifactSubjectRef,
  encodeArtifactSubjectRef,
  isArtifactSubjectRef,
  isLegacyArtifactId,
  legacyArtifactIdForPath,
  newArtifactSubjectId,
  sameArtifactSubject,
  sameArtifactSubjectVersion,
} from './subject.js'

const digest = `sha256:${'a'.repeat(64)}` as `sha256:${string}`

describe('artifact subject identity', () => {
  it('derives stable identity only from namespace and explicit logical key', () => {
    const a = artifactSubjectId('change/runtime', 'report')
    expect(a).toBe(artifactSubjectId('change/runtime', 'report'))
    expect(a).not.toBe(artifactSubjectId('change/runtime', 'renamed-report'))
    expect(a).toMatch(/^subject:change\/runtime:[a-f0-9]{32}$/u)
  })

  it('issues host identities for outputs with no logical key', () => {
    const a = newArtifactSubjectId('change/runtime')
    const b = newArtifactSubjectId('change/runtime')
    expect(a).not.toBe(b)
    expect(a).toMatch(/^subject:change\/runtime:[a-f0-9]{32}$/u)
  })

  it('keeps path as source metadata and compares projections by subject/version', () => {
    const subject = artifactSubjectId('change/runtime', 'report')
    const document = { subject_id: subject, namespace: 'change/runtime', version: 'v1', projection: 'document' as const, content_digest: digest, source: { path: 'docs/report.md' } }
    const runtime = { ...document, projection: 'runtime' as const, source: { path: 'build/report.md' } }
    expect(isArtifactSubjectRef(document)).toBe(true)
    expect(sameArtifactSubject(document, runtime)).toBe(true)
    expect(sameArtifactSubjectVersion(document, runtime)).toBe(true)
    expect(sameArtifactSubjectVersion(document, { ...runtime, projection: 'document', source: { path: 'renamed.md' } })).toBe(true)
    expect(encodeArtifactSubjectRef(decodeArtifactSubjectRef(document))).toEqual(document)
  })

  it('retains exact legacy path-hash aliases for migration', () => {
    const id = legacyArtifactIdForPath('docs/report.md', 'text/markdown')
    expect(id).toBe(legacyArtifactIdForPath('docs/report.md', 'text/markdown'))
    expect(id).not.toBe(legacyArtifactIdForPath('docs/renamed.md', 'text/markdown'))
    expect(isLegacyArtifactId(id)).toBe(true)
    expect(isLegacyArtifactId('artifact:not-a-hash')).toBe(false)
  })

  it('rejects malformed refs before they cross a persistence boundary', () => {
    expect(isArtifactSubjectRef({ subject_id: 'artifact:legacy', namespace: 'change', version: 'v1', projection: 'runtime', content_digest: digest })).toBe(false)
    expect(() => decodeArtifactSubjectRef({ subject_id: 'subject:change:bad', namespace: 'change', version: 'v1', projection: 'runtime', content_digest: digest })).toThrow('invalid artifact subject reference')
  })
})
