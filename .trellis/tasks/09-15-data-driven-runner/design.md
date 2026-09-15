# Design: single data-driven `tenon` skill

> **Parent overrides** (`.trellis/tasks/09-15-tenon-next-capabilities/design.md` §9 wins over this file): X1 agent CLI next/prompt/record; X2 test command required; X3 default document tables live in default.yaml (update producer ids there); X4 implement the implicit `tenon` producer for role:update slots, OpenSpec living refresh and applied-spec in the validator, no `document_contract.updates`; X6 no design-quality agent, use frontend-quality; X16 default tests; X17 完结; X18 real-host runs in wave 5.

Binding contracts: `.trellis/tasks/09-15-tenon-next-capabilities/design.md` (terms §1, layout §3, YAML §4, records §5,
execution boundary §6). Where this design needs a change to a shared contract, it is listed in §11 and not applied here.

## 1. Boundaries

### In scope

- Rewrite `skills/tenon/SKILL.md` as the only Tenon-owned skill: routing, resume, HITL/AFK, and one per-step loop that
  interprets a CLI-computed next-actions list.
- CLI: `tenon status <change> --json` gains a `step` block (§4.1); new `tenon spec apply <change> [--dry-run]` (§4.2);
  retired-skill refusal (§4.3); `recommended` field values (§4.4); an actionable coverage blocker (§4.5); doctor skill
  lists derived from workflow data (§4.6).
- Kernel: document producer contract moves from `tenon-<phase>` to `tenon` (`document-contract.ts`,
  `document-contract-validation.ts`); retired-skill detection helper.
- Data: `templates/workflows/default.yaml` per track (pm, frontend, backend, free, chat), the builtin `simple` workflow
  (`builtin-workflows.ts` + `templates/workflows/simple.yaml`), and `templates/manifest.yaml` projections.
- Removals: 7 phase skills, `simple-task`, `learn-record`, `tenon-researcher`, `agents/`, the interaction-contract
  generator, and the docs gate that pins phase skills.
- References: hooks wording, `templates/workflow.md`, adapters text, tools gates, tests, docs, main OpenSpec specs.
- Real-host E2E acceptance on Claude Code and Codex (§9.4).

### Out of scope

- Agent library storage, install, loader, run records, reviewer guard (`09-15-review-agents`). This child only authors
  the builtin agent bodies migrated from `agents/` and consumes the run CLI.
- Test directions, runner, records, test guard (`09-15-test-evidence`). This child declares tests in default data and
  consumes `tenon test run`.
- Fetching upstream skills and the provenance registry format (`09-15-upstream-skills`).
- The `openspec: true` toggle, per-track `document_contract` parsing/validation, handoff for custom contracts
  (`09-15-workflow-io-openspec`); DESIGN.md kind and roles (`09-15-design-resources`).
- Removing kernel hand-filled fields (`build_mode`, `isolation`, `direct_override`, `pre_verify_review_result`,
  `branch_status`, PM `verify_result`, `pr_url`, `prd_path`): 36–67 files each (grep count), handled generically (D8).
- Removing the Track skill matrix overlay (`manifest.yaml` `mandatory_skills`, `.pipeline/tracks.yaml` profiles,
  Dashboard `workbench/mandatoryConfig.ts`): not requested (D14).
- Compatibility for Changes created before the migration (D10).

## 2. Inventory of the skills being removed

"Mechanics" = instructions whose effect is a Tenon command or guard; they move into the `tenon` skill (T) or CLI (C).
"Prose" = process description duplicated by upstream skills or expressible as workflow data; dropped (X) or data (Y).

