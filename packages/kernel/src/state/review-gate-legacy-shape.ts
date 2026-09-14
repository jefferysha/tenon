import { REVIEW_GATE_FIELDS, type FieldName } from '../types.js'

/**
 * Review-gate fields a historical canonical revision may omit, defaulted by the reader.
 *
 * Accepted shapes:
 * - the complete review-gate suffix is missing (pre-receipt revisions);
 * - only `review_gate_event` is missing and every other receipt field is empty;
 * - only `review_gate_event` and/or `review_acknowledged_via` are missing and every present
 *   receipt field is empty;
 * - only `review_acknowledged_via` is missing from an otherwise complete receipt, because the
 *   route is provenance and never authorises a transition.
 *
 * Any other omission returns an empty set so the closed-schema check rejects the revision.
 */
export function legacyReviewGateOmissions(
  rawFields: Readonly<Record<string, unknown>> | undefined,
  missing: readonly FieldName[],
): ReadonlySet<FieldName> {
  const missingReviewGateFields = REVIEW_GATE_FIELDS.filter((field) => missing.includes(field))
  const missingReviewGateSet = new Set<string>(missingReviewGateFields)
  const isCompleteReviewGateOmission = missingReviewGateFields.length === REVIEW_GATE_FIELDS.length
  const isEmptyFourFieldReceiptWithoutEvent = missingReviewGateFields.length === 1
    && missingReviewGateFields[0] === 'review_gate_event'
    && REVIEW_GATE_FIELDS
      .filter((field) => field !== 'review_gate_event')
      .every((field) => rawFields?.[field] === ''
        || (field === 'review_acknowledged_via' && rawFields?.[field] === 'unknown'))
  const isHistoricalEmptyReceiptWithoutEventOrChannel = missingReviewGateFields.length > 0
    && missingReviewGateFields.every((field) => field === 'review_gate_event' || field === 'review_acknowledged_via')
    && REVIEW_GATE_FIELDS
      .filter((field) => !missingReviewGateSet.has(field))
      .every((field) => rawFields?.[field] === '')
  const isHistoricalReceiptWithoutChannel = missingReviewGateFields.length === 1
    && missingReviewGateFields[0] === 'review_acknowledged_via'
    && REVIEW_GATE_FIELDS
      .filter((field) => field !== 'review_acknowledged_via')
      .every((field) => Object.prototype.hasOwnProperty.call(rawFields ?? {}, field))
  const accepted = isCompleteReviewGateOmission
    || isEmptyFourFieldReceiptWithoutEvent
    || isHistoricalEmptyReceiptWithoutEventOrChannel
    || isHistoricalReceiptWithoutChannel
  return accepted ? new Set<FieldName>(missingReviewGateFields) : new Set<FieldName>()
}
