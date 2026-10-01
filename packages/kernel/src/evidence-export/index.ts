export { AGENT_TRACE_MAX_FILES, AGENT_TRACE_MAX_RANGES, AGENT_TRACE_VERSION, CONTRIBUTOR_TYPES, buildAgentTrace, evidenceUrl, isContributorType } from './agent-trace.js'
export type { AgentTraceContributor, AgentTraceOptions, AgentTraceRecord, ContributorType } from './agent-trace.js'
export { deterministicUuid, linesToRanges } from './ids.js'
export { EVIDENCE_NOTES_REF, EVIDENCE_NOTE_SCHEMA, decodeEvidenceNote, mergeEvidenceNote, serializeEvidenceNote } from './note.js'
export type { EvidenceNote, EvidenceNoteAnchor, EvidenceNoteEntry } from './note.js'
export { OTEL_SCOPE_NAME, SPAN_KIND_INTERNAL, STATUS_ERROR, STATUS_OK, buildOtelTrace } from './otel.js'
export type { OtlpAnyValue, OtlpAttribute, OtlpExport, OtlpSpan } from './otel.js'
export { TRAILER_CHANGE, TRAILER_EVIDENCE, evidenceNoteEntry, trailerArguments, trailerLines } from './trailer.js'
export type {
  EvidenceAgentRun, EvidenceBundle, EvidenceFileChange, EvidenceLineRange, EvidenceRecordSummary, EvidenceStepVisit, EvidenceSuiteSummary,
} from './types.js'
