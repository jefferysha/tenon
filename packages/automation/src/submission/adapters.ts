import { FIELD_ORDER, recordDocument, type DocumentGovernancePolicy, type DocumentKind, type FieldName, type StateStore } from '@tenon/kernel'
import type { DocumentProjectionAdapter, FieldProjectionAdapter } from './service.js'
import { relative, resolve } from 'node:path'

export function createDocumentProjectionAdapter(input: {
  readonly repoRoot: string
  readonly changeDir: string
  readonly phase: string
  readonly policy?: DocumentGovernancePolicy
}): DocumentProjectionAdapter {
  return {
    record: async ({ subjectRef, path, documentKind, producer, recordedAt, allowBackfill }) => {
      // Artifact submissions use a path relative to the Change scope (for example
      // `proposal.md`), while the document ledger contract is rooted at the repository and
      // requires `openspec/changes/<change>/...`. Convert at this boundary so the Kernel keeps
      // owning canonical path, symlink, and `openspec/`/`docs/` validation.
      const repoRelativePath = relative(input.repoRoot, resolve(input.changeDir, path))
      await recordDocument({ repoRoot: input.repoRoot, changeDir: input.changeDir, phase: input.phase, ...(input.policy ? { policy: input.policy } : {}), kind: documentKind as DocumentKind, path: repoRelativePath, producer, recordedAt, subjectRef, ...(allowBackfill !== undefined ? { allowBackfill } : {}) })
      return {}
    },
  }
}

export function createFieldProjectionAdapter(input: { readonly store: StateStore; readonly changeDir: string; readonly authorize?: (field: string, producer: string) => Promise<void> | void; readonly persist?: boolean }): FieldProjectionAdapter {
  return {
    record: async ({ field, value, producer }) => {
      if (!FIELD_ORDER.includes(field as FieldName)) throw new Error(`unknown field: ${field}`)
      await input.authorize?.(field, producer)
      if (input.persist !== false) await input.store.set(input.changeDir, field as FieldName, value)
      return {}
    },
  }
}
