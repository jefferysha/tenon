# OpenSpec 增量规格

## MODIFIED Requirements

### Requirement: A Workflow SHALL select document governance independently of graph length

Document contracts SHALL govern only Changes whose frozen workflow plan carries
one. A new Workflow definition SHALL NOT declare `document_contract` at the top
level or on a branch: save, Change initialization and plan compilation SHALL
reject it with an error that names the replacement (`required-output` guards
for documents a step must produce). A branch's `spec` setting, inheriting the
Workflow's top-level `openspec` value when the branch does not declare one,
SHALL select only the OpenSpec lifecycle (spec validation, spec application
and archive), never a document ledger.

A frozen plan SHALL keep one of its historical document-governance states:

1. no contract, which imposes no document ledger;
2. the full OpenSpec/Superpowers/ADR contract frozen for a default branch;
3. a versioned declarative profile that assigns supported document kinds,
   allowed producers, and exact-digest read obligations to authored step IDs.

Unknown versions, document kinds, producers, duplicate singleton owners,
missing steps, or impossible read ordering in a frozen contract SHALL fail
closed.

#### Scenario: Legacy required stays compatible

- **WHEN** an existing custom Workflow still declares `openspec_contract: required`
- **THEN** parsing fails closed with an error that names the replacement
  (`openspec: true` or a branch `spec: openspec`)
- **AND** no Change is initialized from that definition.

#### Scenario: A new definition declaring a contract is rejected

- **WHEN** a project Workflow declares `document_contract` on a branch
- **THEN** saving it or initializing a Change from it fails
- **AND** the error names `required-output` as the replacement.

#### Scenario: Default heavy branches stay governed

- **WHEN** a Change is created from the default Workflow with the pm, frontend, or backend branch
- **THEN** it keeps the OpenSpec lifecycle but has no document ledger and no document contract
- **AND** its step outputs are observed when each step is left, and its
  document gates are the branch's `required-output` guards.

#### Scenario: A lite branch in a governed Workflow has no ledger

- **WHEN** a Change uses the default Workflow with the lite branch (`spec: none`)
- **THEN** it does not initialize or require a document ledger
- **AND** declared step Skills, tests, reviewers, and gates remain enforced.

#### Scenario: Short Workflow selects compact governance

- **GIVEN** a three-step Workflow has `shape`, `implement`, and `verify`
- **WHEN** `shape` declares `required-output` guards for a proposal and a plan
- **THEN** parsing, compilation, save, initialization, CLI checks, HTTP
  transitions, and the dashboard enforce those guards
- **AND** `implement` receives the documents `shape` actually produced as its
  inputs, with no Superpowers design, ADR, or seven-phase-only document required.

#### Scenario: Short Workflow omits governance

- **WHEN** a short Workflow declares no `required-output` guard
- **THEN** it does not initialize or require a document ledger
- **AND** declared step Skills and gates remain enforced independently.

#### Scenario: An in-flight contract Change keeps its contract

- **GIVEN** a Change created before the upgrade whose frozen plan carries the
  default document contract
- **WHEN** it records, reads, checks, and transitions
- **THEN** its document ledger, producers, reads, reviews, and errors retain
  their meaning.

### Requirement: Document ownership and reads SHALL use authored step identity

For a frozen declarative profile, every registered document SHALL have one
supported kind, one owner step, at least one allowed producer, and a
project-relative safe path. A later step's read receipt SHALL be bound to that
step visit and the document's exact current digest. Re-recording content SHALL
invalidate stale receipts without altering other document slots.

#### Scenario: Producer does not match the owner step

- **WHEN** a caller records a document with an undeclared producer or outside
  its owner step in a contract Change
- **THEN** registration fails without changing the ledger
- **AND** the error identifies the allowed step and producers.

#### Scenario: Document changes after implement read

- **WHEN** a recorded plan of a contract Change changes after `implement` read it
- **THEN** the next governed exit fails until the new digest is registered and
  read by the required current step
- **AND** an old receipt cannot satisfy the new digest.
