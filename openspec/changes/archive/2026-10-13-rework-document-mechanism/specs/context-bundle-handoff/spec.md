# OpenSpec 增量规格

## MODIFIED Requirements

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
