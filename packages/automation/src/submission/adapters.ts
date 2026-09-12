import { FIELD_ORDER, recordDocument, type DocumentGovernancePolicy, type DocumentKind, type FieldName, type StateStore } from '@tenon/kernel'
import type { DocumentProjectionAdapter, FieldProjectionAdapter } from './service.js'

export function createDocumentProjectionAdapter(input: {
  readonly repoRoot: string
  readonly changeDir: string
  readonly phase: string
  readonly policy?: DocumentGovernancePolicy
  readonly kind: DocumentKind
}): DocumentProjectionAdapter {
  return {
    record: async ({ subjectRef, path, producer, recordedAt }) => {
      await recordDocument({ repoRoot: input.repoRoot, changeDir: input.changeDir, phase: input.phase, ...(input.policy ? { policy: input.policy } : {}), kind: input.kind, path, producer, recordedAt, subjectRef })
      return {}
    },
  }
}

export function createFieldProjectionAdapter(input: { readonly store: StateStore; readonly changeDir: string; readonly authorize?: (field: string, producer: string) => Promise<void> | void }): FieldProjectionAdapter {
  return {
    record: async ({ field, value, producer }) => {
      if (!FIELD_ORDER.includes(field as FieldName)) throw new Error(`unknown field: ${field}`)
      await input.authorize?.(field, producer)
      await input.store.set(input.changeDir, field as FieldName, value)
      return {}
    },
  }
}
