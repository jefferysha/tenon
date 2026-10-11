# OpenSpec 增量规格

## MODIFIED Requirements

### Requirement: Every Workflow SHALL compile into one effective execution plan

The kernel SHALL compile built-in and project-defined Workflows through the
same validation path into an immutable effective plan. The plan SHALL expose
the graph, step Skill policy, document policy, review policy, automation
eligibility, and projection metadata consumed by CLI, server, dashboard, and
transition application.

Runtime consumers SHALL NOT use a Workflow name such as `default` as a
capability test. A built-in name MAY remain a stable identity, but behavior
SHALL be selected through explicit plan capabilities. Every newly compiled plan
SHALL use the step-graph execution model; the phase-manifest model SHALL only
be selected when restoring a frozen snapshot that recorded it.

#### Scenario: Default uses the shared compiler

- **WHEN** a default Change is initialized
- **THEN** the selected default branch is compiled through the same effective-plan
  compiler and step-graph execution model used for a custom Workflow
- **AND** its transitions, leave conditions, and actions come only from
  `default.yaml`.

#### Scenario: Custom Workflow uses the same transition application

- **WHEN** a project Workflow is compiled successfully
- **THEN** CLI and HTTP transition paths consume the same effective plan
- **AND** neither path can skip a plan-declared Skill, document, or review
  requirement.

#### Scenario: Consumer reconstructs a capability from the name

- **WHEN** a source change adds a new runtime branch that uses
  `workflow === default` to decide governance behavior outside an explicit
  compatibility/compiler module
- **THEN** the architecture check fails with the governing rule and location.

#### Scenario: A frozen legacy plan keeps its execution model

- **WHEN** a Change whose snapshot recorded `phase-manifest` is resumed after upgrade
- **THEN** the restored plan keeps `phase-manifest` and the snapshot fingerprint still verifies.

### Requirement: Todo and UI projections SHALL derive from the effective plan

The server SHALL project actual step order, visits, gates, Skills, and document
requirements from the effective plan. Dashboard and native Todo consumers
SHALL render that projection and SHALL NOT substitute the default seven phases
for a custom, short, or lite-track Workflow branch.

#### Scenario: Three-step Workflow renders three primary Todo stages

- **WHEN** a Change uses a Workflow with `shape`, `implement`, and `verify`
- **THEN** its primary Todo and dashboard progress list those three steps
- **AND** document sub-items appear under their owning step
- **AND** no unowned default phase appears.

#### Scenario: Default retains seven primary Todo stages

- **WHEN** a Change uses the default Workflow with the pm, frontend, or backend track
- **THEN** Open through Archive remain the seven primary Todo stages
- **AND** implementation tasks from the Change remain nested under their
  owning phases.

#### Scenario: Default lite track renders its own steps

- **WHEN** a Change uses the default Workflow with the lite track
- **THEN** its primary Todo lists open, build, verify, and done
- **AND** no explore, spec, ship, or archive stage appears.

## REMOVED Requirements

### Requirement: Track policy SHALL overlay rather than replace Workflow policy

**Reason**: Tracks are now branches of the Workflow itself; there is no separate Track policy to overlay, and the neutral `free` Track and packaged `simple` Workflow are retired.
**Migration**: Declare routing, document `spec`, and automation settings on the Workflow branch (`tracks.<id>.route`, `.spec`, `.automation`); see the `workflow-tracks` capability.

## ADDED Requirements

### Requirement: Branch capabilities SHALL come from the selected Workflow branch

The effective plan SHALL derive document governance from the selected branch's
`spec` and automation eligibility from its `automation` settings. Compilation
SHALL NOT add Skills from any matrix outside the Workflow YAML and SHALL NOT read
a coverage profile, review seed, or Track registry.

#### Scenario: Lite branch in a governed Workflow is ungoverned

- **WHEN** the default Workflow is compiled for the lite branch with `spec: none`
- **THEN** the plan reports no document governance and no OpenSpec finish
- **AND** the pm, frontend, and backend branches of the same Workflow remain governed.

#### Scenario: Step Skills come only from YAML

- **WHEN** the backend branch's explore step declares five Skills in `default.yaml`
- **THEN** the plan's required Skills for that step are exactly those five.
