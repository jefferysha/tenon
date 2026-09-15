# Custom workflow E2E in Claude Code (real UI, real host)

Host: Claude Code 2.1.270, headless `claude -p` with plugin hooks and skills loaded (66 skills).
Install: official v1.1.0 release, Claude plugin manifest patched locally with the v1.1.1 fix
(`hooks` removed) because v1.1.0 failed to load in this Claude Code version.
Dashboard: official v1.1.0 runtime on `127.0.0.1:18765`.
Raw evidence: `scratchpad/e2e-evidence/tenon-e2e-custom*/` (stream-json transcripts, plans, summaries),
`.playwright-mcp/c1-*.png` screenshots.

## Workflow built in the Dashboard UI

Playwright drove the real editor (`?view=workbench`): new blank workflow `feature-flow`, three stages,
gates, a send-back, a parallel skill wave by native drag-drop, a serial skill by the palette, two new
tracks, then per-track edits. Saved YAML (global store) matched the design:

| Track | Stage | Gate | Skills | Exit |
| --- | --- | --- | --- | --- |
| main, api | stage-1 设计 | review | writing-plans ∥ openspec-explore (one wave) | stage-1-complete → build |
| main, api | build 实现 | auto | test-driven-development | build-complete → verify |
| main, api | verify 验证 | review | verification-before-completion | verify-back → build; completes via `archived` |
| docs | stage-1 设计 | review | writing-plans ∥ openspec-explore | stage-1-complete → build |
| docs | build 实现 | none | test-driven-development | completes via `archived` |

`tenon workflow plan --json` froze exactly this graph for each Change, including
`completion_event: "archived"` on the final stages.

## C1 · `reopen-task` on track `api` (tenon-e2e-custom)

Task: implement `reopenTask(board, id)` with tests.

| Step | Skill evidence (history) | Output | Gate / transition |
| --- | --- | --- | --- |
| stage-1 | `Skill: tenon:openspec-explore` 21:07:07, `Skill: tenon:writing-plans` 21:07:08 | `docs/superpowers/plans/2026-09-15-reopen-task.md`, field `plan` | `tenon check` pass → `review request --event stage-1-complete` → **Dashboard approve** (`review:acknowledge via=dashboard`, companion `via: dashboard`, ledger `approved`) → `stage-1-complete` |
| build | `Skill: tenon:test-driven-development` 21:12:37 | 4 tests written first and seen failing, then `src/board.js` `reopenTask`, README API line | auto gate: `tenon check` pass → `build-complete` |
| verify | `Skill: tenon:verification-before-completion` 21:13:40 | `docs/superpowers/reports/2026-09-15-reopen-task-verification.md`, field `verification_report` | `review request --event archived` → **terminal approve** (`tenon review acknowledge`, exit 0, companion `via: terminal`) → `tenon transition archived` |

Result: `archived=true`, `phase_status=done`, 3 transition records, `tenon list` empty. Independent
`npm test`: 7/7 (4 new). Dashboard: skill nodes `done`, review console showed the exact event and
cleared after approval, badge `已归档`.

## C2 · `readme-docs` on track `docs` (tenon-e2e-custom-docs)

Task: write the task-board README with runnable examples.

| Step | Skill evidence | Output | Gate / transition |
| --- | --- | --- | --- |
| stage-1 | `Skill: tenon:openspec-explore` 21:17:46, `Skill: tenon:writing-plans` 21:17:47 | `docs/superpowers/plans/2026-09-15-readme-docs-plan.md` | agent stopped with three decisions instead of guessing (headless has no AskUserQuestion); after answers: `review request --event stage-1-complete` → **terminal approve** → `stage-1-complete` |
| build | `Skill: tenon:test-driven-development` 21:24:48 | `test/readme.test.js` (failed first), rewritten `README.md` incl. Known issues | gate none → `tenon transition archived` (final docs stage) |

Result: `archived=true`, independent `npm test` 4/4. The agent also found the planted `upcoming()` bug
(undated tasks sort first, comment says last) and documented it instead of widening scope.

## Defects found by these runs (all fixed in v1.1.1)

1. Claude Code refused the v1.1.0 plugin (`Duplicate hooks file`), so nothing loaded; `tenon doctor`
   stayed green.
2. Skills told agents to verify Dashboard-built tracks with `tenon tracks show`, which only knows the
   project registry (`未注册的 track 'api'`).
3. Runtime artifact catalog answered 400 for every stage that never ran on the artifact runtime; the
   Dashboard logged a failed request every 5 s.
4. An archived run still showed its last stage as current.

Frictions observed, not changed: while a review is pending the gate also blocks chained read-only
status commands (the agent recovered); `tenon doctor` reports only the most recently installed host
runtime on a machine with both hosts.
