# document-evidence-timeline Specification

## Purpose

Define a privacy-preserving, read-only provenance timeline for governed document evidence so operators can distinguish registration, current-phase reading, and unavailable proof without exposing sensitive ledger details or gaining mutation controls.
## Requirements
### Requirement: Snapshot exposes current document provenance

The server SHALL expose, per step of a Change, the step's real inputs and outputs as `stepIo`: for a Change without a frozen contract, the outputs observed in the step's most recent visit (the current step uses a live comparison) with change type and source skill, and the inputs handed over from its direct upstream with their read status; for a contract Change, the ledger records mapped to the same shape (records under their owner step with the registered producer as source skill, contract reads as inputs with their read status). The projection SHALL NOT expose a digest, visit ID, document body, host session, or absolute path.

#### Scenario: A current document has a matching read receipt

- **WHEN** a contract Change has a record that is current with a receipt matching the active phase, digest, and visit
- **THEN** its owner step's outputs list the record's path and producer
- **AND** the reading step's inputs mark it as read

#### Scenario: A historical receipt does not match the current proof

- **WHEN** a record is stale, unread, or only has a prior-visit receipt
- **THEN** the reading step's input for it is marked unread

#### Scenario: An observed step shows what it produced

- **WHEN** a Change created after the upgrade left its explore step after writing a design document
- **THEN** the explore entry of `stepIo` lists that design document as an added output with its source skill
- **AND** the spec entry lists it as an input with its read status

### Requirement: Dashboard explains evidence without granting control

The Dashboard workspace SHALL show, for each step, its real inputs (path, upstream step, source skill or "unknown", read or unread) and its real outputs (path, added / modified / deleted, source skill or "unknown"), with localized empty states when a step has none. It SHALL NOT offer record, read, repair, approval, or transition controls. The workflow page SHALL NOT show or edit per-step input and output tables or document contracts; its gate section SHALL list `required-output` guards as leave conditions.

#### Scenario: An older server omits optional provenance

- **WHEN** the change orchestration response has no `stepIo`
- **THEN** the client renders the localized empty states without failing the Change detail

#### Scenario: A malformed provenance object arrives

- **WHEN** `stepIo` fails decoding
- **THEN** the client rejects it through its existing response error path

#### Scenario: The workflow page has no IO tables

- **WHEN** a user opens a stage of the default backend Track on the workflow page
- **THEN** no input or output table is shown
- **AND** the gate section lists the stage's required outputs, for example the design document path on Explore

