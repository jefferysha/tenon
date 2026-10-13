# Document Evidence Contract Specification

## Purpose

Define how governed Changes prove document production, exact content,
phase-scoped consumption, and observable evidence health.
## Requirements
### Requirement: Governed changes SHALL initialize an OpenSpec document ledger
The system SHALL create the versioned `.pipeline-documents.json` sidecar only for Changes whose frozen workflow plan carries a document contract. Changes created from current workflow definitions, which cannot declare a contract, SHALL NOT receive a document ledger or proposal/design scaffolds; a branch with `spec: openspec` SHALL still receive the `tasks.md` scaffold that drives the step task gates. Where a ledger exists it SHALL remain separate from `.pipeline.yaml`, SHALL use only project-relative document paths, and SHALL be published atomically under the change lock.

#### Scenario: Default change initializes the ledger

- **WHEN** a change is initialized from a frozen default plan that carries the document contract
- **THEN** the change contains an initialized OpenSpec scaffold and a valid empty document ledger before the first phase can complete

#### Scenario: New default change has no ledger

- **WHEN** a user creates a default workflow change on the backend track
- **THEN** no `.pipeline-documents.json`, `proposal.md` or `design.md` scaffold is created
- **AND** `tasks.md` is scaffolded with one heading per step

#### Scenario: In-flight contract change keeps its ledger

- **GIVEN** a change created before the upgrade whose frozen plan carries a document contract
- **WHEN** it records and reads documents
- **THEN** its ledger is read and written exactly as before

#### Scenario: Legacy custom change remains compatible

- **WHEN** a user reads a custom workflow change that never declared a document contract
- **THEN** no document-ledger requirement is imposed and its existing state-file/API behavior remains compatible

### Requirement: A workflow SHALL opt in to OpenSpec governance explicitly and structurally
The workflow schema SHALL accept the optional top-level field `openspec_contract: required`. A workflow that opts in SHALL contain the seven canonical phases in canonical order and SHALL expose the required forward, verify-failure return, and archive transitions. Invalid governed workflows SHALL fail parsing or validation with an actionable error rather than silently falling back to an unconstrained custom workflow.

#### Scenario: Valid governed workflow is accepted
- **WHEN** a custom workflow declares `openspec_contract: required` and defines the canonical phase graph
- **THEN** it can be saved, compiled, initialized, and enforced with the same document contract as default

#### Scenario: Incomplete governed workflow is rejected
- **WHEN** a custom workflow declares `openspec_contract: required` but removes, reorders, or disconnects a canonical phase
- **THEN** validation rejects it and identifies the missing or invalid phase/transition

### Requirement: Document records SHALL prove production provenance and current content
The `tenon document record` command SHALL register a named document slot only when the target is a nonempty regular file within `openspec/` or `docs/`, the caller supplies a phase-appropriate producer, and the invocation history contains the required skill evidence. Each record SHALL contain its document kind, safe relative path, SHA-256 digest, producer, and registration timestamp.

Singleton kinds SHALL have one slot per kind, so re-registering changed or moved content replaces the prior path/digest and invalidates stale read receipts. `delta-spec` SHALL have one stable slot per capability derived from the governed path `openspec/changes/<change>/specs/<capability>/spec.md`. Different capabilities SHALL coexist and each SHALL require its own exact-hash read receipt; rewriting one capability SHALL replace only that capability's slot.

#### Scenario: Skill-produced OpenSpec proposal is recorded
- **WHEN** the open phase has invoked the declared OpenSpec proposal skill and records the proposal document
- **THEN** the ledger stores the proposal path, current digest, producer, and timestamp

#### Scenario: Arbitrary producer claim is rejected
- **WHEN** a caller attempts to register a document with a producer that has no matching phase skill evidence
- **THEN** the command fails without altering the ledger and reports the required skill evidence

#### Scenario: Multiple capability deltas remain independently auditable
- **WHEN** a governed Change registers delta specs for capability A and capability B
- **THEN** the ledger retains both records
- **AND** later phase reads create exact-hash receipts for both

#### Scenario: Rewriting one capability delta preserves the others
- **WHEN** capability A is re-registered after its canonical delta content changes
- **THEN** capability A receives the new digest and loses only its stale read receipts
- **AND** capability B's record and receipts remain intact

#### Scenario: Ambiguous delta path is rejected
- **WHEN** a caller attempts to register `delta-spec` outside the governed capability path shape
- **THEN** registration fails closed without modifying the ledger

#### Scenario: Symlink aliases cannot manufacture capabilities
- **WHEN** a lexical capability path resolves through a parent symlink or path alias
- **THEN** registration rejects it because its project-relative real path differs

#### Scenario: Legacy delta records require explicit lossless migration
- **WHEN** an upgraded ledger contains a delta record outside the canonical capability path
- **THEN** ordinary registration preserves that record
- **AND** read and evidence evaluation fail closed with a `document migrate-delta` repair command
- **AND** migration succeeds only when the explicitly named canonical file has the exact old digest
- **AND** compatible provenance and different-phase receipts are preserved atomically and idempotently
- **AND** provenance or same-phase receipt conflicts fail before publication

