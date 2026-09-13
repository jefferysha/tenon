# Dashboard UI 体验增量规格

## MODIFIED Requirements

### Requirement: Dashboard 主导航只暴露当前操作视图

Dashboard SHALL expose `progress` and `workbench` as its two primary operational
views, using `packages/dashboard-app/src/shell/views.ts` as the navigation source
of truth. Retired view identifiers MAY remain accepted as historical deep links,
but SHALL NOT render as primary navigation destinations or be advertised as
current product views.

#### Scenario: Open the default dashboard

- **WHEN** a user opens the Dashboard with a registered project
- **THEN** the shell shows Progress and Workbench navigation
- **AND** the selected Change, Workflow, Track, phase, and next action remain visible in the operational surface

#### Scenario: Use a retired deep link

- **WHEN** a URL contains a retired view identifier such as `hostPlan`, `machine`, or `afk`
- **THEN** the shell falls back to a supported operational view
- **AND** the URL does not create a new primary navigation destination

### Requirement: Documentation and release images reflect the same shell

Public README and usage documentation SHALL describe only the current primary
views and SHALL reference screenshots generated from the same built Dashboard
shell. Screenshots SHALL use sanitized project data and SHALL NOT claim a retired
automation view when the asset depicts the Workbench.

#### Scenario: Validate public documentation

- **WHEN** documentation and repository hygiene checks run
- **THEN** operational view claims are checked against `views.ts`
- **AND** all referenced Dashboard image assets exist and are current release assets