| Skill (lines) | Mechanics → destination | Prose → destination |
| --- | --- | --- |
| `tenon` (504) | interaction-mode contract `skills/tenon/SKILL.md:6-24` → T §3.3; locale + scaffold rule `:28-34` → T; Codex read ABI `:40-63` → T; dispatch intents new/select/resume, selection pairs, free/simple/custom `:76-159` → T §3.4; `session activate --host-session --continuous` `:127-147` → T; Todo from real graph `:148-153` → T; document read/status/backfill rule `:192-209` → C (`step.documents`); CLI precheck `:217-228` → T; review exit order `:428`, custom gate + `completion_event` `:430-440` → C (`step.next`); error table `:460-471` → T §3.9 | phase dispatch table `:304-321` → Y (plan skills); keyword routing `:235-260` → X (router already scores, `:259-260`); archive soft reminder `:285-295` → X; phase×document table `:182-190` → C; pause-node list `:401-425` → Y (gates, interactive skills, field decisions); preset upgrade `:442-456` → X; migration placeholders `:230-233,337-340,398-399,500-504` → X; quick reference `:486-504` → X |
| `tenon-open` (247) | `tenon init` with workflow/track + registry check `skills/tenon-open/SKILL.md:137-152` → T; activate before any skill `:154-170` → T; record proposal/design/tasks `:197-212` → C (`record-document`); check + `open-complete` `:214-229` → C | triage `:70-75` → X; per-track proposal emphasis `:87-99` → X (upstream `openspec-propose`); preset question `:104-122` → C (`fields.recommended`); pipeline_mode placeholder `:128-135` → X; depends_on example `:179-183` → X |
| `tenon-explore` (300) | `document read all` `skills/tenon-explore/SKILL.md:75-80` → C; `artifact register design_doc --producer brainstorming` `:190-198` → C (`register-field`); refresh proposal/design/tasks by phase driver `:200-222` → C (producer `tenon`); record superpower-design/adr `:224-239` → C; coverage block `:241-261` → C §4.5; check → review request → acknowledge → transition `:263-279` → C | per-track skill order `:99-188` → Y (skills + `depends_on`); researcher sub-agent per dimension `:89,105-109,131,157` → Y (executor `researcher`); dimension question `:106` → X; continuous exception `:91-97` → T §3.3; optional skills `:118-119,144-150,163-170` → X |
| `tenon-spec` (275) | delta-spec scaffold `--capability`, SHALL/MUST, strict validate before review `skills/tenon-spec/SKILL.md:28-35` → C (`validate-spec` = `tenon spec apply --dry-run`; SHALL/MUST already in the scaffold prompt, `docs/usage/release-notes.md:14`); record delta-spec/superpower-plan/plan `:184-200` → C; register plan `:177-182` → C; tasks/proposal/design refresh `:202-222` → C (`tenon`); coverage + superpower-design refresh `:224-239` → C; review exit `:245-262` → C | journey rubric `:92-100` → X; B1/B2/B3 plan rules `:160-175` → X; per-track order → Y; `coverage_confirmed_by` placeholder `:241-243` → X |
| `tenon-build` (407) | `build_mode`/`isolation`/`direct_override` `skills/tenon-build/SKILL.md:86-117` → C (`fields`); no self-created branch/worktree/commit `:105-108` → T; tasks tick + refresh + read `:295-307` → C (`tenon`); `pre_verify_review_result=pass` `:324-331` → C (outcome field after required tests); gate handling `:352-356` → C; build token freeze `:357-362,379-393` → unchanged CLI action `packages/kernel/src/flow/default-event-policy.ts:71-84`; `requirements-changed` `:364-372` → T §3.7 | concurrency table `:63-77` → X; stack rules placeholder `:80-84` → X; PM prototype engine/N/winner `:141-195` → Y (pm build skills + interactive gate + step `prompt`); TDD red/green `:201-205,240-244` → X (upstream TDD); per-task tight loop `:285-293` → Y (build tests); sub-phase `/clear` `:277-283` → X; readiness enumeration `:318-335` → Y (tests); handoff bundle `:134` → X |
| `tenon-verify` (467) | `document read all` `skills/tenon-verify/SKILL.md:62-63` → C; review-attempt begin/lane/complete `:74-92,357-368` → review-agents runs; frozen token read `:147-181` → C (candidate in agent/test records); repo-zero-output `:104-111` → review-agents/test-evidence staleness; PM `verify_result`/`branch_status` `:131-139,386-393` → C (outcome fields); isolated OpenSpec rehearsal `:320-337` → C §4.2; `agent_review_result`/`codex_review_result` `:339-356` → deleted by review-agents; record report + tasks refresh `:370-384` → C; pass/fail readiness `:395-444` → C (`exits`); 「确认继续」 at verify-fail `:458-459` → T | three/four lanes per track `:143-273` → Y (reviewers + tests); `codex exec` lane `:228-244` → X; per-file spec re-read table `:292-318` → Y (`spec-consistency` reviewer); optional database reviewer → X |
| `tenon-ship` (229) | `document read all` `skills/tenon-ship/SKILL.md:56` → C; applied-spec receipt `:166-181` → C §4.2 + producer `tenon`; tasks refresh → C; `pr_url`/`prd_path` `:139-151` → C (fields; never fabricated, E2E D1/X1 `research/e2e-default-workflow-and-codex.md:23,62`); migration receipt guard `:153-164` → unchanged CLI guard; `ship-complete` `:183-207` → C | per-track sequences `:59-137` → Y; commit/push/PR baseline `:100-103` → Y (`finishing-a-development-branch` + `pr_url`); `openspec-archive-change` at ship `:94-95` → X (upstream archives); command accelerators `:226-229` → X |
| `tenon-archive` (192) | tasks refresh + read + status + check `skills/tenon-archive/SKILL.md:53-64` → C; `transition archived` then `openspec archive --skip-specs --yes --json` `:92-111` → T (`complete`) | dependents grep `:75-86` → X; learn-record ask/triggers `:113-143` → X; skill-creator `:145-151` → X; handoff `:153-158` → X; irreversible confirm `:182-187` → T (interactive exit pause) |
| `simple-task` (54) | `scope-expanded` + new default Change + `depends_on` link `skills/simple-task/SKILL.md:24-38` → T §3.7; `change-complete` `:46-50` → C | boundary checklist `:13-22`, execute rules `:40-45` → Y (simple `change` step `prompt`) |
| `learn-record` (199) | only `tenon get archived` `skills/learn-record/SKILL.md:147-148` → X | writes `~/.claude/skills/learned` and a personal wiki `:16-21,162-175` → X |
| `tenon-researcher` (14) | none | research method `skills/tenon-researcher/SKILL.md:11-14` → builtin agent `researcher` |
| `agents/` (4 files, 193) | none (no CLI calls) | role bodies → builtin agents `builder`, `researcher`, `design-quality`; `tenon-reviewer` → review-agents presets (D19) |
| `templates/workflow.md` (60) | CLI-only state, explicit resume, review receipts, continuous authority `templates/workflow.md:15-54` → kept as ≤25-line constitution | 7-phase diagram and default event list `:6-24` → X; marker TTLs `:28-31` → X; breadcrumb/`/clear` `:56-60` → X |

Result: every mechanic is either a CLI projection that the skill executes, or one of ~10 generic rules in the skill.
No rule in the new skill names a track or the default workflow (R6).

## 3. The `tenon` skill

Target ≤ 230 lines, so reloading it at each step entry costs about 3k tokens (D3). Frontmatter `name: tenon`,
description "按任务冻结的工作流逐步执行：路由、恢复、每步照 `tenon status --json` 的下一步做".

### 3.1 When to use

- Invoked by `<tenon-dispatch> action: invoke-skill skill: tenon` (`hooks/router.sh:774`) or `/tenon`.
- Chat questions do not create a Change.

### 3.2 Codex skill reads (kept, condensed from `skills/tenon/SKILL.md:40-63`)

- Load plugin skills as `tenon:<id>`; never a same-named global/project copy.
- One anchored read per skill: `text(await tools.exec_command({cmd:"cat <path>", max_output_tokens:<≥ file tokens>}));`
  or the bound form; no batches; a truncated read is not evidence.

### 3.3 Modes (from `step.mode`)

| Mode | Source (CLI) | Rule |
| --- | --- | --- |
| `interactive` | default | Ask decisions (AskUserQuestion; Codex: one plain question, end turn). Before every `transition`/`complete`, show outputs, test results and reviewer findings and wait for 「继续」. Review gate: `request-review`, show, end turn; approval reply is 「确认继续」. |
| `continuous` | change-bound interaction authority exists (`tenon session activate --continuous`) | No pauses for choices that have `recommended`; review gate: `tenon review acknowledge <c> --delegated` after `request-review`. Back edge after failed required tests/reviewers is taken (fix), never "accept deviation". |
| `afk` | `TENON_AFK=1` | As continuous; `await-review` ends the run with the step status. |

All modes: never skip a skill, document, test, reviewer, guard or read; push, PR, deploy and other external effects need
explicit authority in this task; interactive skills (`hooks/interactive-skill-gate.sh:25`) run their own dialogue.

### 3.4 Enter

1. `command -v tenon` or stop with the reinstall hint.
2. Dispatch `intent: new` → derive a kebab-case name; `intent: select` or `selection_required: true` → ask for one exact
   `candidate` pair, stop turn; `intent: resume` → only the named change. Manual `/tenon` without dispatch: `tenon list --json`,
   ask when more than one.
3. New: `tenon init <c> --workflow <w> --track <t> --preset full` (the user may name another preset); then
   `tenon session activate <c> [--host-session <id>] [--continuous]`. Resume: `tenon session activate <c> …`.
4. Build Todo from `tenon workflow plan <c> --json` steps (labels), current step from `current_step`.
5. Enter the loop.

### 3.5 Loop

