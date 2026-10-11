# OpenSpec 增量规格

## MODIFIED Requirements

### Requirement: The router SHALL provide a first-party simple task track

Clearly bounded, low-risk local changes (typos, comments, copy strings, unused
imports, single local values) SHALL be served by the `lite` track of the
built-in `default` Workflow rather than by a separate `simple` Track or
Workflow. The router SHALL treat such requests like any other development
request: it SHALL require an assessment before Change creation unless the user
names a track. The `simple` Track and Workflow SHALL be retired; selecting them
MUST fail with a message that names `--workflow default --track lite`.

#### Scenario: A bounded text correction uses the lightweight workflow

- **WHEN** a user asks to correct a typo in one file and no exclusion signal is present
- **THEN** the dispatch requires an assessment with the default lite track among the candidates
- **AND** after the user confirms, the Change begins at the lite track's `open` step

#### Scenario: A normal developer request still triggers governance

- **WHEN** a user asks to implement, fix, or modify code without naming a track
- **THEN** the request is assessed and routed to the lite track or the applicable pm/frontend/backend track
- **AND** it is not silently dropped merely because no narrow technology keyword matched

#### Scenario: The retired simple workflow points to its replacement

- **WHEN** a caller runs `tenon init <c> --workflow simple`
- **THEN** the command fails without creating a Change
- **AND** the error names `--workflow default --track lite`

## REMOVED Requirements

### Requirement: Simple classification SHALL be fail-closed and exclusion-first

**Reason**: Lightness is no longer decided by keyword classification; development requests are assessed against the lite track's change-risk thresholds before a Change is created.
**Migration**: Use `tenon assess --files <paths…>`; exclusion keywords now live in the lite branch's `route.exclude` and only decide whether lite is offered as a candidate (see `workflow-tracks`).

### Requirement: The simple workflow SHALL verify changes without the governed document chain

**Reason**: The packaged `simple` Workflow is retired; its role is taken by the default lite track, which runs focused tests and one review gate.
**Migration**: Create bounded changes with `--workflow default --track lite`; in-flight `simple` Changes finish on their frozen snapshots.

### Requirement: Scope expansion SHALL escalate rather than bypass governance

**Reason**: Escalation is now defined once for the lite track, driven by the change-risk probe, and hands off to a heavy track of the same Workflow.
**Migration**: See the lite-track requirement in `workflow-tracks`; escalated lite Changes are archived and linked to the new Change through `depends_on`.
