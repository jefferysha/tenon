# OpenSpec 增量规格

## MODIFIED Requirements

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
