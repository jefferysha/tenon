# Automation Orchestration Boundary

## Ownership

`packages/automation/src/orchestration/` is an application boundary. It sequences provider, routing,
executor, and validator ports but does not own a second state machine. `packages/kernel/src/orchestration/`
remains the only owner of canonical schemas, transitions, revision checks, and capability selection rules.
The public surface is exported from `packages/automation/src/index.ts`; consumers must not deep-import
another package's implementation files.

## Untrusted proposal handling

Capability providers return `unknown`. `proposal.ts` first takes an accessor-free, bounded JSON snapshot,
rejecting getters/accessors, cycles, custom prototypes, sparse arrays, non-JSON values, excessive depth,
node count, or byte size. The snapshot is decoded once with Kernel's `decodeCapabilityAssessmentV1`.
Request ownership and provider provenance are checked at the host boundary. Host-owned assessment identity,
timestamp, output reference, digest, and byte count are never accepted from the model.

Scene labels are not a routing or transition key. Canonical assessment fields are capabilities, constraints,
risks, and clarification questions; any labels remain ordinary signal data.

## Routing and execution

The application delegates Skill/MCP candidate selection to Kernel `resolveCapabilities`, preserving user
selection and dependency intent. It may add host policy blockers such as denied permissions and validates
the explicit Work Item-to-Skill binding before applying a `resolve-capabilities` command.

Execution applies `claim-work-item`, `begin-skill-run`, `complete-skill-run`, and `record-validation` through
`applyBoardCommand`, always using the latest returned revision. Independent graph groups may run with
`Promise.allSettled`; a shared read/write resource is serialized, and a blocking sibling is applied after
progressing siblings so a successful result cannot overwrite an aggregate blocked/failed state.

## Heterogeneous Skill output

Executor output is opaque JSON metadata plus artifact references. It is bounded and never copied into the
canonical board snapshot. A validator is the only authority allowed to return `contract_status: validated`;
missing, malformed, or failing validation produces an unknown/invalid result and a Kernel-defined blocked or
failed Work Item. The adapter never treats model confidence or executor self-claims as proof of completion.

For arbitrary files, `ExecutionRuntimeV2` opens a durable `StageArtifactRuntime` in `change_dir` for every stage
(or consumes the injected `artifact_service`). It reconciles file changes before ending the attempt and passes the
runtime publisher to the executor. Observation is automatic; publication remains explicit, so an unregistered file is
visible as an unknown-origin candidate without being silently promoted to a deliverable. `catalog` enforces the
attempt's dependency-chain visibility and `runChecks` executes registered checkers on demand.
When a managed command completion has no safe structured path, the Codex executor schedules at most one fallback
reconcile for that execution turn; later pathless events are coalesced, while structured observations and the final
stage-end reconcile remain immediate.
The real executor path `StageArtifactRuntime.submit(path)` is also a governed submission boundary: it resolves an
existing canonical subject by logical key or registered source path before writing the runtime version, then records
the runtime projection in the change subject registry. Tests that call the submission service directly do not replace
this production-path check. Opening a change-scoped service migrates a legacy `runtime-artifacts` store once with a
`legacy-scope` receipt, and direct `ExecutionRuntimeV2` construction uses the same change namespace helper. A single
`StageArtifactRuntime` serializes overlapping reconciles through one in-flight promise.

## Error and recovery behavior

Provider, executor, validator, abort, binding, and revision failures use stable application error codes or
diagnostic tags and do not include raw payloads or secrets. Automatic retry is intentionally not performed;
callers use the existing Kernel `retry-work-item` command with a fresh expected revision. Board state remains
Kernel-owned; runtime artifact state is persisted under `.pipeline-artifacts/<scopeId>` with content-addressed blobs
and an atomic lock. Server read routes and Dashboard projections are read-only and preserve the same fail-closed
semantics.

## Executable contract

### 1. Scope / trigger

This contract applies whenever an Automation adapter turns an untrusted capability proposal into
Kernel state or invokes a selected Skill. It is required for cross-layer proposal, routing, execution,
and validation changes. The adapter does not add a second board state machine; its runtime artifact store is a
separate durable projection with explicit observation/publication semantics.

### 2. Public signatures

The public API is exported from `packages/automation/src/index.ts`:

- `requestCapabilityAssessment(input)` accepts a frozen request/context projection and a
  `CapabilityProposalProvider` returning `unknown`; it returns a structured success or a stable
  `proposal-invalid` / `provider-failed` / `provider-aborted` outcome.
