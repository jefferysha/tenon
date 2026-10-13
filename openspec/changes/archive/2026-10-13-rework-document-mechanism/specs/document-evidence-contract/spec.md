# OpenSpec 增量规格

## MODIFIED Requirements

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
