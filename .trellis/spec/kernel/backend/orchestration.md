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
the decision payload. `decision.mode` (`user-answer` or
`recommended-default`) and invocation adapter kind are independent dimensions.

Replay must distinguish terminal, Dashboard, and automation review. The
canonical review record therefore includes `review_acknowledged_via`. This is a
schema change: update `FieldName`, codecs, `.pipeline.yaml` projection,
fixtures, writers, and the backwards-compatible `unknown` default together.
Historical records must not be guessed to be terminal. This is not a view-only
field.

The shared review-acknowledge application lives outside CLI and server. It owns
the lock, exact pending receipt, binding verifier, receipt/state patch,
interaction/history/marker side effects, and rejected-acknowledgement record.
CLI and server are adapters; server must not import CLI or reimplement the
orchestration. Every write uses expected revision and idempotency, and a
rejected operation commits no partial canonical state.
