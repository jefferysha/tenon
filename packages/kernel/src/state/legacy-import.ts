import { REVIEW_GATE_FIELDS, type FieldName, type PipelineState } from '../types.js'

/** Legacy YAML is an adapter, so importing it must never edit transition-controlled state. */
export const LEGACY_IMPORT_PROTECTED_FIELDS: readonly FieldName[] = [
  'phase', 'phase_status', 'branch_status', 'build_sha', 'pre_verify_review_result',
  ...REVIEW_GATE_FIELDS,
]

/**
 * Merge legacy YAML fields over canonical state while keeping every protected canonical value.
 * Protected fields whose legacy value differed are returned so callers can tell the operator that
 * those edits were ignored instead of dropping them silently.
 */
export function mergeLegacyImportFields(
  legacy: PipelineState['fields'],
  current: PipelineState['fields'],
): { readonly fields: PipelineState['fields']; readonly ignoredProtectedFields: readonly FieldName[] } {
  const fields = structuredClone(legacy)
  const ignoredProtectedFields: FieldName[] = []
  for (const field of LEGACY_IMPORT_PROTECTED_FIELDS) {
    if (JSON.stringify(legacy[field]) !== JSON.stringify(current[field])) ignoredProtectedFields.push(field)
    fields[field] = structuredClone(current[field])
  }
  return { fields, ignoredProtectedFields }
}
