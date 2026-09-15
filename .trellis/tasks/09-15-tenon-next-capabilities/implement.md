# Integration plan

## Waves (children in the same wave run concurrently)

| Wave | Children (merge order inside the wave) | Why this order |
| --- | --- | --- |
| 0 | all 10: `design.md`, `implement.md`, `implement.jsonl`, `check.jsonl` (done) | planning is independent per child, bound by `design.md` here |
| 1 | version-reset (logic only) → multi-user → workflow-io-openspec → upstream-skills → instruction-templates | foundations: version order, identity + per-user layout, per-track documents, skill source, library shell + builtin sync. instruction-templates rebases onto `main` after multi-user merges before its audit / author commit |
| 2 | test-evidence → task-delete-archive → design-resources | need identity, per-user layout, workflow schema, library shell, upstream skills (hue) |
| 3 | review-agents | reads test records, needs identity, workflow schema, gsap rows |
| 4 | data-driven-runner | needs agents, tests, upstream skills, per-track documents |
| 5 | integration on `main`: version bump to 0.1.0, full CI mirror, real E2E in Claude Code + Codex, release v0.1.0, delete 1.x | |

## Worktree protocol (each child of a wave)

- The main session commits all planning artifacts on `main` before a wave starts, so worktrees contain them.
- One background implementation agent per child, isolated worktree, branch `feat/<child>` created from `main`.
- Setup in the worktree: `npm ci --prefer-offline`, then `npm run build:packages`.
- The agent follows its `implement.md` commit by commit and commits on its branch (repo commit style plus attribution
  lines); commits early so an interrupted run resumes from the last commit. It never pushes, merges or edits `main`.
- Runtime isolation: tests use `TENON_RUNTIME_HOME` / isolated `HOME`; no writes to the installed runtime, host global skill
  or agent directories, or MCP config. No GitHub releases or tags are touched.
- Generated files (`packages/*/dist`, `*.generated.ts`, `templates/skill-sources.yaml`) stay out of the branch unless its
  `implement.md` names a commit that must regenerate them; the main session regenerates after merge.
- Deviations from the design are written to a `## Deviations` section at the end of the child `implement.md` in the branch.
- Final report: branch, head commit, commit list, commands run with results, deviations, touched overlap files, open issues.

## Merge (main session, one branch at a time)

- `git merge --no-ff feat/<child>` after rebasing onto current `main` when needed; resolve overlap files.
- Hot overlap files: `packages/kernel/src/workflow/{types,ir,parse,serialize,compile,validate}.ts`,
  `templates/workflows/default.yaml`, `packages/dashboard-app/src/i18n/translations.ts`, `packages/server/src/server*.ts`
  routing, `packages/cli/src/program*.ts`, `hooks/gate.sh`, `TaskDetailPane.tsx`, `StageEditorPane.tsx`.
- Rebuild and regenerate, then the shared gates, then push `main` and wait for CI.

## Shared gates after every merge

```bash
npm run build
npm run check:architecture && npm run check:comments && npm run check:identity
npm test && npm run test:web && bash tools/test-hooks.sh && bash tools/verify-skills.sh
```

Full CI mirror (`rel115-gates.sh` pattern) before the wave 5 release.

## Final acceptance (wave 5)

- Parent prd cross-child acceptance scenario in both hosts (default frontend / backend / pm / free + a Dashboard-built
  workflow to 完结), with two identities.
- Release v0.1.0 via release-candidate → writer → public acceptance; one-time official install on both hosts; back up and
  delete 1.x releases and tags; rerun public acceptance.