```
repeat:
  S = tenon status <c> --json | .step
  if S.next[0].action == stop → report S.next[0].message, end
  do every item of S.next that shares next[0].action (one wave), per §3.6
  after `transition`/`complete` → load `tenon` again (new StepVisit), continue or pause per mode
```

### 3.6 Action table (closed set, mirrors §4.1)

| `action` | Skill does |
| --- | --- |
| `stop` | Report `message`; end. |
| `load-tenon` | Reload this skill (Claude `Skill tenon`, Codex anchored read). |
| `read-documents` | Read each listed file fully, then `tenon document read <c> all`. |
| `run-agent` | Per item: `tenon agent start <c> <agent> --role <role> --json` → run the returned prompt in the host (Claude Agent tool; Codex subtask or `codex exec`; hosts without subagents: sequentially in main session) → `tenon agent finish <c> <run_id> --result … --report … --findings …`. Same `wave` runs in parallel. |
| `load-skill` | Load each skill of the wave and follow it under §3.8. |
| `scaffold-document` | `tenon document scaffold <c> <kind> [--capability <cap>]` (only if the file is absent), then author it. |
| `record-document` | `tenon document record <c> <kind> <path> --producer <producer>`. |
| `register-field` | `tenon artifact register <c> <field> <path> --producer <producer>`. |
| `set-field` | §3.7 decisions, then `tenon set <c> <field> <value>`. |
| `validate-spec` | `tenon spec apply <c> --dry-run`; on exit 2 fix the delta spec and rerun. |
| `apply-spec` | `tenon spec apply <c>`. |
| `configure-test` | Ask the user for the command (show `hint`); continuous/afk: stop. |
| `run-test` | `tenon test run <c> <test>`; `status: fail` → fix first, then rerun. |
| `fix` | Resolve each `blockers[]` item (edit code/documents), then loop. |
| `request-review` | `tenon check <c>` → `tenon review request <c> --event <event>` → present. |
| `await-review` | Interactive: end turn. Continuous: `tenon review acknowledge <c> --delegated`. AFK: end run. |
| `choose-exit` | §3.7 exits. |
| `transition` | `tenon transition <c> <event>`. |
| `complete` | `tenon transition <c> <event>`; when `governed_openspec` is true: `openspec archive <c> --skip-specs --yes --json`. |

### 3.7 Decisions, fields, exits

- A field with `allowed` values is a decision: interactive → ask with `recommended` first; continuous/afk → `recommended`.
- Outcome fields (`*_result`, `branch_status`) appear only after the step's required tests and reviewers pass; set the
  value the CLI lists. `pr_url`, `prd_path`, file paths: only real values; if unobtainable (no remote), stop and say so.
- Worktree/branch/commit are never created by the agent as a precondition; use `isolation=in-place` unless the host
  already provides one (`skills/tenon-build/SKILL.md:95-108`).
- `choose-exit`: take the `forward` exit when `ready`; a `back` exit only when its meaning applies (failed required
  test/reviewer → the exit back to the implementing step; changed approved meaning → the exit back to the spec step);
  interactive asks. An exit to a terminal step via `scope-expanded` means the goal outgrew the workflow: after it, create a
  new Change on `default` with the router track and run `tenon set <new> depends_on <old>`.

### 3.8 Upstream skill adaptation

- The Change already exists and is bound: skip `openspec new change`, never select or create another change.
- Write documents at the `path` given in `step.documents`; missing structure via `scaffold-document`.
- Record only through `record-document`; a skill's own "archive", "sync specs", "push" or "create PR" steps run only when
  `step.next` asks for them.
- Tasks: tick only the checkboxes under the current step heading; the `tasks` update appears in `step.documents.updates`.

### 3.9 Errors

| Situation | Skill does |
| --- | --- |
| `tenon` missing | stop: reinstall hint |
| skill cannot load | stop: `tenon setup --<host>` / `tenon update --<host>` |
| `lacks exact host confirmation` | reload the producer skill (anchored read), record again |
| `retired-skills` stop | tell the user to create a new task; the old one can be archived or deleted in the workbench |
| pending review, reply not approval | keep waiting; hooks print the unlock hint (`hooks/confirm-clear-prompt.sh:51`) |

## 4. CLI contract changes

### 4.1 `tenon status <change> --json` adds `step`

Today single-change JSON is `{ active_changes: [ {name, track, phase, phase_status, verify_result, updated_at} ] }`
(`packages/cli/src/commands/status.ts:38-48,68-70`). List form (`status --json` without a name) and `list --json` stay
byte-identical. Single-change form keeps `active_changes` first and adds `step`:

```json
{
  "active_changes": [{ "name": "add-login", "track": "frontend", "phase": "verify", "phase_status": "in_progress", "verify_result": "", "updated_at": "2026-09-20T10:00:00Z" }],
  "step": {
    "schema": "tenon-step-v1",
    "change": "add-login",
    "workflow": "default",
    "track": "frontend",
    "source": "frozen-snapshot",
    "id": "verify",
    "label": "验证",
    "prompt": null,
    "gate": "review",
    "mode": "interactive",
    "archived": false,
    "governed_openspec": true,
    "candidate": "build:v1:workspace:…",
    "skills": [
      { "id": "verification-before-completion", "depends_on": [], "wave": 0, "status": "done" }
    ],
    "executors": [],
    "reviewers": [
      { "agent": "frontend-quality", "required": true, "block_at": "high", "reads_tests": [], "wave": 0, "status": "pass", "run_id": "r-12", "blocking_findings": 0 },
      { "agent": "design-quality", "required": true, "block_at": "medium", "reads_tests": ["playwright"], "wave": 0, "status": "pending", "run_id": null, "blocking_findings": 0 }
    ],
    "tests": [
      { "id": "playwright", "direction": "playwright", "required": true, "status": "pass", "run_id": "t-7" }
    ],
    "documents": {
      "reads": [{ "kind": "delta-spec", "path": "openspec/changes/add-login/specs/auth/spec.md", "status": "read" }],
      "records": [{ "kind": "verification-report", "path": "docs/superpowers/reports/add-login-verify.md", "scope": "change", "producers": ["verification-before-completion"], "status": "missing" }],
      "updates": [{ "kind": "tasks", "path": "openspec/changes/add-login/tasks.md", "producers": ["tenon"], "status": "recorded" }]
    },
    "fields": [
      { "field": "verification_report", "kind": "output", "status": "missing", "value": null, "allowed": null, "recommended": null, "producers": ["verification-before-completion"] }
    ],
    "review": { "status": "none", "event": null },
    "exits": [
      { "event": "verify-pass", "to": "ship", "direction": "forward", "ready": false,
        "blockers": [{ "source": "reviewer", "code": "reviewer-pending", "message": "必需评审者 design-quality 尚未运行" }] },
      { "event": "verify-fail", "to": "build", "direction": "back", "ready": true, "blockers": [] }
    ],
    "next": [{ "action": "run-agent", "agent": "design-quality", "role": "reviewer", "wave": 0 }]
  }
}
```

