# Declarative Document Governance Specification

## Purpose

Define versioned, workflow-shaped document ownership, production, and read obligations independently
from the default seven-phase graph while preserving the legacy governed contract.
## Requirements
### Requirement: A Workflow SHALL select document governance independently of graph length

Document governance SHALL be selected per Workflow branch through its `spec`
setting, inheriting the Workflow's top-level `openspec` value when the branch
does not declare one. A branch SHALL be in one of three document-governance
states:

1. `spec: none`, which imposes no document ledger;
2. `spec: openspec` on a default branch, which SHALL retain the full
   OpenSpec/Superpowers/ADR contract declared for that branch;
3. `spec: openspec` with a versioned declarative profile that assigns supported
   document kinds, allowed producers, and exact-digest read obligations to
   authored step IDs.

The declarative profile SHALL NOT require canonical default phase names or a
fixed step count. Unknown versions, document kinds, producers, duplicate
singleton owners, missing steps, or impossible read ordering SHALL fail
closed.

#### Scenario: Legacy required stays compatible

- **WHEN** an existing custom Workflow still declares `openspec_contract: required`
- **THEN** parsing fails closed with an error that names the replacement
  (`openspec: true` or a branch `spec: openspec` with `document_contract`)
- **AND** no Change is initialized from that definition.

#### Scenario: Default heavy branches stay governed

- **WHEN** a Change uses the default Workflow with the pm, frontend, or backend branch
- **THEN** its document ledger, producers, reads, reviews, and errors
  retain their meaning.

#### Scenario: A lite branch in a governed Workflow has no ledger

- **WHEN** a Change uses the default Workflow with the lite branch (`spec: none`)
- **THEN** it does not initialize or require a document ledger
- **AND** declared step Skills, tests, reviewers, and gates remain enforced.

#### Scenario: Short Workflow selects compact governance

- **GIVEN** a three-step Workflow has `shape`, `implement`, and `verify`
- **WHEN** its versioned profile assigns proposal and plan production to
  `shape` and exact reads to `implement` and `verify`
- **THEN** parsing, compilation, save, initialization, CLI checks, HTTP
  transitions, and dashboard evidence accept and enforce that contract
- **AND** no Superpowers design, ADR, or seven-phase-only document is required
  unless the profile explicitly declares it.

#### Scenario: Short Workflow omits governance

- **WHEN** a short Workflow has no document profile
- **THEN** it does not initialize or require a document ledger
- **AND** declared step Skills and gates remain enforced independently.

### Requirement: Document ownership and reads SHALL use authored step identity

For a declarative profile, every registered document SHALL have one supported
kind, one owner step, at least one allowed producer, and a project-relative
safe path. A later step's read receipt SHALL be bound to that step visit and
the document's exact current digest. Re-recording content SHALL invalidate
stale receipts without altering other document slots.

#### Scenario: Producer does not match the owner step

- **WHEN** a caller records a document with an undeclared producer or outside
  its owner step
- **THEN** registration fails without changing the ledger
- **AND** the error identifies the allowed step and producers.

#### Scenario: Document changes after implement read

- **WHEN** a recorded plan changes after `implement` read it
- **THEN** the next governed exit fails until the new digest is registered and
  read by the required current step
- **AND** an old receipt cannot satisfy the new digest.

### Requirement: Governance profile identity SHALL persist without eager migration

Canonical run state and API projections SHALL retain the selected document
profile identity. Readers SHALL interpret the legacy boolean OpenSpec field as
the full legacy profile. New writes SHALL use the current versioned identity
on existing authorized mutation paths and SHALL NOT perform a destructive
startup migration.

#### Scenario: Old state uses the boolean

- **WHEN** an upgraded release reads a Change with
  `openspecContract: true`
- **THEN** it compiles the full legacy document profile
- **AND** the Change can continue without rewriting unrelated state.

#### Scenario: New declarative state is read by an old release

- **WHEN** an old release cannot understand the profile schema
- **THEN** it fails closed rather than treating the Change as ungoverned
- **AND** managed rollback remains available through the existing release
  mechanism.

### Requirement: Document evidence errors SHALL remain compatible and actionable

CLI and HTTP SHALL preserve their existing exit/status/error envelopes while
including the missing/stale kind, owner step, required producer/read step, and
repair command where applicable.

#### Scenario: HTTP cannot bypass a missing compact-profile read

- **WHEN** a dashboard transition attempts to leave `implement` without its
  declared plan read
- **THEN** the request returns the existing compatible transition-error shape
- **AND** canonical state and ledger remain unchanged.

