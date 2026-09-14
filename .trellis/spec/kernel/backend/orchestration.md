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

The review gate remains `pending | approved`; `expired` is retained only for
backward codec compatibility and is never produced until canonical TTL evidence
exists. A cleared receipt is not consumption evidence. The projection must join
the exact receipt with a successful `TransitionRecord` (`event`, `from`, run/
step anchor, sequence/previous record, revision or state hash) and the review
interaction/effect chain. Missing evidence is `unknown/incomplete`; superseded
and late answers come from appended stale/rejected events.

The terminal acknowledge command derives its idempotency key under the Change
lock from `change + phase + event + requestedAt + decisionStateDigest + runId +
channel`; Dashboard sends an explicit expected revision and key. One durable
Change-owned store, `.pipeline-decision-idempotency.jsonl`, is authoritative.
Processing is idempotency lookup, exact receipt/binding check, revision check,
then atomic commit. Replays return the stored result; unexpected exceptions
return 500 and perform zero writes.

AFK is not a `SkillInvocationDecisionMode` value. `afk-producer.ts` writes an
independent `afk-decision-recorded` event and its invocation id joins to
`invocation-started.adapter.kind=afk`. `mode-switched` is an append-only event
with from/to, opaque principal, channel, effective-at, policy revision and
pending anchors; it applies only to later requests. HITL maps to `interactive`
or frozen `recommended-defaults`; AFK maps to `afk`.

`review_acknowledged_via` is a canonical field appended at the end of
`FIELD_ORDER` and synchronized across codecs, pipeline projection, fixtures and
writers. Its values are `terminal | dashboard | automation | delegated |
unknown`; it records route attribution, not human identity. `actor` is an opaque
principal and must not use `human` or `user`; bearer tokens, localhost and
markers are capability evidence only.

The shared review-acknowledge application is outside CLI and server. It owns the
Change lock, receipt/binding validation, canonical patch, interaction/history/
marker side effects, rejected handling and durable idempotency. CLI and server
are thin adapters; server passes `channel=dashboard` and cannot import CLI.

The terminal remains the only model-interaction surface. During pending review,
hooks may append a redacted `pending-decision-self-approval-suspected`
observation containing anchor, channel, signal kind, timestamp and process/host
hash. It never contains token text and never changes approval state.