Enumerations: `mode` interactive|continuous|afk; `skills[].status` done|ready|waiting; agent `status`
pending|running|pass|fail|stale|waiting; test `status` not-run|pass|fail|stale|unconfigured|missing-output; document
`reads[].status` read|unread|stale|missing; `records[]/updates[].status` recorded|missing|stale|unbound; field `status`
set|missing|invalid, `kind` output|guard|outcome; `review.status` none|pending|approved; exit `direction`
forward|back|completion; blocker `source` guard|document|skill|test|reviewer|revision|tasks|spec.

Derivation (reuse, not re-implement):

| Block | Source |
| --- | --- |
| plan, `source`, `completion_event` | `effectiveWorkflowForState` + `implicitCompletionTransition` (`packages/cli/src/commands/workflow-plan.ts:38-44,66-79`) |
| skills done/ready/waiting | `completedWorkflowSkillsSinceStepEntry` (`packages/kernel/src/workflow/skill-evidence.ts:40`), `isSkillUnlocked`, required slots `resolveRequiredSkillSlots` (`effective-skill-resolver.ts:96-113`) |
| documents | effective document policy: `readsRequiredForPolicyStep`, `outputsRequiredForPolicyStep`, mutable entries (`document-contract.ts:168-196`), ledger status via `evaluateDocumentEvidence`; paths from `templates/documents/registry.v1.yaml:7-16` |
| fields | step `outputs`/`artifacts` (YAML) + default exit guards (`flow/guard.ts:60-124`) + `STATIC_ENUMS` (`field-values.ts:16-29`) + new `RECOMMENDED` (§4.4) |
| exits, blockers | new `evaluateStepExitReport` extracted from `cmdCheck` (`check.ts:140-212`) and `checkVerifyFailReadiness` (`review.ts:79-118`), plus `missingStepSkills` (`transition-application.ts:295-315`), test guard (test-evidence), reviewer guard (review-agents) |
| review | canonical pending/approved receipt (`state/review-gate.ts`) |
| agents, tests | kernel read APIs from review-agents and test-evidence (§11 CCR-1, CCR-2) |
| mode | interaction authority for this change; `TENON_AFK=1` |

`next` ordering (first non-empty rule wins; items of the same rule and wave are listed together):

1. `stop`: archived (`code: archived`), retired skills (§4.3), step not in plan (`step-not-in-plan`).
2. `load-tenon`: no `Skill: tenon` / `CodexSkillRead: tenon` history row since the last transition into this step.
3. `read-documents`: any declared read `unread`/`stale`.
4. `run-agent` role executor: lowest wave with pending/fail/stale executors.
5. `load-skill`: lowest wave with `ready` skills.
6. Documents and fields: `apply-spec` if the step owns `applied-spec` and no passing apply receipt for the current delta
   digests; `scaffold-document`+`record-document` for records/updates `missing|stale|unbound`; `register-field`/`set-field` for
   `output` and `guard` fields `missing|invalid`; `validate-spec` if the step owns `delta-spec` and no passing dry-run
   receipt for the current delta digests.
7. `configure-test` / `run-test`: required tests not `pass`.
8. `run-agent` role reviewer: lowest wave with pending/stale reviewers (required and reference).
9. `set-field` for `outcome` fields `missing` (only now).
10. Exits: failed required test/reviewer and a `back` exit exists → `choose-exit`; gate `review`: pending →
    `await-review`, approved → `transition`/`complete`, forward exit ready → `request-review`; gate `auto`/`null`: forward
    ready → `transition` (or `complete` for `completion`); more than one forward exit ready → `choose-exit`; otherwise `fix`
    with the union of forward blockers.

`tenon workflow plan <change> --json` is unchanged (it already carries sibling `agents`/`tests` once parsed).

### 4.2 `tenon spec apply <change> [--dry-run] [--json]`

Registered under the existing `spec <sub>` family (`packages/cli/src/program.ts:216`, `commands/spec.ts`).

```ts
cmdSpecApply(deps: CliDeps, change: string, opts: { dryRun?: boolean; json?: boolean }): Promise<number>
```

1. Require a governed Change with at least one recorded `delta-spec`; resolve `openspec` on PATH.
2. Copy `openspec/` to a temp dir (preserve modes/symlinks); run `openspec validate <c> --strict --no-interactive`,
   `openspec archive <c> --yes --json`, `openspec validate --specs --strict --no-interactive` there.
3. Targets = main spec files that differ between repo and temp copy; digests before (repo) and after (temp).
4. Dry-run: no repo writes except the receipt file below.
5. Apply: CAS each target (repo bytes still equal `before`), write `after` bytes, write
   `openspec/changes/<c>/applied-spec.md` (headings from `registry.v1.yaml:16`, Change locale), idempotent (`no-op` when
   every target already equals `after`).
6. Always write `openspec/changes/<c>/.pipeline-spec-apply.json`
   `{ schema: "tenon-spec-apply-v1", mode, result, openspec_version, deltas: [{path, sha256}], targets: [{path, before_sha256, after_sha256, change}], at }`
   (the `next` rule reads it).

JSON stdout: `{ "change", "mode": "dry-run"|"apply", "result": "pass"|"fail", "openspec_version", "deltas": [...], "targets": [{ "path", "before_sha256": null|"…", "after_sha256", "change": "created"|"changed"|"no-op" }], "receipt_path": null|"…", "errors": ["…"] }`.

Exit: 0 pass; 1 usage/state (`delta-spec-unrecorded`, not governed); 2 validation or rehearsal failed (errors quote OpenSpec
output); 3 `openspec-cli-missing`; 4 `main-spec-changed` (CAS).

### 4.3 Retired skills

`packages/kernel/src/workflow/retired-skills.ts`:

```ts
export const RETIRED_SKILL_IDS: readonly string[] // tenon-open … tenon-archive, simple-task, learn-record, tenon-researcher
export function retiredSkillReferences(plan: EffectiveWorkflowPlan): readonly string[] // sorted unique, all branches of plan.definition ?? plan.workflow, tenon:-normalized
```

- `status` step: `next: [{ action: "stop", code: "retired-skills", message }]`.
- `tenon check`: exit 1 with the same message. `TransitionApplication`: new rejection
  `{ kind: 'retired-skills', workflowName, skills }` before planning; CLI exit 1, server `409 code: retired-skills`
  (`packages/server/src/transition.ts:195` pattern).
- `tenon init`: compiled plan with retired references → exit 1.
- Messages: `任务 '<c>' 的工作流快照引用已删除的技能（<ids>），无法继续；请新建任务，旧任务可在工作台归档或删除。` /
  `工作流 '<w>' 引用已删除的技能（<ids>）；在工作流页移除后重新保存。`

