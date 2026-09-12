import { artifactSubjectId, newArtifactSubjectId } from '@tenon/kernel'
import type { ArtifactProjectionKind, ArtifactSubjectRef } from '@tenon/kernel'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { readArtifactSubjectRegistry, recordArtifactSubjectProjection, type ArtifactSubjectProjectionRecord } from './registry.js'

export interface DocumentProjectionAdapter {
  record(input: { readonly logicalKey: string; readonly subjectRef: ArtifactSubjectRef; readonly path: string; readonly documentKind: string; readonly producer: string; readonly recordedAt: string }): Promise<{ readonly stateRevisionId?: string }>
}
export interface FieldProjectionAdapter {
  record(input: { readonly logicalKey: string; readonly subjectRef: ArtifactSubjectRef; readonly field: string; readonly value: string | string[]; readonly producer: string; readonly recordedAt: string }): Promise<{ readonly stateRevisionId?: string }>
}
export interface RuntimeProjectionAdapter {
  submitArtifactOutput(stageAttemptId: string, input: Record<string, unknown>): Promise<{ readonly artifactId: string; readonly version: string; readonly contentDigest: string; readonly subjectRef?: ArtifactSubjectRef }>
}
export interface ArtifactSubmissionServiceOptions { readonly changeDir: string; readonly namespace: string; readonly now?: () => string; readonly document?: DocumentProjectionAdapter; readonly field?: FieldProjectionAdapter; readonly runtime?: RuntimeProjectionAdapter }
export interface SubmitProjectionInput {
  readonly projection: ArtifactProjectionKind
  readonly logicalKey: string
  readonly path?: string
  readonly documentKind?: string
  readonly field?: string
  readonly value?: string | string[]
  readonly stageAttemptId?: string
  readonly runtime?: Record<string, unknown>
  readonly producer: string
  readonly recordedAt?: string
}
export interface ArtifactSubmissionReceipt { readonly receiptId: string; readonly subjectRef: ArtifactSubjectRef; readonly projection: ArtifactProjectionKind; readonly status: 'committed' | 'pending' | 'failed'; readonly diagnostics?: readonly string[]; readonly recordedAt: string }

const receiptId = (namespace: string, logicalKey: string, projection: ArtifactProjectionKind): string => `submission:${namespace}:${projection}:${createHash('sha256').update(logicalKey).digest('hex').slice(0, 32)}`

export async function openArtifactSubmissionService(options: ArtifactSubmissionServiceOptions) {
  const now = options.now ?? (() => new Date().toISOString())
  async function subjectFor(input: SubmitProjectionInput): Promise<ArtifactSubjectRef> {
    if (input.path !== undefined) {
      const absolute = resolve(options.changeDir, input.path)
      const rel = relative(options.changeDir, absolute)
      if (!rel || rel.startsWith('..') || rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('submission path outside change scope')
    }
    const registry = await readArtifactSubjectRegistry(options.changeDir)
    const existing = registry.records.find((record) => record.logicalKey === input.logicalKey)
    if (existing) return { ...existing.subjectRef, projection: input.projection, ...(input.path ? { source: { ...(existing.subjectRef.source ?? {}), path: input.path } } : {}) }
    const subject_id = input.logicalKey.length > 0 ? artifactSubjectId(options.namespace, input.logicalKey) : newArtifactSubjectId(options.namespace)
    const bytes = input.projection === 'document' && input.path !== undefined
      ? await readFile(join(options.changeDir, input.path))
      : input.projection === 'field' && input.value !== undefined
        ? Buffer.from(typeof input.value === 'string' ? input.value : JSON.stringify(input.value))
        : undefined
    const content_digest = bytes === undefined ? `sha256:${'0'.repeat(64)}` as `sha256:${string}` : `sha256:${createHash('sha256').update(bytes).digest('hex')}` as `sha256:${string}`
    return { subject_id, namespace: options.namespace, version: bytes === undefined ? 'pending' : content_digest, projection: input.projection, content_digest, ...(input.path || input.documentKind || input.field ? { source: { ...(input.path ? { path: input.path } : {}), ...(input.documentKind ? { document_kind: input.documentKind } : {}), ...(input.field ? { field: input.field } : {}) } } : {}) }
  }
  return {
    async submit(input: SubmitProjectionInput): Promise<ArtifactSubmissionReceipt> {
      const recordedAt = input.recordedAt ?? now()
      const id = receiptId(options.namespace, input.logicalKey, input.projection)
      let subjectRef = await subjectFor(input)
      try {
        if (input.projection === 'runtime') {
          if (!options.runtime || !input.stageAttemptId || !input.runtime) throw new Error('runtime projection adapter unavailable')
          const output = await options.runtime.submitArtifactOutput(input.stageAttemptId, { ...input.runtime, logicalKey: input.logicalKey })
          subjectRef = output.subjectRef ?? { ...subjectRef, version: output.version, content_digest: `sha256:${output.contentDigest}` }
        } else if (input.projection === 'document') {
          if (!options.document || !input.path || !input.documentKind) throw new Error('document projection adapter unavailable')
          const result = await options.document.record({ logicalKey: input.logicalKey, subjectRef, path: input.path, documentKind: input.documentKind, producer: input.producer, recordedAt })
          subjectRef = { ...subjectRef, version: subjectRef.version === 'pending' ? 'v1' : subjectRef.version, source: { ...(subjectRef.source ?? {}), path: input.path, document_kind: input.documentKind } }
          await recordArtifactSubjectProjection(options.changeDir, { subjectRef, logicalKey: input.logicalKey, projection: 'document', path: input.path, documentKind: input.documentKind, status: 'committed', receiptId: id, recordedAt, ...(result.stateRevisionId ? { stateRevisionId: result.stateRevisionId } : {}) })
        } else {
          if (!options.field || !input.field || input.value === undefined) throw new Error('field projection adapter unavailable')
          const result = await options.field.record({ logicalKey: input.logicalKey, subjectRef, field: input.field, value: input.value, producer: input.producer, recordedAt })
          subjectRef = { ...subjectRef, version: subjectRef.version === 'pending' ? 'v1' : subjectRef.version, source: { ...(subjectRef.source ?? {}), field: input.field } }
          await recordArtifactSubjectProjection(options.changeDir, { subjectRef, logicalKey: input.logicalKey, projection: 'field', field: input.field, status: 'committed', receiptId: id, recordedAt, ...(result.stateRevisionId ? { stateRevisionId: result.stateRevisionId } : {}) })
        }
        if (input.projection === 'runtime') await recordArtifactSubjectProjection(options.changeDir, { subjectRef, logicalKey: input.logicalKey, projection: 'runtime', path: input.path, status: 'committed', receiptId: id, recordedAt })
        return { receiptId: id, subjectRef, projection: input.projection, status: 'committed', recordedAt }
      } catch (error) {
        const diagnostic = error instanceof Error ? error.message : String(error)
        await recordArtifactSubjectProjection(options.changeDir, { subjectRef, logicalKey: input.logicalKey, projection: input.projection, path: input.path, documentKind: input.documentKind, field: input.field, status: 'failed', receiptId: id, recordedAt })
        return { receiptId: id, subjectRef, projection: input.projection, status: 'failed', diagnostics: [diagnostic], recordedAt }
      }
    },
  }
}
