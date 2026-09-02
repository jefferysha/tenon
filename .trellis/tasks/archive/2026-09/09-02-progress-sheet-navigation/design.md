# Design: navigation breadcrumbs and Progress sheets

## Change boundary

The behavior gap is in the dashboard shell and Progress detail surface: rail navigation currently redirects a rootless user away from Progress, and the drawer renders every stage, artifact, audit, and session section in one scroll context. The source of truth already lives in `App.tsx` selection state and `TaskDetail`/`ProgressDrawer`; the fix stays at those boundaries.

Expected files:

- `packages/dashboard-app/src/shell/PageBreadcrumbs.tsx` — shared breadcrumb presentation and view callbacks.
- `packages/dashboard-app/src/shell/ProjectRequiredState.tsx` — rootless, actionable page gate.
- `packages/dashboard-app/src/App.tsx` — mount breadcrumbs and render the gate without changing project-selection policy.
- `packages/dashboard-app/src/progress/ProgressDrawer.tsx` — sheet selection and active surface composition.
- `packages/dashboard-app/src/shared/TaskDetail.tsx` — optional surface rendering; default behavior remains the existing full detail for compatibility.
- `packages/dashboard-app/src/progress/progress.css` and `packages/dashboard-app/src/i18n/translations.ts` — scoped responsive styles and bilingual labels.
- Existing shell/progress tests — executable acceptance coverage.

Explicitly out of scope: schema/API changes, implicit project selection, a new router, a new chat backend, or a wholesale redesign of AFK/Machine/Host Plan pages. The shared breadcrumb and rootless gate apply to those pages; sheet decomposition is focused on the currently failing Progress drawer and can be extended later using the same surface contract.

## Navigation model

`App.tsx` remains the navigation owner. `PageBreadcrumbs` receives the current `View`, selected root/name, selected change, and `onView`. It renders `首页 → 项目 → <project> → <page>` where available. Clicking an ancestor calls the existing `setView`/`commitView` path; it never mutates project selection. The current item is a non-link with `aria-current="page"`.

The project-selection model deliberately does not infer a root. For a non-empty snapshot with `currentRoot === ''`, root-dependent views render `ProjectRequiredState` rather than triggering a redirect. A selected but non-writable root retains the existing fail-closed redirect behavior for mutation-oriented views.

## Progress sheet contract

```ts
type ProgressSurface = 'summary' | 'outputs' | 'terminal' | 'history'
```

`ProgressDrawer` owns one `surface` state, defaults to `summary`, and resets it when the selected change/root changes. It renders a semantic `tablist` and exactly one mounted `tabpanel`. The active `TaskDetail` receives `surface`; `surface="all"` remains the default for direct callers and legacy tests.

- `summary`: intro/actions, current stage and verdict, next action, and a disclosure for the complete stage timeline.
- `outputs`: current-stage evidence, registered documents, verification controls, and the orchestration graph behind a disclosure where appropriate.
- `terminal`: run log, related sessions, resume/connection commands, and the boundary note explaining Web versus terminal responsibilities.
- `history`: run audit, transition history, and technical diagnostics.

All four surfaces read the same `change`, `rules`, and snapshot-derived props. No surface writes status directly; existing transition actions continue to own mutations. Mounting only the active surface prevents duplicate effects, duplicate log polling, and inaccessible hidden content.

## Plain-language strategy

Domain identifiers remain available in the URL, data attributes, and detailed records for traceability. Summary labels are translated with new keys and avoid exposing raw `[document]`, `pre_verify_review_result`, or orchestration internals until the user deliberately opens Outputs/Records.

## Responsive and accessibility requirements

Use native buttons with `role="tab"`, `aria-selected`, and `aria-controls`; panels expose `role="tabpanel"` and a stable id. The drawer keeps a single scroll region per active panel, uses existing focus/close behavior, and follows the existing 760px responsive breakpoint plus reduced-motion media query. Breadcrumbs are wrapped rather than horizontally clipped.