### 4.4 Recommended field values

`packages/cli/src/commands/field-values.ts` adds `RECOMMENDED: Partial<Record<FieldName, string>>`: `preset: full`,
`build_mode: direct`, `isolation: in-place`, `pre_verify_review_result: pass`, `branch_status: handled`;
`direct_override` recommended `true` only when `preset=full` and `build_mode=direct` (computed). Moves
`skills/tenon-build/SKILL.md:101-103` defaults out of prose.

### 4.5 Coverage blocker hint

`packages/kernel/src/flow/guard.ts:263` message becomes
`spec 出口：全栈 Spec 覆盖（N 层阻塞）；在 design_doc 的 ```coverage 块为每个阻塞层写 filled -> <章节> 或 waived -> <理由>（touches 含 auth 时 L6 不可 waived）`.
The per-layer warnings (`:264`) stay.

### 4.6 Doctor

- `checkWorkflowPhaseSkills` (`packages/cli/src/commands/doctor-skills.ts:131-153`) → `checkWorkflowSkills`, id
  `skills:workflow`: union of declared skill ids over every default track branch plus builtin `simple`; red when
  `skills/<id>/SKILL.md` is absent in the plugin payload or any id is retired.
- `CODEX_PROJECT_CONTRACT_SKILLS` (`:155-177`) → `['tenon', ...that union]`, no hard-coded list.
- New `integration:openspec-cli`: green with version, yellow when `openspec` is not on PATH (upstream OpenSpec skills and
  `tenon spec apply` call it; the package is only a devDependency here).

## 5. Default workflow data

Common to every branch: step ids/order, transitions, guards and field inputs/outputs stay as in
`templates/workflows/default.yaml:18-136` (validated by `validateDefaultWorkflowStructure`,
`document-contract-validation.ts:228-264`); `review_lanes` removed (review-agents); last step `label: 完结` (parent §1);
top-level `openspec: true` (informational for `default`, governance stays the name-selected `openspec-v1` matrix, D4).
Order in the tables = declaration order; `←x` = `depends_on: [x]`. Agents: `req`/`ref` = required true/false.

### 5.1 frontend

| Step | Gate | Skills | Executors | Reviewers | Tests | Project documents |
| --- | --- | --- | --- | --- | --- | --- |
| open 立项 | null | openspec-propose | | | | design-md `role: require` |
| explore 调研 | review | openspec-explore; brainstorming←openspec-explore; grill-with-docs←brainstorming | | | | |
| spec 规格 | review | openspec-propose; writing-plans←openspec-propose | | | | |
| build 实现 | null | test-driven-development; frontend-design←test-driven-development | | | unit req | read design-md |
| verify 验证 | review | verification-before-completion | | frontend-quality req high; spec-consistency req high; design-quality req medium reads [playwright]; code-size ref medium reads [code-size] | regression req; playwright req; code-size ref | read design-md |
| ship 交付 | null | finishing-a-development-branch | | | | design-md `role: update` producer tenon |
| archive 完结 | null | — | | | | |

Normative block form (other branches follow the same layout; block style is required by
`tools/generate-default-workflow.mjs` and `tools/check-default-skill-matrix.mjs:38-70` line scanners):

```yaml
  frontend:
    label: 前端
    document_contract:            # schema owned by workflow-io-openspec / design-resources (CCR-4)
      version: v1
      slots:
        - kind: design-md
          owner_step: open
          scope: project
          role: require
        - kind: design-md
          owner_step: ship
          producers: [tenon]
          scope: project
          role: update
      reads:
        - step: build
          kinds: [design-md]
        - step: verify
          kinds: [design-md]
    steps:
      - id: open
        label: 立项
        gate: null
        skills:
          - id: openspec-propose
        inputs: []
        outputs: []
        guards: []
        transitions:
          - event: open-complete
            to: explore
      - id: explore
        label: 调研
        gate: review
        skills:
          - id: openspec-explore
          - id: brainstorming
            depends_on: [openspec-explore]
          - id: grill-with-docs
            depends_on: [brainstorming]
        inputs: []
        outputs:
          - field: design_doc
            type: file_path
        artifacts:
          - field: design_doc
            type: file_path
            producer_policy: effective-phase-skills
        guards: []
        transitions:
          - event: explore-complete
            to: spec
      - id: spec
        label: 规格
        gate: review
        skills:
          - id: openspec-propose
          - id: writing-plans
            depends_on: [openspec-propose]
        inputs:
          - field: design_doc
            type: file_path
        outputs:
          - field: plan
            type: file_path
        artifacts:
          - field: plan
            type: file_path
            producer_policy: effective-phase-skills
        guards:
          - type: tasks-at-least
            n: 3
        transitions:
          - event: spec-complete
            to: build
            actions:
              - type: reset-pre-verify-review
      - id: build
        label: 实现
        gate: null
        skills:
          - id: test-driven-development
          - id: frontend-design
            depends_on: [test-driven-development]
        tests:
          - id: unit
            direction: unit
            required: true
        inputs:
          - field: design_doc
            type: file_path
          - field: plan
            type: file_path
        outputs:
          - field: build_sha
            type: string
        guards:
          - type: field-equals
            field: pre_verify_review_result
            value: pass
        transitions:
          - event: build-complete
            to: verify
          - event: requirements-changed
            to: spec
            actions:
              - type: reset-pre-verify-review
      - id: verify
        label: 验证
        gate: review
        skills:
          - id: verification-before-completion
        agents:
          reviewers:
            - agent: frontend-quality
              required: true
              block_at: high
            - agent: spec-consistency
              required: true
              block_at: high
            - agent: design-quality
              required: true
              block_at: medium
              reads_tests: [playwright]
            - agent: code-size
              required: false
              block_at: medium
              reads_tests: [code-size]
        tests:
          - id: regression
            direction: regression
            required: true
          - id: playwright
            direction: playwright
            required: true
          - id: code-size
            direction: code-size
            required: false
        inputs:
          - field: build_sha
            type: string
        outputs:
          - field: verification_report
            type: file_path
        artifacts:
          - field: verification_report
            type: file_path
            producer_policy: effective-phase-skills
        guards: []
        transitions:
          - event: verify-pass
            to: ship
          - event: verify-fail
            to: build
            actions:
              - type: mark-verification-failed
              - type: reset-pre-verify-review
      - id: ship
        label: 交付
        gate: null
        skills:
          - id: finishing-a-development-branch
        inputs:
          - field: verification_report
            type: file_path
        outputs:
          - field: pr_url
            type: string
        guards:
          - type: spec-migration-applied
        transitions:
          - event: ship-complete
            to: archive
      - id: archive
        label: 完结
        gate: null
        skills: []
        inputs:
          - field: pr_url
            type: string
        outputs:
          - field: archived
            type: boolean
        guards: []
        transitions: []
