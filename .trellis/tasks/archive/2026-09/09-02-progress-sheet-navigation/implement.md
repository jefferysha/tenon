# Implementation plan

1. Read the dashboard specs and inspect existing App/Nav/Progress/TaskDetail contracts; freeze the boundary above.
2. Add failing tests for breadcrumbs, rootless Progress navigation, and Progress sheet semantics.
3. Implement `PageBreadcrumbs` and `ProjectRequiredState`; mount them in `App.tsx` and remove only the rootless redirect branch that causes the bounce.
4. Add translated sheet labels and scoped Progress styles.
5. Add `ProgressSurface` to `ProgressDrawer` and an optional surface renderer to `TaskDetail`, preserving the `all` compatibility path.
6. Run focused unit tests, typecheck, detector, full web tests, build, and the existing orchestration Playwright suite.
7. Start the isolated local preview, verify desktop and 390px mobile behavior with the existing in-app browser binding, and inspect console/overflow.
8. Update the task validation checklist, commit only the source/task changes, and report exact verification evidence. Do not claim remote publication unless a separate push is requested.

Rollback points: the breadcrumb/gate changes are independent of the drawer surface prop; if a surface regression appears, reverting the `ProgressDrawer` surface wiring restores the prior all-sections detail while retaining navigation fixes.

## Verification record

- `python3 ./.trellis/scripts/task.py validate .trellis/tasks/09-02-progress-sheet-navigation` — passed.
- `node /Users/a1234/.agents/skills/impeccable/scripts/detect.mjs --json` against changed dashboard sources — passed with no findings.
- `npm run typecheck:web` — passed.
- `npm run test:web` — 102 files / 1,758 tests passed.
- `npm run build:web` — passed (Vite production bundle generated).
- In-app browser smoke checks — breadcrumbs navigate Projects ↔ Progress, sheet tabs mount one active surface, desktop and 390px mobile have no horizontal overflow, and the stale orchestration 404 panel stays hidden after the structured not-found response.
