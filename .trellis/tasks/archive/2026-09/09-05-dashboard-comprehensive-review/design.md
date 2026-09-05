# Technical review design

## Review boundaries

The review treats `packages/dashboard-app/src/App.tsx` as the navigation and state boundary, each view folder as a page boundary, and `packages/server/src/serverGet*Routes.ts` / related route files as the data contract boundary. It will not change product code during this task.

## Product evaluation lens

Every feature will be scored against the product promise: a local control surface that helps a coding-agent operator understand current state, decide what to do next, and perform the smallest necessary action. Configuration, governance, diagnostics, installation, and education are supporting capabilities; they must earn their visibility by serving a concrete scenario.

The report will explicitly call out capabilities that are technically valid but misplaced in the primary experience.

## Evidence model

Each finding will carry:

- page and interaction location (component and, where useful, file:line anchor)
- category: visual, information architecture, interaction, technical, accessibility, or product value
- severity P0/P1/P2
- observed evidence from source, tests, runtime, or browser inspection
- user impact and recommended disposition: keep, merge, demote, hide, remove, or redesign

Runtime evidence will be collected from the local Dashboard at desktop, tablet, and mobile widths. Mutating controls remain unexecuted; forms and dialogs may be opened and dismissed without persistence.

## Target information architecture for recommendations

The evaluation baseline is a three-level model:

1. Primary: Projects, Progress, one focused Action surface.
2. Secondary: project detail drawers and contextual panels for AFK/automation and workflow configuration.
3. Advanced: machine diagnostics, host installation plans, traffic inspection, governance internals, and long-form product education.

This is a recommendation baseline, not an implementation decision. Findings may justify exceptions when a capability has a clear frequent user and unique action.

## Validation boundaries

The report will distinguish:

- source-confirmed behavior from runtime-observed behavior
- local dev proxy/API limitations from product defects
- automated accessibility signals from manual keyboard/focus checks
- partial page coverage from complete coverage

The final report will include an explicit unverified list and a prioritized follow-up sequence.