```

Tests omit `command` (resolved per project, CCR-2).

### 5.2 backend

| Step | Skills | Reviewers | Tests |
| --- | --- | --- | --- |
| open | openspec-propose | | |
| explore | openspec-explore; brainstorming←openspec-explore; grill-with-docs←brainstorming; improve-codebase-architecture←grill-with-docs | | |
| spec | openspec-propose; writing-plans←openspec-propose | | |
| build | test-driven-development | | unit req |
| verify | verification-before-completion | backend-quality req high; spec-consistency req high; security ref high; code-size ref medium reads [code-size] | regression req; integration req; code-size ref |
| ship | finishing-a-development-branch | | |
| archive 完结 | — | | |

No project documents. `writing-plans` leaves build (D24).

### 5.3 pm

| Step | Skills | Executors | Reviewers | Project documents | Prompt |
| --- | --- | --- | --- | --- | --- |
| open | openspec-propose | | | | |
| explore | brainstorming; grill-with-docs←brainstorming | researcher | | | |
| spec | brainstorming; grill-with-docs←brainstorming; openspec-propose←grill-with-docs; writing-plans←openspec-propose | | | | |
| build | hue; huashu-design←hue; frontend-design←huashu-design; design-taste-frontend←huashu-design | | | design-md `role: produce` producer hue | `原型为交付级高保真，覆盖关键屏与空、加载、错误、成功态；用户选定一个方案后只精修该方案。` |
| verify | browser-qa; verification-before-completion←browser-qa | | design-quality req medium | read design-md | |
| ship | to-spec; to-tickets←to-spec | | | | |
| archive 完结 | — | | | | |

No tests (prototype track). `prd_path` stays a kernel ship guard (`flow/guard.ts:109-110`), surfaced as a field.

### 5.4 free and chat

`chat` stays because `POST /api/changes` defaults to track `chat` (`packages/server/src/serverPostChangesRoutes.ts:163`);
its steps equal `free`.

| Step | Skills | Reviewers | Tests |
| --- | --- | --- | --- |
| open | openspec-propose | | |
| explore | brainstorming | | |
| spec | openspec-propose; writing-plans←openspec-propose | | |
| build | test-driven-development | | unit ref |
| verify | verification-before-completion | spec-consistency req high | regression ref |
| ship | finishing-a-development-branch | | |
| archive 完结 | — | | |

### 5.5 Builtin `simple` (`builtin-workflows.ts:9-66`, mirrored in `templates/workflows/simple.yaml`)

```yaml
steps:
  - id: change
    label: Change
    gate: null
    prompt: |-
      只改用户点名的局部目标：错字、文案、注释、单文件的值、无用 import。涉及接口或契约、schema 或迁移、鉴权、权限、依赖、发布、生产数据、跨模块或新功能时，不修改，走 scope-expanded。改完运行最窄的检查。
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: change-complete
        to: verify
      - event: scope-expanded
        to: escalated
        actions:
          - type: archive-run
  - id: verify
    label: Verify
    gate: null
    skills:
      - id: verification-before-completion
    # inputs/outputs/guards/transitions unchanged (simple.yaml:29-45); review_lanes/kind review removed with review-agents
  - id: done      # unchanged
  - id: escalated # unchanged
