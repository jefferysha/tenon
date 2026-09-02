# Implementation checklist

- [x] Add production Progress context strip with project/workflow/track/change identity.
- [x] Refactor orchestration presentation into a compact summary plus disclosure, preserving all state/action semantics and test selectors.
- [x] Reduce WorkflowCanvas visual density with scoped styles and responsive overrides.
- [x] Run format/typecheck/unit/build and the orchestration e2e suite.
- [x] Verify desktop and 390px browser screenshots and no console errors.
- [x] Remove repeated Progress context strip and realtime/subtitle copy from the default page header.
- [x] Hide zero-count status filters and show workflow selection only when there is more than one workflow.
- [x] Reduce workflow group/card copy to the stage track, task name, state, and open action while preserving detail in the drawer.
- [x] Re-run targeted tests, full Dashboard tests, typecheck, production build, and browser checks; archive the completed task.

## Verification record (2026-09-02)

- `git diff --check` — passed.
- Focused Progress/TaskDetail tests — 4 files, 135 tests passed.
- `npm run typecheck:web` — passed.
- `npm run test:web -- --reporter=dot` — 102 files, 1760 tests passed.
- `npm run build:web` — passed; production assets regenerated.
- Impeccable detector on changed Progress/TaskDetail sources — `[]`.
- Real Dashboard browser smoke at `http://127.0.0.1:18766/`: default project view shows only the non-empty `全部` and `等待中` filters, no context strip/realtime badge, no single-workflow selector, compact cards, and the drawer opens with overview/evidence/terminal/history sheets. At 390px, document/body width equals the viewport (390px) with horizontal scrolling isolated to the workflow canvas.
- Aggregate canvas coverage — project names reappear only when more than one project is shown, preserving disambiguation without adding context to the single-project view.