### Requirement: Later phases SHALL record exact-hash document reads
The `tenon document read` command SHALL re-hash recorded documents and persist a receipt for the current phase only when the file still matches the recorded digest. Required phase exits SHALL reject missing, stale, or incomplete receipts. A changed document SHALL require re-registration and re-reading before a later phase can pass.

#### Scenario: Build receives its complete specification context
- **WHEN** a governed change enters the build exit check
- **THEN** it must have current read receipts for proposal, OpenSpec design, tasks, Superpowers design, ADR, delta spec, Superpowers plan, and plan

#### Scenario: Edited ADR invalidates a receipt
- **WHEN** an ADR is modified after a later phase has recorded its read receipt
- **THEN** the next check or transition fails until the ADR is re-recorded and re-read at its new digest

### Requirement: Check and transition SHALL enforce the phase evidence matrix
For Changes whose frozen plan carries a document contract, both `tenon check` and transition application SHALL enforce the documented output and input matrix for open, explore, spec, build, verify, ship, and archive. The failure response SHALL identify the missing document kind, required producer/read phase, and the command needed to repair it. The enforcement SHALL run in both CLI and dashboard server paths. Changes without a frozen contract SHALL instead be gated by their observed handoff reads and `required-output` guards.

#### Scenario: Spec cannot advance without delta spec and plan evidence

- **WHEN** a contract change runs `spec-complete` without registered delta spec, Superpowers plan, or plan
- **THEN** both CLI check and transition reject the attempt with document-evidence blockers

#### Scenario: Server transition cannot bypass document checks

- **WHEN** a dashboard API transition targets a contract change with incomplete document evidence
- **THEN** the server returns its existing compatible error shape and leaves the canonical run state unchanged

#### Scenario: An observed change is not asked for kind records

- **WHEN** a change created after the upgrade leaves its spec step
- **THEN** no `document-evidence` blocker asks it to record or read a document kind

### Requirement: Evidence status SHALL be observable in the dashboard and health checks

The change snapshot SHALL include a read-only document-evidence projection with
required records, current/stale status, producer, and phase read receipts. The
dashboard SHALL present this projection next to a Change's phase Todo without
inventing completed artifacts.

Doctor and host adapters SHALL report the exact Selected Skill Root used for
execution and evidence. They SHALL distinguish a Skill available from that
native immutable root, a static-only project projection, a same-digest
duplicate projection, a different-digest shadow conflict, and an inactive
historical cache. They SHALL NOT require project `.agents/skills` links when
native plugin discovery is authoritative.

#### Scenario: Dashboard shows missing document evidence

- **WHEN** a governed change has not registered a required artifact for its current exit
- **THEN** the Dashboard labels the artifact as missing and names the phase that requires it

#### Scenario: Native Codex discovery is sufficient

- **GIVEN** Codex has one verified native tenon Selected Skill Root
- **WHEN** doctor evaluates mandatory Skill discoverability
- **THEN** it reports the mandatory Skills discoverable from that root
- **AND** it does not require or create project `.agents/skills` links.

#### Scenario: Static adapter is the only available discovery mechanism

- **GIVEN** no native tenon Selected Skill Root exists
- **WHEN** an explicitly selected static adapter exposes conflict-safe project
  links
- **THEN** doctor reports the project projection as the sole active Skill root.

### Requirement: Artifact producer authorization SHALL survive disabled automatic orchestration

A Track MAY disable automatic Skill matrix injection while retaining a named
Skill profile for explicit document and artifact production. In that case,
`artifact register` SHALL validate its producer against the profile's
phase-specific allowlist. It SHALL NOT treat `matrix=false` as an empty
authorization set, and it SHALL NOT enable automatic Skill gating as a side
effect.

#### Scenario: Free Verify registers its governed report

- **GIVEN** the free Track has `matrix=false` and profile `free`
- **AND** the Verify profile allows `verification-before-completion`
- **WHEN** that Skill registers `verification_report`
- **THEN** artifact registration succeeds
- **AND** ordinary free-Track Skill orchestration remains disabled.

### Requirement: Review confirmation SHALL persist an exact event receipt and never self-lock
The review gate SHALL represent a pending review as a canonical, project-scoped receipt containing the exact current phase and requested transition event. After the user has seen the artifacts and explicitly confirms, `tenon review acknowledge` SHALL persist an approval receipt and clear only its matching short-lived marker projection. `tenon transition` SHALL consume only that exact approved receipt. It SHALL not require an unavailable host-specific question event, shall not treat read-only inspection as a blocked write, and shall fail closed for unrelated or unconfirmed prompts. Direct marker deletion SHALL never be an approval mechanism.

#### Scenario: Explicit confirmation unlocks only the requested transition
- **WHEN** a review receipt for `verify-pass` is pending and the user explicitly confirms it
- **THEN** the confirmation hook or CLI acknowledgement persists approval for the current phase and `verify-pass`, clears only the matching marker projection, and the next authorized `verify-pass` transition can run

#### Scenario: A different event cannot reuse an approval
- **WHEN** a `verify-pass` receipt is approved and a caller attempts `verify-fail`
- **THEN** the transition is rejected because the approved receipt does not match the requested event

#### Scenario: Unrelated prompt does not unlock a review marker
- **WHEN** a review marker is active and the user submits an unrelated message
- **THEN** the marker remains active, no approval receipt is written, and mutation attempts remain blocked