```

### 5.6 `templates/manifest.yaml`

- `mandatory_skills` (`:84-105`) regenerated to equal §5.1–5.4 per step×track (drift gate
  `tools/check-default-skill-matrix.mjs:1-12`); `open._all: [openspec-propose]`.
- `recommended_skills` (`:109-114`) deleted.
- `breadcrumb` (`:119-148`) keeps its 7 keys (router cache and `manifest-derive.test.ts:190-197` consume them); each becomes
  one line `<label>：按 tenon status <change> --json 的 step.next 执行。`
- `review_skills` (`:63-65`) left to review-agents.

## 6. Removals

| Path | Note |
| --- | --- |
| `skills/tenon-open`, `tenon-explore`, `tenon-spec`, `tenon-build`, `tenon-verify`, `tenon-ship`, `tenon-archive`, `simple-task`, `learn-record` (incl. `scripts/sync-to-wiki.sh`), `tenon-researcher` | 2,384 lines |
| `agents/tenon-builder.md`, `tenon-design-reviewer.md`, `tenon-researcher.md`, `tenon-reviewer.md` | bodies → §7 builtin agents; Claude plugin no longer auto-registers `tenon:tenon-reviewer` (used in E2E D1, `research/e2e-default-workflow-and-codex.md:22`) |
| `tools/generate-skill-interaction-contract.mjs`, `.node-test.mjs`, `templates/skill-interaction-contract.md`; scripts `generate:interaction-contract`, `check:interaction-contract` (`package.json:16-18`) | contract inlined in the skill |
| `tools/check-docs.mjs` `checkWorkflowSkillContract` (`:144-208`, call `:619`) + its tests (`check-docs.node-test.mjs:339-350`) | pins `tenon-<phase>` |
| `tools/verify-skills.sh:342-360` | `tenon-ship` content checks |
| `skills/tenon/SKILL.md` phase dispatch table (`:313-321`) | rewritten file |
| `document-contract.ts` producers `tenon-explore/spec/build/verify/ship/archive`, alias `opsx:apply ↔ openspec-apply-change` (`:40,51,55,62,80-101,316-317`); `document-contract-validation.ts` groups `pipeline *`, `tenon spec`, `OpenSpec apply` (`:38-61,71-72`) | producer `tenon` |
| `templates/skill-sources.yaml:8-17` rows | regenerated by upstream-skills' registry |

## 7. Builtin agents migrated from `agents/`

Written to the plugin builtin agent source dir (CCR-5; proposed `templates/agents/builtin/`), frontmatter per review-agents:

| New id | Source | Kept | Dropped |
| --- | --- | --- | --- |
| `builder` (executor) | `agents/tenon-builder.md` | one task, TDD, return files/diff summary/test result/open questions, no commit | `.pipeline.yaml` rule, `build-complete` barrier text |
| `researcher` (executor) | `agents/tenon-researcher.md` + `skills/tenon-researcher/SKILL.md:11-14` | real sources, verbatim evidence, facts/assumptions/recommendations, return path + ≤10 lines + open questions | "pipeline explore" and brainstorming coupling |
| `design-quality` (reviewer) | `agents/tenon-design-reviewer.md` verify mode | read-only, severity findings, screenshots outside repo, fingerprint unchanged | build fix loop, `REVIEW.md` |
| — | `agents/tenon-reviewer.md` | handed to review-agents presets `spec-consistency`, `frontend-quality`, `backend-quality` | three-lane text |

## 8. Compatibility

Decision: none beyond refusal (§4.3). Evidence: every E2E Change on 1.1.x reached archive or was left in sandboxes
(`research/e2e-default-workflow-and-codex.md:239-245`); tenon-local's in-progress Changes were deleted (`2290233c`, parent
prd `:50`); version-reset restarts at 0.1.0. A frozen snapshot references `tenon-<phase>` skills whose files will be gone
and a document policy whose producers changed (`recordRequirementForPolicy` freezes them, `document-contract.ts:207-226`), so
continuing would fail later with unrelated errors. Custom workflows that never referenced retired ids (C1
`feature-flow`, `research/e2e-custom-workflow.md:14-22`) keep working.

## 9. Validation and tests

### 9.1 Error matrix

| Condition | Behavior |
| --- | --- |
| Snapshot references retired skill | status `stop retired-skills`; check exit 1; transition rejected `retired-skills` (CLI 1, HTTP 409) |
| Workflow references retired skill at init | `tenon init` exit 1, no Change created |
| Archived Change | `step.archived=true`, `next: stop archived` |
| Step id not in plan | `next: stop step-not-in-plan` |
| Record by `tenon` without `tenon` loaded this visit | existing `lacks exact host confirmation` (`document-producer-invocation.ts:40-43`); `next` puts `load-tenon` first |
| Declared skill missing in payload | doctor red `skills:workflow`; host load fails → skill stops with setup hint |
| `openspec` not on PATH | `spec apply` exit 3; doctor yellow `integration:openspec-cli` |
| Strict validate / rehearsal fails | `spec apply` exit 2, errors listed, no main spec writes; `validate-spec` stays next |
| Main spec changed between read and write | `spec apply` exit 4, no writes |
| No recorded delta-spec | `spec apply` exit 1 `delta-spec-unrecorded` |
| Required test has no command | test `unconfigured`, `next: configure-test` |
| Required test fail / stale / missing output | exit blocker `test`; `run-test` or `choose-exit` |
| Required reviewer blocking findings | exit blocker `reviewer`; `choose-exit` when a back exit exists, else `fix` |
| Field value outside `allowed` | `tenon set` exit 1 (`field-values.ts:32-37`) |
| `pr_url` unobtainable | skill stops; never fabricated |
| Coverage layers blank | guard failure with §4.5 hint |
| Several forward exits ready | `choose-exit` |
| `status --json` without name / `list --json` | unchanged bytes |

### 9.2 Tests required

| File | Assertions |
| --- | --- |
| `packages/kernel/src/workflow/retired-skills.test.ts` (new) | finds ids in every branch and frozen snapshot; `tenon:tenon-build` normalized; unrelated ids → `[]` |
| `packages/kernel/src/state/document-ledger.test.ts` | build tasks refresh accepts `tenon`, rejects `tenon-build`; spec ADR refresh by `tenon`; build refresh of `proposal` rejected; `applied-spec` accepts only `tenon`, rejects `openspec-apply-change` |
| `packages/kernel/src/workflow/validate.test.ts`, `document-contract` tests | `openspec_contract: required` no longer requires `tenon-*`; shipped `default.yaml` validates |
| `packages/kernel/src/flow/guard.test.ts` | coverage failure contains `filled -> ` and `waived -> ` |
| `packages/kernel/src/flow/manifest-derive.test.ts` | breadcrumbs one line each; `recommendedSkills` empty; mandatory table equals default data |
| `packages/kernel/src/workflow/generate-default-workflow.test.ts`, `track-branch.test.ts`, `loadWorkflow.test.ts` | no `tenon-` ids; archive label `完结`; chat equals free |
| builtin simple tests (`workflow/*simple*`, `openspec/specs/simple-task-routing` scenarios) | `change` skills `[]` + prompt; `change-complete` succeeds without skill evidence; `verify-pass` still requires `verification-before-completion` |
| `packages/cli/src/commands/status-step.test.ts` (new, pure builder) | each §4.1 `next` rule in order: load-tenon at entry, reads, executors before skills, wave order, apply-spec before applied-spec record, validate-spec after delta record, only required tests, reviewers after tests, outcome fields last, request/await/transition by review state, completion → `complete`, back-exit `choose-exit`, stop archived/retired; `mode` continuous/afk; `recommended` for `direct_override` computed |
| `packages/cli/src/commands/status.test.ts` | list and no-name anchors byte-identical; single-change key order `active_changes`, `step` |
| `packages/cli/src/commands/check.test.ts` | output lines unchanged after extracting `evaluateStepExitReport` |
| `packages/cli/src/spec-apply.integration.test.ts` (new, real OpenSpec from devDependency) | dry-run leaves `openspec/specs` bytes unchanged and writes receipt json; apply writes target + `applied-spec.md`; second apply `no-op`; requirement without SHALL/MUST → exit 2; CAS conflict → 4; PATH without openspec → 3 |
| `packages/cli/src/document-record.integration.test.ts` | `Skill: tenon` receipt this visit → `tasks` record by `tenon` passes; receipt from previous visit → fails |
| `packages/cli/src/internal-skill-gate-hook.integration.test.ts` | frontend explore: undeclared skill blocked until `openspec-explore` done; `tenon` always allowed |
| `packages/cli/src/commands/transition.test.ts`, `packages/server/src/server.test.ts` | retired snapshot → `retired-skills`, state unchanged |
| `packages/cli/src/commands/init.test.ts` | workflow with retired id refused |
| `packages/cli/src/commands/doctor.test.ts` | `skills:workflow` lists missing declared ids; codex contract derived; `integration:openspec-cli` green/yellow |
| `packages/cli/src/workflow-skill-orchestration.integration.test.ts` | no `tenon-ship` read (`:376`); frontend build requires TDD evidence before `frontend-design` |
| `tools/test-hooks.sh`, `tools/test-adapters.sh` | Codex read fixtures use `skills/tenon/SKILL.md`; skill tracker samples use `tenon` |
| `tools/test-bundle.sh` | open evidence via `tenon` (`:150-156`); reviewer brief checks point at builtin agents (`:65-68`); Build/Verify prose checks (`:47-60`) removed |
| `npm run oracle` | 0 mismatches with `tenon` producer (`tools/oracle/run.sh:569-571`) |
| dashboard/server/automation fixtures (`SkillFlow.test.tsx`, `SkillComposer.test.tsx`, `StageEditorPane.test.tsx`, `stageIo.test.tsx`, `WorkflowNav.test.tsx`, `skillRuns.test.ts`, `skillsRegistry.test.ts`, `serverOrchestrationV2.integration.test.ts`, `runtimeWorkflowEditor.integration.test.ts`, `automation/src/skills/content-locator.test.ts`, `types.test.ts`, `lifecycle/spec-complete.test.ts`) | ids swapped; assertions keep meaning |

### 9.3 Gates

`npm run build`, `npm run check:architecture`, `check:comments`, `check:identity`, `check:docs`, `check:openspec`,
`check:default-skill-matrix`, `check:default-workflow-freshness`, `npm test`, `npm run test:web`, `bash tools/test-hooks.sh`,
`bash tools/test-adapters.sh`, `bash tools/test-bundle.sh`, `bash tools/verify-skills.sh`, `npm run oracle`.

### 9.4 Real-host acceptance

Details in `implement.md` §E2E. Ten runs to 完结: Claude Code and Codex × {default frontend, backend, pm, free, a
Dashboard-built workflow}, plus a YAML-edit run (AC3) and in-run negative checks for the preserved gates (AC4).

## 10. Decisions made during design

- D1 The per-step input is `tenon status <change> --json` → `step` (parent §6 names this command); no new command; list forms unchanged.
- D2 The CLI computes a closed `next` action list; the skill interprets it. Ordering lives in one tested function, not prose.
- D3 The runner reloads `tenon` at every StepVisit entry, which gives the producer `tenon` the same per-visit host
  confirmation phase skills had (`skill-tracker.sh:105-110` → `internal-native-skill-receipt`; Codex reconciles the
  producer at record time, `commands/document.ts:229-240`). No kernel change to confirmation scope.
- D4 `default` keeps the name-selected `openspec-v1` matrix (`document-contract.ts:141-143`); only producer ids change.
  Converting default to a declarative contract is not needed for R6 and would widen the kernel change.
- D5 OpenSpec application becomes CLI `tenon spec apply`: dry-run at the step that owns `delta-spec`, apply at the step that
  owns `applied-spec`. It replaces the Verify isolated rehearsal prose and the Tenon-custom `openspec-apply-change`.
  Moving the dry-run from Verify to Spec keeps the v1.1.5 early catch of SHALL/MUST
  (`research/e2e-default-workflow-and-codex.md:171,183-186`).
- D6 Upstream OpenSpec `openspec-apply-change` means "implement tasks" and `openspec-archive-change` means "archive"
  (`node_modules/@fission-ai/openspec/dist/core/templates/workflows/apply-change.js`, `archive-change.js`, v1.6.0); neither is
  declared in default. `openspec-sync-specs` is not used because apply is deterministic in CLI.
- D7 Executors run before a step's skills (research feeds brainstorming); reviewers run after required tests.
- D8 Kernel hand-filled fields stay; the skill handles them through `fields` (`allowed`, `recommended`, outcome ordering).
- D9 Recommended values live in `field-values.ts` next to the enums.
- D10 No compatibility for pre-migration Changes; refusal with `retired-skills`.
- D11 `chat` branch kept, equal to `free`.
- D12 No `docs` track: `BUILTIN_TRACK_IDS` has none (`packages/kernel/src/tracks/builtins.ts:18`); the Dashboard-built E2E workflow covers extra tracks.
- D13 Default last step label `完结`.
- D14 `mandatory_skills` kept in sync, `recommended_skills` deleted, breadcrumbs one line; the Track matrix itself stays.
- D15 Interaction contract generator removed; rules inlined (§3.3).
- D16 Dropped without replacement: learn-record, archive soft reminder, preset upgrade rules, journey rubric, plan B1–B3,
  triage, `codex exec` lane, handoff bundle in the loop, `/clear` discipline.
- D17 `simple` change step: no skill, `prompt` carries the boundary; escalation link rule in the skill.
- D18 PM prototype engine is `huashu-design` (the documented default, `skills/tenon-build/SKILL.md:145-147`); PM
  `build_mode` recommendation is the generic `direct`.
- D19 Builtin agents from `agents/`: `builder`, `researcher`, `design-quality`; `tenon-reviewer` folds into review-agents presets.
- D20 The docs gate pinning `tenon-<phase>` is deleted, not rewritten.
- D21 Main OpenSpec specs that name removed skills are edited in place (`workflow-skill-enforcement/spec.md:13-75`,
  `simple-task-routing/spec.md:48-95`, `plugin-distribution/spec.md:505-516`,
  `open-source-documentation-experience/spec.md:671`); `check:openspec` validates.
- D22 Doctor skill lists derive from workflow data.
- D23 Coverage guidance moves into the guard message.
- D24 `writing-plans` leaves build for backend/free: upstream writing-plans authors a new plan, wrong at build; build reads
  the recorded plan through document reads.

## 11. Contract change requests (parent not edited)

- CCR-1 (§6, review-agents): fix the run CLI and read API the runner consumes:
  `tenon agent start <change> <agent> --role executor|reviewer --json` →
  `{ run_id, agent, agent_digest, role, prompt_path, skills, tools, reads_tests, candidate }`;
  `tenon agent finish <change> <run_id> --result pass|fail --report <path> [--findings <json-file>] --json`;
  kernel `agentRunStatuses(changeDir, step, candidate)` → per agent `{ status, run_id, blocking_findings }`. Order: executors
  before skills, reviewers after required tests.
- CCR-2 (§4, test-evidence): a workflow test may omit `command`; the command resolves from the project's direction
  configuration; unresolved → status `unconfigured` and `tenon test run` refuses with a `hint`. Kernel
  `testRunStatuses(repoRoot, user, change, step, candidate)` → per test `{ status, run_id }`. Builtin directions must
  include `code-size` (review-agents decision) besides unit, integration, regression, benchmark, playwright, e2e.
- CCR-3 (§4, workflow-io-openspec): `tenon` is an implicit producer allowed without being declared in `skills`, for
  (a) `openspec-v1` living refresh and `applied-spec`, (b) `document_contract` project slots `role: update`, and (c) a new
  optional `document_contract.updates: [{ step, kinds, producers? }]` so custom workflows can re-record living documents
  (today `document-v1` has no mutable entries, `document-contract.ts:163`, and ticking `tasks` would stale later reads).
- CCR-4 (§4, workflow-io-openspec + design-resources): for `default`, a track `document_contract` may only add
  `scope: project` slots and reads; one kind may have several project slots with different roles; `role: require` has no
  producers (current rule `document-contract-validation.ts:172-181` would reject both).
- CCR-5 (§3, review-agents): plugin source dir for builtin agents (proposed `templates/agents/builtin/`) and the builtin id
  set = review-agents presets (architecture, frontend-quality, backend-quality, code-size, security, spec-consistency, e2e) +
  `builder`, `researcher`, `design-quality`; `agents/` leaves the payload.
- CCR-6 (§3, upstream-skills): `skills/sources.yaml` must contain every id default data references: openspec-propose,
  openspec-explore, brainstorming, grill-with-docs, improve-codebase-architecture, writing-plans, test-driven-development,
  frontend-design, verification-before-completion, browser-qa, finishing-a-development-branch, hue, huashu-design,
  design-taste-frontend, to-spec, to-tickets.
