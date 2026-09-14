# Autonomous Orchestration v1 Contract

## 1. Scope / Trigger

This contract governs the first pure-Kernel slice for autonomous development:
natural-language request metadata, capability assessment, custom Skill/MCP
resolution, frozen WorkGraph projection, heterogeneous Skill results, board
commands, and state transitions. It is triggered by the public exports under
`packages/kernel/src/orchestration/`.

The Kernel owns no model call, filesystem access, process execution, HTTP, or
vendor SDK. Those concerns must adapt into these records at the application or
infrastructure boundary.

## 2. Signatures

```ts
createOrchestrationState(request, now?): BoardSnapshotV1
applyBoardCommand(state, command): ApplyCommandResult
resolveCapabilities(input: ResolveCapabilitiesInput): CapabilityResolutionV1
decodeDevelopmentRequestV1(input): OrchestrationDecodeResult<DevelopmentRequestV1>
decodeCapabilityAssessmentV1(input): OrchestrationDecodeResult<CapabilityAssessmentV1>
decodeSkillResultEnvelopeV1(input): OrchestrationDecodeResult<SkillResultEnvelopeV1>
decodeBoardCommandV1(input): OrchestrationDecodeResult<BoardCommandV1>
```

## 3. Contracts

- Every persisted record carries an explicit `*-v1` `schema_version`.
- `DevelopmentRequestV1` records the user intent, `auto_select`, ordered
  custom Skill nodes (`serial|parallel` plus `depends_on`), and MCP selections.
- `CapabilityAssessmentV1` records capability requirements, MCP requirements,
  constraints, risks, confidence, signals, and clarification questions. It has
  no closed scene enum.
- `WorkGraphV1` carries one frozen `TaskPlanRevisionV1`; it is a projection and
  must not become a second task-plan source of truth.
- `CapabilityResolutionV1` pins selected Skill/MCP versions, source (`user` or
  `auto`), rationale, unresolved capabilities, and blockers.
- `SkillResultEnvelopeV1` keeps `raw_output` opaque. Completion requires both
  `status=completed` and `contract_status=validated`; artifact references and
  validator evidence remain separately inspectable.
- `BoardCommandV1` is the only state-changing surface. Every command includes
  `change_id`, `expected_revision`, actor, and UTC issue time. Successful
  commands increment revision exactly once; rejected commands do not mutate.

## 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Unknown schema field, malformed JSON, invalid identifier/time/enum | codec returns `ok=false` with path-specific error |
| `expected_revision` differs from snapshot | `revision-conflict`; no state change |
| Assessment or context bound to another request/project | `contract-invalid` |
| Unfrozen TaskPlan or graph bound to another Change | `contract-invalid` |
| Capability resolution blocked | snapshot persists the resolution and enters `blocked`; no transition to ready |
| Missing Skill/MCP, dependency cycle, unsupported parallelism, write conflict | resolver records blocker; execution cannot start |
| Opaque, incomplete, corrupt, failed, or unvalidated Skill output | work item becomes blocked/failed; never completed |
| Failed validation | work item becomes blocked and retains report |
| Waived gate without non-empty rationale | `contract-invalid` |
| Pause without reason or resume from non-paused state | `contract-invalid` / `invalid-transition` |

## 5. Good / Base / Bad Cases

- Good: explicit `skill.plan` is pinned, missing `testing` is auto-selected,
  the result envelope is validated, validators pass, and the verification gate
  moves the Change to `completed`.
- Base: a Skill returns a different domain shape but supplies an opaque artifact
  reference; the board displays it and waits for a validator.
- Bad: a caller writes `status=completed` directly, reuses a stale board
  revision, or treats `contract_status=unknown` as success; all are rejected or
  blocked.

## 6. Tests Required

- Request/result codecs: unknown fields, invalid schema, JSON input, and valid
  round-trip-shaped objects.
- Resolver: explicit-before-auto ordering, missing capability, dependency
  cycle, unsupported parallel Skill, MCP availability, and parallel write
  conflict.
- Reducer: full happy path, CAS conflict, wrong transition, result contract
  failure, validation failure, gate rationale, pause/resume, retry, cancel, and
  duplicate active run.
- Architecture: Kernel runtime import graph remains acyclic and free of
  infrastructure imports.

## 7. Wrong vs Correct

### Wrong

```ts
snapshot.status = 'completed'
```

### Correct

```ts
applyBoardCommand(snapshot, {
  schema_version: 'board-command/v1',
  type: 'evaluate-gate',
  expected_revision: snapshot.revision,
  // ... gate status and evidence
})
```

The reducer checks all prerequisites and emits the next immutable snapshot;
board and future HTTP/CLI adapters must not bypass it.

