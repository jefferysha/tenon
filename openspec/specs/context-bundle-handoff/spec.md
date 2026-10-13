# Context Bundle Handoff Specification

## Purpose

Define a deterministic, ledger-bound, budgeted context package that a
downstream pipeline phase can verify and consume without replacing canonical
OpenSpec documents or their read receipts.
## Requirements
### Requirement: Handoff SHALL compile a deterministic Context Bundle v1

The existing handoff command SHALL support compiling a versioned
`context-bundle/v1` for one exact target phase or role without changing legacy
handoff output. The bundle SHALL contain Change identity, source and target,
governance tier, ordered inputs, each input's document kind, project-relative
path, ledger SHA-256 digest, policy reason, materialization mode, bounded budget
usage, and one aggregate digest over the canonical bundle payload.

#### Scenario: Same inputs produce the same bundle

- **GIVEN** the Change state, policy, ledger records, and source bytes are
  unchanged
- **WHEN** the same target bundle is compiled twice
- **THEN** ordered inputs and aggregate digest are byte-for-byte identical.

#### Scenario: Legacy handoff remains compatible

- **WHEN** the caller does not request bundle mode
- **THEN** the existing text and JSON handoff contracts remain unchanged.

### Requirement: Context Bundle inputs SHALL come from authoritative evidence

Bundle compilation SHALL select inputs according to the Change's document mode rather than directory scan order: a
contract Change uses its effective document policy, and an observed Change uses the handoff inputs of its current step
visit (the direct upstream visit's document outputs). Every materialized input SHALL have a current authoritative
digest — the ledger record for a contract Change, the recorded output digest or the input's current read digest for an
observed Change — that matches the source bytes. Missing, unrecorded, stale, or ambiguous mandatory input SHALL fail
compilation with the exact kind or path and repair action; it SHALL not be silently omitted.

#### Scenario: A recorded source has drifted

- **GIVEN** the ledger records one digest for the design document of a contract Change
- **WHEN** the file bytes have changed
- **THEN** bundle compilation fails closed
- **AND** instructs the caller to re-record and re-read the document.

#### Scenario: Policy determines input order and reasons

- **WHEN** a Build bundle is compiled for a contract Change
- **THEN** proposal, OpenSpec design, tasks, Superpowers design, ADR, delta
  specs, Superpowers plan, and plan appear in policy order
- **AND** every entry has a nonempty policy-owned reason.

#### Scenario: An observed Change bundles its handoff inputs

- **WHEN** a Build bundle is compiled for a Change created after the upgrade
- **THEN** its inputs are exactly the document outputs of the spec visit that transitioned into build, in path order
- **AND** each entry names the upstream step as its reason.

### Requirement: Context Bundle budget SHALL be explicit and bounded

The compiler SHALL report `maxBytes` and `usedBytes`. It SHALL apply only
deterministic full/summary/reference modes declared by policy. If mandatory
materialized content cannot fit the allowed budget, compilation SHALL fail with
an over-budget diagnostic instead of truncating content nondeterministically.

#### Scenario: Mandatory inputs exceed the requested budget

- **WHEN** mandatory bundle inputs exceed `maxBytes`
- **THEN** compilation exits non-zero
- **AND** reports required and available bytes
- **AND** emits no valid aggregate digest.

### Requirement: Context Bundle consumption SHALL detect drift

A consumer SHALL be able to re-hash every materialized input and the canonical
bundle payload before use. A mismatch SHALL invalidate the bundle and require a
new compile/read cycle. A Context Bundle SHALL remain a derived artifact and
SHALL NOT replace canonical Change state or the document ledger.

#### Scenario: Source changes after bundle compilation

- **WHEN** a source file changes after bundle generation
- **THEN** bundle verification fails before a governed mutation
- **AND** no old digest is rewritten or accepted as current evidence.

