import { START_SHA_FIELD } from '../review-gate-fields.js'
import { REVIEW_GATE_FIELDS, type FieldName, type PipelineState } from '../types.js'

/** Legacy YAML is an adapter, so importing it must never edit transition-controlled state. */
export const LEGACY_IMPORT_PROTECTED_FIELDS: readonly FieldName[] = [
  'phase', 'phase_status', 'branch_status', 'build_sha', 'pre_verify_review_result',
  // The task start point is written once by `init`; the YAML projection does not carry it (its value lives in
  // a companion record), so a legacy YAML must never blank or replace it.
  START_SHA_FIELD,
  ...REVIEW_GATE_FIELDS,
]

/**
 * Protected fields the YAML projection never states: an empty legacy value there means "not stated", not an
 * edit worth reporting. Only a YAML that names a different value is reported as ignored.
 */
const UNSTATED_WHEN_EMPTY: ReadonlySet<FieldName> = new Set([START_SHA_FIELD])

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
    const unstated = UNSTATED_WHEN_EMPTY.has(field) && legacy[field] === ''
    if (!unstated && JSON.stringify(legacy[field]) !== JSON.stringify(current[field])) ignoredProtectedFields.push(field)
    fields[field] = structuredClone(current[field])
  }
  return { fields, ignoredProtectedFields }
}
