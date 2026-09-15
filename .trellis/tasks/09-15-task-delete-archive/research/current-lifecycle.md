# Task delete / archive today (evidence)

- No delete command: `tenon --help` lists only AFK `cancel` among removal-like verbs.
- Archive exists only as the last workflow step: `tenon transition <change> archived` (phase must be `archive`) then
  `openspec archive <change> --skip-specs --yes --json` (`skills/tenon-archive/SKILL.md:95,107,180`).
- Dashboard workspace: include-archived filter only (`dashboard-app/src/workspace/TaskListPane.tsx:48,72-76`);
  archived status derived in `workspace/taskModel.ts:67,95`.
- Server: create Change `POST /api/changes` (`server/src/serverPostChangesRoutes.ts:143`); project registry removal
  `removeProjectFromRegistry` (`server/src/projects.ts:43-53`) — no Change removal route.
- Codex reference (local evidence 2026-09-15): archived conversations live in `~/.codex/archived_sessions/rollout-*.jsonl`,
  separate from `~/.codex/sessions/`; `.codex-global-state.json` has no archive keys. Archive = move the record out of the
  listed set, keep the file, unarchive restores it. The state is per user (under the user's home).
- Manual removal of 9 Changes on 2026-09-15 (commit `2290233c`) required: `git rm -r openspec/changes/<name>`,
  removing the gitignored `.pipeline-active` pointer (`.gitignore:21`), then `check:openspec`, `check:docs`,
  `check:repository-hygiene` all passed. Plans/reports/ADRs under `docs/` that reference the Changes were kept.
