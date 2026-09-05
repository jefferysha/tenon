# Review execution plan

## Phase A — Inventory and contracts

- [ ] Enumerate all Dashboard routes/views, nested panels, dialogs, drawers, tabs, selectors, forms, and destructive/mutating controls.
- [ ] Map each UI capability to its API client and server route; flag duplicate or orphaned surfaces.
- [ ] Read existing Dashboard UX/design records and test coverage to identify prior intended behavior.

## Phase B — Runtime page review

- [ ] Start the local Dashboard and capture each primary view at 1440px, 768px, and 375px.
- [ ] Check page height, horizontal overflow, loading/error/empty states, console errors, and failed network requests.
- [ ] Exercise read-only interactions: navigation, breadcrumbs, filters, search, tabs, drawers, dialogs, collapsibles, host selection, theme/language, and keyboard focus.
- [ ] Record mutation controls without submitting them; verify labels, affordances, confirmation boundaries, and recoverability.

## Phase C — Findings and product triage

- [ ] Review each page for visual hierarchy, density, terminology, action priority, responsive behavior, accessibility, and duplicated information.
- [ ] Classify every feature as keep, merge, demote, hide, remove, or redesign with evidence and rationale.
- [ ] Assign P0/P1/P2 priority and identify dependencies or migration risks.
- [ ] Define the reduced core journey and target navigation.

## Phase D — Deliverables and gates

- [ ] Write the complete review report in the task directory with page-by-page findings and evidence.
- [ ] Add a prioritized redesign backlog and staged implementation plan.
- [ ] Record unresolved or environment-limited checks explicitly.
- [ ] Run `npm run test:web` only if needed to validate report claims; do not claim a full repository gate from focused checks.
- [ ] Run `git diff --check` and preserve all unrelated user changes.

## Risk and rollback

This task is read-only with respect to product code. The only expected changes are planning/review artifacts under `.trellis/tasks/09-05-dashboard-comprehensive-review/`. If runtime inspection requires a local server, stop it after review; do not modify project data or invoke mutating Dashboard actions.
