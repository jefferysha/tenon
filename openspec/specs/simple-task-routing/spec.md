# Simple Task Routing Specification

## Purpose

Define the bounded, exclusion-first simple-task route and its lightweight Workflow so narrow local
changes can run with proportionate governance without capturing broader or risky work.
## Requirements
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

