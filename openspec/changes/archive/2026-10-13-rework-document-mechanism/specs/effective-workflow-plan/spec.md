# OpenSpec 增量规格

## MODIFIED Requirements

### Requirement: Branch capabilities SHALL come from the selected Workflow branch

The effective plan SHALL derive the OpenSpec lifecycle (`capabilities.documents.governed`) from the selected branch's
`spec`, the document mode (`capabilities.documents.mode`: `contract` when the frozen plan carries a document contract,
`observed` otherwise) from the plan's frozen policy, and automation eligibility from its `automation` settings.
Compilation SHALL NOT add Skills from any matrix outside the Workflow YAML and SHALL NOT read a coverage profile, review
seed, or Track registry. A Change bound to the `legacy-full` profile without a frozen snapshot SHALL be given the frozen
`openspec-v1` document policy rather than downgraded.

#### Scenario: Lite branch in a governed Workflow is ungoverned

- **WHEN** the default Workflow is compiled for the lite branch with `spec: none`
- **THEN** the plan reports no OpenSpec lifecycle, no OpenSpec finish and the `observed` document mode
- **AND** the pm, frontend, and backend branches of the same Workflow report the OpenSpec lifecycle with the
  `observed` document mode.

#### Scenario: A frozen contract plan keeps contract mode

- **WHEN** a Change created before the upgrade restores its frozen plan that carries the default document contract
- **THEN** the plan reports the `contract` document mode with that frozen policy.

#### Scenario: Step Skills come only from YAML

- **WHEN** the backend branch's explore step declares five Skills in `default.yaml`
- **THEN** the plan's required Skills for that step are exactly those five.