## Decision synchronization contract

The review gate remains `pending | approved`. A cleared receipt is not evidence
that a transition consumed an approval: a read model must join the receipt with
the matching `TransitionRecord` (`event`, `from`, run/step anchor,
`sequence`/`previousRecordId`, revision or state hash) and the successful
review interaction/effect chain. Missing evidence is `unknown/incomplete`.
`superseded` and late answers are append-only rejected/stale events projected by
the read model. `expired` is deferred until a canonical TTL record exists.

AFK provenance is obtained by joining a decision's invocation id to the durable
invocation record whose `adapter.kind` is `afk`; it must never be inferred from
the decision payload. `SkillInvocationDecisionMode` remains
`user-answer | recommended-default`; AFK is represented by the invocation
adapter and a separate AFK source/strategy record. It must not be added as a
third value, and Dashboard must never answer a hard-gate Skill question.

Replay must distinguish terminal, Dashboard, and automation review. The
canonical review record therefore includes `review_acknowledged_via`. This is a
schema change: update `FieldName`, codecs, `.pipeline.yaml` projection,
fixtures, writers, and the backwards-compatible `unknown` default together.
The field is appended after the existing review receipt fields in canonical
serialization. Older records that omit it decode as `unknown`; `unknown` means
the channel was not recorded, while an empty value is invalid for new writes.
The complete enum is `terminal | dashboard | automation | delegated | unknown`.
Replay takes the channel from the `TransitionRecord` effect's `from` value or
the linked interaction event; `delegated` identifies an explicitly delegated
terminal authority and does not prove a human identity. This is not a view-only
field: FieldName sets, codec, pipeline projection, golden fixtures, migration
reader, and every writer must agree on the append order.

The shared review-acknowledge application lives outside CLI and server. It owns
the lock, exact pending receipt, binding verifier, receipt/state patch,
interaction/history/marker side effects, and rejected-acknowledgement record.
CLI and server are adapters; server must not import CLI or reimplement the
orchestration. Every write uses expected revision and idempotency, and a
rejected operation commits no partial canonical state.

Command processing is ordered and observable: (1) acquire the Change lock and
look up the durable idempotency record; (2) if the key exists, compare the full
command payload and return the stored result, or return
`idempotency-conflict` for a different payload; (3) only for a new key, read
the exact pending receipt and verify its binding; (4) compare
`expected_revision`; (5) commit canonical changes and the idempotency record in
one locked operation. Idempotency records live in the Change-owned durable
idempotency store, never in process memory. CLI hooks that have no revision or
idempotency key may emit an observation only; they cannot acknowledge or
create a canonical decision. A missing request id is anchored by
`requestedAt + decisionStateDigest + runId`; a future schema may add a stable
request id, but a caller must not invent one from the current state.

Late, not-pending, binding-mismatch, and revision-conflict attempts each append
one rejected audit event (idempotently) and leave canonical state untouched.
CLI maps these outcomes to a non-zero exit and stable machine code;
`review-approval-required` covers missing/late/not-pending/binding failures,
`revision-conflict` covers a stale expected revision, and
`idempotency-conflict` covers key reuse with a different payload.

The channel is an entry route (`terminal`, `dashboard`, `automation`, or
`delegated`), not an assertion about the operator. A bearer token authenticates
local capability only; `actor` must not be serialized as `human` unless a
separate trusted identity provider exists. Host resume is capability-gated: an
integration may send a resume signal only when the host advertises that API;
otherwise the next reconciliation/read refresh must observe the durable state.
Unverified host capabilities are labelled `unverified` and never treated as a
successful wake-up.

Terminal answer collection is explicit. `confirm-clear-prompt.sh` invokes
`review-ack.sh manual` (or `delegated`), while `decision-recorder.sh` writes a
`host-skill-interaction-receipt/v1` through `hostInteraction.ts` containing
`host_session_id` and an HMAC-derived host identity. The HMAC binds the host
session but cannot prove a human; projection joins this receipt to the
question/invocation and exposes `channel=terminal` or `delegated`, with source
`host`. A host that writes the question only after the answer has no pending
visibility before that write; projection must return `absent/unknown`, never
fabricate a pending question.

Mode switching is an append-only `mode-switched` contract event (from/to,
channel, actor, effective-at, policy revision, and pending request anchors),
not a decision. HITL maps to `interactive` or the narrowly scoped
`recommended-defaults`; AFK maps to the separate `afk` strategy. A switch
affects only subsequent requests; existing pending requests keep their frozen
strategy or are explicitly superseded. The actor field is an opaque principal
identifier and must not use `human` by convention.