- `runCapabilityOrchestration(input)` resolves capabilities, validates explicit Work Item-to-Skill
  bindings, and executes dependency-ready Work Items through `SkillExecutorPort` and optional
  `SkillResultValidatorPort` ports.
- `SkillExecutorPort.execute` receives `{ run_id, work_item_id, skill_id, skill_version, mcp_ids,
  input_artifacts, signal }` and returns `Promise<unknown>`.
- `SkillResultValidatorPort.validate` receives the binding and bounded observation and returns
  `{ contract_status: 'validated' | 'unknown' | 'invalid', diagnostics, report? }`.

### 3. Request/response contracts

- Every proposal envelope must contain `output` and provider provenance (`provider`, `model`,
  `invocation_id`). The host supplies `proposal_id`, timestamp, output reference, SHA-256 digest,
  byte count, and media type after bounded normalization.
- Every executor observation must contain `output`, `artifacts`, and `diagnostics`; optional
  `raw_output_ref` must be a safe opaque reference. Output is retained only as bounded sanitized
  metadata and is never copied into the canonical board snapshot.
- A `validated` validator decision must include a Kernel-decodable `ValidationReportV1` bound to the
  current Work Item. `unknown` and `invalid` are explicit non-proof states.
- Commands are applied through Kernel with the latest returned board revision. Dependency inputs are
  `skill-result:<result_id>` artifact references from prior completed results.

### 4. Validation and error matrix

| Condition | Required behavior |
| --- | --- |
| Provider output has a getter, cycle, custom prototype, sparse array, forbidden key, non-JSON value, or exceeds depth/node/byte limits | Reject as `proposal-invalid`; do not invoke Kernel routing or persist raw data. |
| Proposal request/project/change/provider/model does not match the host-owned envelope | Reject with a stable provenance/ownership issue. |
| Descriptor unavailable, permission denied, required MCP/Skill unbound, or explicit dependency missing | Persist Kernel resolution blockers and return a blocked or waiting state before any executor call. |
| Executor throws/rejects | Complete the run once with failed/invalid result and preserve a stable diagnostic; do not fabricate success or retry. |
| Validator is absent, malformed, mismatched, or reports unknown/invalid | Record opaque result evidence and leave the Work Item blocked by Kernel validation semantics. |
| Abort signal is observed before a claim or after a settled wave | Apply one `cancel` command at the current revision and return the cancelled board. |
| Command revision/duplicate-run/CAS invariant fails | Return a structured command failure; never mutate a stale snapshot around the conflict. |

### 5. Good / base / bad cases

- Good: a complete decoded assessment selects available, permission-safe descriptors; each graph Work
  Item has one pinned binding; a validator returns a matching pass report; the board reaches
  `verifying` with immutable result and validation evidence.
- Base: an executor returns domain-specific JSON plus an opaque output reference and no validator is
  configured; the run is completed, but the Work Item remains blocked with `result-contract-unproven`.
- Bad: a provider or validator returns an accessor, prototype-pollution key, oversized payload, or a
  report for another Work Item; the boundary rejects it without executing a Skill or marking success.

### 6. Required tests and assertion points

- Proposal tests must assert host identity/time replacement, single decode, unknown-field rejection,
  request/provenance mismatch, bounded/accessor/cycle/prototype-key rejection, and provider
  failure/abort mapping.
- Execution tests must assert serial dependency ordering, propagation of `skill-result:*` refs,
  safe parallel concurrency, resource-conflict serialization, permission/binding blocking, opaque
  no-validator blocking, validator binding failure, executor failure, and pre/post-wave cancellation.
- Kernel orchestration tests remain the source of truth for schema and transition invariants; build,
  architecture, comments, and `git diff --check` are required before commit.

### 7. Wrong vs correct

#### Wrong

```ts
// Trusts model/executor claims and stores arbitrary payloads in board state.
state = { ...state, status: 'completed', output: providerOutput }
```

#### Correct

```ts
const snapshot = snapshotJsonBoundary(providerOutput, limits)
const assessment = decodeCapabilityAssessmentV1(snapshot.value)
// Host-owned evidence and a validator report are required before a result is proof.
state = applyBoardCommand(state, completeSkillRunCommand(opaqueResult)).state
state = applyBoardCommand(state, recordValidationCommand(validatorReport)).state
```
