# Current review mechanism (evidence)

Review today is two unrelated mechanisms. Neither lets a workflow define reviewer agents.

## Review attempt ledger (`tenon review-attempt`)

- CLI `packages/cli/src/program-review.ts:28-48`, `packages/cli/src/commands/review-attempt.ts:55-83`
  (lanes from `plan.capabilities.review.laneScopes`, budget from `plan.reviewBudget.max_attempts`).
- `begin` requires `--candidate` equal to the frozen `build_sha` (`review-attempt.ts:145-153`).
- Store `packages/kernel/src/state/review-attempt-budget.ts` (`begin` 112-170, `recordLane` 172-219,
  `complete` 221-283, aggregate = all lanes pass at 248-256), file `review-attempt-budget.json`.
- Lane evidence `{lane, result: pass|fail, reportPath, reportDigest, recordedAt}`
  (`review-attempt-budget-model.ts:42-91`). A lane is a bare string: no role, skills, order, required/advisory.
- Lanes come from step YAML `review_lanes: [standards, spec, e2e]` (`templates/workflows/default.yaml:87`,
  `workflow/parse.ts:258-266`, `workflow/types.ts:178`, `effective-plan.ts:111-113`); `simple` uses `['e2e']`.
- No guard reads the ledger. `verify-pass` reads loose fields `agent_review_result` / `codex_review_result`
  (`flow/default-event-policy.ts:86-99`, `flow/guard.ts:96-105`); pm/free skip codex.

## Review gate (`gate: review`)

- Human approval of one transition edge: `tenon review request/acknowledge`, pending receipt
  (`state/review-gate.ts:47-60`), marker `.pipeline-pending-review`, `hooks/gate.sh:325-360` blocks writes.

## Skills

- `skills/tenon-verify/SKILL.md` runs 3–4 fixed tracks in one message (143-187): `agents/tenon-reviewer.md`,
  an E2E subagent, `codex exec` (228-238), `tenon-design-reviewer` for UI (208); maps them onto 3 lanes by hand.
- `skills/tenon-build/SKILL.md` has no reviewers (313-316).
- Bundled review skills: code-review, security-review, verify, e2e-testing, browser-qa, design-taste-frontend,
  web-design-guidelines, verification-before-completion, improve-codebase-architecture, react-best-practices.

## Reusable pieces

- Skill refs `{id, kind: work|review, review_lane, depends_on}` (`workflow/types.ts:60-68`); compiler requires
  `review_lane` ∈ step lanes (`compile.ts:163-183`); waves via `depends_on` (`skillDag.ts:18-26`).
- `gate.sh:411-435` → `internal-skill-gate`; `kind: review` skills blocked unless an attempt is active for the lane
  (`internalSkillGate.ts:104-150`). This is the hook point for progressive skill loading per reviewer.
- Orchestration v2 `PipelineSkillV2` has `role` (incl. `review`), `mode: serial|parallel`, `depends_on`
  (`kernel/src/orchestration/v2-types.ts:100-130`); scheduler `chooseWave`
  (`automation/src/orchestration/runtime-v2-scheduler.ts:103`).
- Dashboard: gate radio `workflow/StageEditorPane.tsx:170-190`; `SkillFlow.tsx` + `workbench/skillWaves.ts` draw waves;
  `kind`/`review_lane` validated but not shown (`api/governanceSchema.ts:108-118,389-405`).
