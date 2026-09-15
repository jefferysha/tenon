# Identity: Trellis vs Tenon (evidence)

## Trellis (v0.6.16 in this repo)

- `init_developer.py <name>` writes gitignored `.trellis/.developer` (`name=`, `initialized_at=`) and creates
  `workspace/<name>/journal-1.md`, `index.md` (`scripts/common/developer.py:56-143`); refuses to overwrite (`init_developer.py:37-42`).
- Lookup order `get_developer()` (`common/paths.py:100-139`): `TRELLIS_DEVELOPER` env → `.trellis/.developer` →
  main worktree's `.developer`; `--assignee` overrides. No git config fallback; no authentication.
- Shared in git: tasks (task.json, prd/design/implement), archive, per-developer journals, spec. Local only:
  `.developer`, `.current-task`, `.runtime/` (`.trellis/.gitignore:2,5,8`).
- task.json `creator` (always current dev), `assignee` (default current dev), `branch`, `base_branch`, `parent/children`,
  `pr_url` (`common/task_store.py:344-356,504-510`); `list --mine` = `assignee == developer` (`task.py:379-436`).
- Conflicts avoided by per-developer dirs, append-only journals with `merge=union`, regenerated index; no claims/locks.
- AI sessions: `.runtime/sessions/<platform>_<id>.json` keyed by hook session id / `TRELLIS_CONTEXT_ID` /
  `CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID` (`common/active_task.py:81-115,340-364,518-553`). Sessions are not
  linked to a developer.

## Tenon today: no "who"

- Review acknowledgement records only `review_acknowledged_at/_via` (terminal|dashboard|automation|delegated|unknown),
  "provenance, not operator identity" (`kernel/src/review-gate-fields.ts:31-32`, `state/review-gate.ts:62-71`).
- Delegated authority bound to host session, not user (`cli/src/continuousAuthority.ts:12-89`,
  `cli/src/commands/review-acknowledge.ts:48`).
- `TransitionRecord.actor?` intentionally empty: a bearer token is not a user identity (`kernel/src/workflow/run-types.ts:79-81`);
  CLI interaction events emit `actor:'system'` (`cli/src/interaction-emitter.ts:97-98`).
- Orchestration v2 actor ids hard-coded `'cli'` / `'dashboard'` (`cli/src/commands/orchestration.ts:103,145`,
  `dashboard-app/src/api/orchestrationV2Client.ts:105`).
- Document confirmations store a sha256 of the host session id (`skill-invocation/document-confirmation.ts:233,277`).
- One Dashboard token per machine (`kernel/src/product-paths.ts:156`, `server/src/token.ts`); "token is not human
  evidence" (`server/src/transition.ts:329`).
- Per-repo single files shared by everyone: `.pipeline-active` (gitignored), `.pipeline-interaction-authority`.

## Reusable from Trellis

Identity lookup order (env → gitignored local file → main worktree file), creator/assignee + `--mine`, per-user
append-only journals with `merge=union`, per-host session files keyed by platform session id (add a user field to
link them). Trellis does not solve authentication, claims, or concurrent writes; Tenon's revision/idempotency ledger
already handles concurrent writes.
