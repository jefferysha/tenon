# Default workflow and review gates

## Goal

Operate the governed seven-phase heavy Tracks of the default Workflow (`pm`,
`frontend`, `backend`), including return edges and exact review receipts. The
`lite` Track has its own four steps and is described under
[the lightweight Track](routing-and-workflows.md#the-lightweight-track).

## Prerequisites

- an active Change using `workflow=default` on a heavy Track
- the single `tenon` skill dispatched by the Tenon entrypoint
- the phase's handed-over inputs read and its required outputs written

## Workflow graph

```text
open → explore → spec ⇄ build ⇄ verify → ship → archive
          review   review         review
```

Transitions:

| From | Event | To | Meaning |
| --- | --- | --- | --- |
| open | `open-complete` | explore | framing is recorded |
| explore | `explore-complete` | spec | explored design is approved |
| spec | `spec-complete` | build | specification/plan is approved |
| build | `build-complete` | verify | implementation baseline is frozen |
| build | `requirements-changed` | spec | approved meaning changed |
| verify | `verify-pass` | ship | exact baseline passed review |
| verify | `verify-fail` | build | implementation needs correction |
| ship | `ship-complete` | archive | delivery evidence is applied |

Explore, Spec, and Verify are review-gated.

Tenon ships exactly one skill of its own, `tenon`. It reads the Change's frozen
workflow plan and executes the current step from `tenon status <change> --json`
→ `step.next`. Which skills a step loads is declared per Track in
`templates/workflows/default.yaml` and nowhere else.

Skills declared per step (default, by Track):

| Step | pm | frontend | backend |
| --- | --- | --- | --- |
| `open` | openspec-propose | openspec-propose | openspec-propose |
| `explore` | brainstorming · grilling · domain-modeling | openspec-explore · brainstorming · grilling · domain-modeling | openspec-explore · brainstorming · grilling · domain-modeling · codebase-design |
| `spec` | openspec-propose · brainstorming · writing-plans · grilling · domain-modeling | openspec-propose · writing-plans | openspec-propose · writing-plans |
| `build` | prototype · frontend-design | test-driven-development · frontend-design | test-driven-development |
| `verify` | browser-qa · web-design-guidelines · design-taste-frontend · verification-before-completion | verification-before-completion · e2e-testing · browser-qa · web-design-guidelines · design-taste-frontend | verification-before-completion |
| `ship` | — | finishing-a-development-branch | finishing-a-development-branch |
| `archive` | — | — | — |

The graph, the guards and the actions of every transition are written in the
Workflow YAML and executed from it; no rule lives in code under the Workflow's
name. Leaving a step is governed by its leave conditions:

| Leave condition | Where | Satisfied when |
| --- | --- | --- |
| `tasks-through-step` | step and forward edges | every `tasks.md` item up to and including this step is checked |
| `not-afk-queued` | the `build-complete` edge | the Change is not waiting in the AFK queue |
| `dependencies-ended` | the `build-complete` edge | every Change in `depends_on` has ended |

Besides these, the YAML carries the step-specific conditions: `pre_verify_review_result=pass`
on `build-complete`, the required outputs below, at least three tasks at Spec, an unchanged
build revision on `verify-pass`, and the delivery value (`pr_url`, `prd_path` on pm) with the
spec migration at Ship. `tenon check <change>` without an
event lists the step's guards together with the guards of its forward edges and reports every
unmet condition at once, exiting `2`. `tenon advance` follows only the single forward edge; it
never takes a return edge (`requirements-changed`, `verify-fail`) or the abandon edge
(`scope-expanded`). The former build-mode, isolation, direct-override and branch-status
decisions are gone from new Changes (Changes created before the upgrade keep theirs). The
Dashboard workflow page lists a step's leave conditions read-only under its gate, a
required output as “Required output `<path>`”.

The default workflow declares no input or output documents for a step. What each step
wrote is recorded when the step is left, and the next step must read the Markdown
documents of its direct upstream step ([documents, Skills, and evidence](documents-skills-and-evidence.md)).
The only document conditions in `templates/workflows/default.yaml` are these
`required-output` guards (`{change}` is the task name):

| Step | Required output | Tracks |
| --- | --- | --- |
| `open` | `openspec/changes/{change}/proposal.md` | pm, frontend, backend |
| `explore` | `docs/superpowers/specs/*.md` | pm, frontend, backend |
| `spec` | `openspec/changes/{change}/specs/*/spec.md` | pm, frontend, backend |
| `spec` | `docs/superpowers/plans/*.md` | frontend, backend |
| `verify` (on `verify-pass`) | `docs/superpowers/reports/{change}-verify.md` | pm, frontend, backend |

The `lite` Track declares none. A file that already existed before the Change does not
satisfy a required output unless the step changed it. The frontend Track no longer
requires a ready `DESIGN.md` before Open; its validity is checked by the `design-system`
test at Ship.

`pre_verify_review_result=pass` is Build's verdict; `tenon set` checks the step's
declared readiness evidence before writing it. Every heavy Track's Build declares
evidence that can be checked: frontend and backend require the `unit` suites of
the project's test catalog to pass (Build's `test_policy`), and pm requires the
`spec-consistency` reviewer (`block_at: medium`, a language-agnostic comparison
of the implementation against the proposal, design, delta spec and tasks).
Writing `pass` without that evidence is refused and names what is missing.

Every heavy Track also declares [agents](agents.md): Explore runs the `researcher`
executor; Build runs the `builder` executor (one subagent per independent task,
merged into one report) before its reviewers; Verify declares the `code-size`
test (`tenon test code-size --json`, passing while `lines_added` stays within
2000) and the required `code-size` reviewer that reads its result. If the lines added really
exceed the limit and the user decides to waive it, register
`tenon test waive <change> --test code-size --reason …`; the review that confirms this gate
approves it with the rest, and nothing is let through before that. A step cannot
be left until its executors finish `done`.

Reviewers are scoped by risk. `security` declares `attach_on: [auth, dependency,
contract]` ([Agents](agents.md)), so on the Tracks where Verify requires it, it is attached only
when the task's changes touch an authentication, dependency-manifest or interface-contract
path; a task that touches none never waits for it or dispatches it. The same task can be
done on the lighter [`lite` Track](routing-and-workflows.md#the-lightweight-track) first and
escalated to a heavy Track when its changes outgrow it.

When a required step test's command is an npm script that the project does not
define, the test is *unconfigured*, not failed: `tenon test run` refuses it
without writing a record and explains how to configure it, and `step.next` raises
it as a `fix` (`test-unconfigured`) at the entry of its own step or the step
before it (configuring is a workspace change and must land before Build freezes
the candidate). The default workflow's only required step tests are `code-size`
(Verify of pm, frontend and backend), the `diff-risk` probe (the lightweight Build) and
the design-system check (frontend's Ship); the project's own tests come from the
catalog, so an ordinary project is never asked to add `typecheck` or
`test:integration` scripts just to satisfy the workflow.

A step can also declare a `test_policy`, the workflow's side of the test system
(the project's `.tenon/tests/catalog.yaml` says how tests run, the change's
`test-plan.yaml` says which suites and test files this change touches, the policy
says what each step must see). `kinds` must be registered in the plan (a suite of
that kind or an approved waiver), `run` must have passed on the current code,
`run_if_registered` only when the plan registered that kind, `scope` is the
minimum run scope (`changed` accepts any, `full` only a full run), `files:
registered` blocks while a test file added or modified in the change is missing
from the plan, `scenarios` (`required` / `passing`) maps every OpenSpec scenario
to a test case, and `coverage`, `flaky` and `browsers` add thresholds. A step
without `test_policy` behaves exactly as before, a started change keeps the plan
it froze, and a step's own `tests` keep working next to its policy.

`integrity: notice | block` (default `notice`) says what the test-integrity report does at that
step. The report compares the change with its start and flags case-count drops and rising skips
across full runs, deleted or skipped tests, removed assertions, rewritten snapshots, changed
baselines, added known failures and lowered coverage thresholds (the ten signals are listed in
the [CLI reference](cli-reference.md), the command is
`tenon test integrity <change>`). No Track of the default workflow declares it, so
every Build and Verify step runs at `notice`: the signals show up as one `test-integrity` notice in `status`,
`test status` and the Dashboard Tests tab and never block. Set `integrity: block` on a step to
turn them into a blocker for that step (an unreadable diff then blocks too, with
`files-diff-unavailable`); there is no per-signal waiver, so a deliberate deletion means
restoring the test or editing the policy. `integrity: notice` is the same as omitting the key and
does not change the workflow's fingerprint. The Dashboard workflow page edits it next to
`scenarios`.

Zero-waiver defaults: **only `unit` is mandatory** (registered at Spec, run at
Build with scope `changed` and at Verify with scope `full`). Everything else runs
only when the project has it: `typecheck`, `integration`, `regression`, `e2e`,
`playwright`, `a11y`, `visual`, `benchmark`, `smoke` are `run_if_registered`, and
the seed (`tenon test plan <change> --seed`, `tenon test register <change> --auto`)
registers every catalog suite of those kinds except benchmarks. A coverage
threshold (frontend / backend Verify, lines 80%) applies only to a suite whose
catalog entry declares `coverage`; a catalog without coverage is never blocked by
it, and the Playwright browser list is whatever the suite's own `browsers`
declares. `regression` needs no suite of its own: a policy that requires
`regression` with `scope: full` is satisfied by the `unit` suite run in full.
Defaults by Track (all editable on the Dashboard workflow page):

| Track | spec registers | build runs (changed) | verify runs (full) |
| --- | --- | --- | --- |
| lite | `unit` (planned at Build; there is no Spec step) | `unit`; `typecheck` when registered | `unit`; `regression`, `typecheck`, `integration`, `e2e`, `playwright`, `a11y`, `visual` when registered |
| frontend | `unit` | `unit`; `typecheck` when registered | `unit`; `regression`, `e2e`, `playwright`, `a11y`, `visual` when registered; lines coverage 80% when the suite declares coverage |
| backend | `unit` | `unit`; `typecheck` when registered | `unit`; `integration`, `regression`, `benchmark` when registered; lines coverage 80% when the suite declares coverage |
| pm | every OpenSpec scenario mapped | none | `smoke` when registered |

A kind that does not apply to the whole project (a plain-JavaScript project has
no type check) is declared once in the catalog instead of waived per change:
`tenon test catalog not-applicable typecheck --reason '<why>'` writes a
`not_applicable` entry to `.tenon/tests/catalog.yaml`. It takes effect only after
a human confirmation: `tenon review request` lists it next to the plan's waivers
(`not-applicable:<kind>`), the user's confirmation (`tenon review acknowledge`,
not `--delegated`) approves it, and `approved_by` records who. Until then the
policy still requires the kind and reports `waiver-unapproved`. A per-change
`tenon test waive` remains for the one-off case.

`tenon init` runs `tenon test discover --write` itself when the project has no
catalog yet (for workflows that declare a `test_policy`) and says so on stderr;
review the generated `.tenon/tests/catalog.yaml` and commit it. Discover claims
unit test files under `src/`, `test/`, `tests/`, `__tests__/` and the project root
(`*.test.*`, `*.spec.*`). `tenon test register <change> --auto` does the rest in
one command: it discovers a missing catalog, widens a suite's `files` globs to
claim test files nobody owns, seeds the plan and registers those files.

Blockers carry a stable code (`test-catalog-missing`, `test-plan-missing`,
`test-kind-missing`, `test-file-unregistered`, `test-not-run`, `test-failed`,
`test-stale`, `no-tests-ran`, `coverage-below`, `scenario-uncovered`, …), a short
label, the full reason and the command that fixes it.

`tenon status`'s `step.next` walks the test system in order: `test-discover` (no
catalog) → `test-plan-seed` → `test-plan-map` (missing kinds, unmapped scenarios) →
`test-register-files` (unregistered test files) → `run-tests`
(`tenon test run <change> --stage`) → `test-report` (writes the traceability matrix
into the verification report). They come after the step's documents and before its reviewers;
a run that finished but misses the policy becomes a `fix` — or, on a review gate, the
rollback edge (taken directly with `tenon transition` while rounds remain). Waivers and catalog `not_applicable` entries need a human: `tenon review
request` lists the pending ones, and the user's confirmation (`tenon review acknowledge`,
not `--delegated`) approves exactly those. The plan, baselines, known failures and run records are
written only through `tenon test …`; the write gate refuses direct edits and shell
redirects into them, while `tenon` commands and plain git operations pass. A reviewer
that declares `reads_tests` also gets the latest failing cases, flaky cases, coverage
against the thresholds and benchmark deltas in its prompt.

Verify is limited in how many rounds it runs; see
[Verification round limit](#verification-round-limit). Build TDD, unit tests, type checks,
lint, and narrow integration tests remain Build feedback and never count as a round.

Ship applies the verified delta spec with `tenon spec apply <change>`, which
rehearses `openspec validate`/`archive` in a temporary copy of `openspec/`,
writes only the changed main spec bytes back under a compare-and-swap, and
records `applied-spec.md`.

Ship also has a machine-enforced migration guard. When the Change contains
`migration/spec-application.json`, the managed apply tool must produce a result bound to the
Change, input receipt, delta, target path, and final digest. Both `tenon check` and
`tenon transition ... ship-complete` revalidate that evidence and fail closed on drift.

## Verification round limit

Verify gets at most two rounds. The Verify step of every track declares `max_rounds: 2` in `templates/workflows/default.yaml`. A round is one entry into the step: the first entry is round 1, and every `verify-fail` back to Build followed by `build-complete` enters Verify again.

While rounds remain, the back edge is cheap: when a required test or a required reviewer fails, `step.next` gives `transition verify-fail` directly, and `tenon transition <change> verify-fail` succeeds without a review request or a user confirmation (the agent tells the user in one sentence why it goes back). Forward edges, residual blockers and test waivers still need a human confirmation.

When round 2 still ends with a required test or a required reviewer failing, Tenon stops going back by itself. `step.next` no longer offers the `verify-fail` edge: it either stops with `rounds-exhausted` or asks the user to accept the remaining blockers, and `tenon transition <change> verify-fail` is refused. The decision then belongs to the user:

- accept the remaining reviewer blockers with the usual human confirmation (a failing required test needs a step-test waiver instead);
- raise the limit with `tenon set <change> max_rounds <N>` and go back to Build;
- go back to Spec through `requirements-changed`. Build declares that edge and Verify does not, so from Verify it takes two steps and the first needs the user's decision too: raise the limit with `tenon set <change> max_rounds <N>`, go back to Build through `verify-fail`, then run `tenon transition <change> requirements-changed` on Build. Once the task is in Spec the count starts again from round 1 and the user can lower `max_rounds` again;
- end the task.

The agent never raises the limit on its own and never works around it. The commands, `step.rounds` and the acceptance of remaining blockers are in the [CLI reference](cli-reference.md#verification-round-limit).

The limit is the `max_rounds` key of a workflow step, written beside `gate`:

```yaml
- id: verify
  gate: review
  max_rounds: 2
```

The key is valid only on a step that has `gate: review` and at least one return edge, an edge back to an earlier step such as `verify-fail`. Declared anywhere else (Build has no review gate, so it is never limited and its `requirements-changed` is always available), it makes the workflow fail to parse, and the error names the step and the reason. The value is an integer from 1 to 20; `0`, `21`, `two` and `1.5` are rejected the same way. A limited step that does not declare the key, such as a step of a custom workflow or of a task frozen before the key existed, is limited to 2. The limit is frozen with the workflow plan, so editing the workflow file later does not change a task in flight; `tenon set <change> max_rounds <N>` overrides it for one task. The Dashboard workflow page keeps the key when it reads and writes a definition but has no control to edit it.

## Phase operation

### 1. Inspect current truth

```bash
tenon status <change-name> --json
tenon document status <change-name>
```

### 2. Run the step`s declared skills

The coding agent reads the packaged `tenon` skill and the documents handed over by
the previous step (`read-documents`, then `tenon document read <change-name> all`),
and performs the work with the Skills the step declares. Tenon records the files the
step wrote, and the Skill that wrote each, when the step is left. Do not replace real
Skill execution with a claim in prose.

### 3. Check the exit

```bash
tenon check <change-name>
```

Exit `0` means current guard checks pass. Exit `2` means the report contains
unmet guards or leave conditions, all of them listed at once. Check does not transition.

### 4. Handle a review exit

This is the path for forward edges. On a step limited by verification rounds (a review gate with a
back edge), taking the back edge while rounds remain needs no review receipt: run
`tenon transition` directly (see [step 5](#5-use-return-edges-honestly)).

Bind the request to the exact event:

```bash
tenon review request <change-name> --event <event>
```

Wait for the user to confirm. The confirmation comes only from the user: a reply
with an approval phrase ("确认继续", "继续执行"), which the hook turns into the
receipt; a confirmation in the Dashboard (`tenon dashboard --open`); or, on a
host without a UserPromptSubmit hook, the user running
`tenon review acknowledge <change-name>` in their own terminal. The agent must
not run that manual form; the host gate refuses it. Once the receipt exists:

```bash
tenon transition <change-name> <event>
```

Use `--delegated` only when the user has already granted continuous authority
for this exact Change:

```bash
tenon review acknowledge <change-name> --delegated
```

Delegation records the confirmation fact. It does not remove evidence, guards,
or authority boundaries, and it does not approve pending test waivers.

### 5. Use return edges honestly

If approved requirements/design meaning changes during Build:

```bash
tenon transition <change-name> requirements-changed
```

Revise and review in Spec. Do not overwrite an old digest in Build.

If verification fails and a round is still left:

```bash
tenon transition <change-name> verify-fail
```

On a step limited by verification rounds (a review gate with a back edge), taking the back edge
while rounds remain needs no review receipt: `step.next` hands you `transition` directly, and no
user confirmation is needed. Forward edges, residual blockers and test waivers still need a human
confirmation.

Fix in Build, freeze a new baseline, and verify again. A receipt is bound to one exact phase and
event: a `verify-pass` receipt cannot approve another forward event, and it is cleared by any
successful transition. Verify is limited to two rounds; once they are used up this edge is refused
(see [Verification round limit](#verification-round-limit)).

If a `verify-pass` review is waiting for confirmation and the user asks to go back and change
something, run `tenon transition <change-name> verify-fail` the same way. The transition clears the
stale review marker, so the gate stops blocking writes.

### 6. Finish the task

After `archive` completes, `step.next` returns `finish-change` with the command
`tenon task finish <change-name>`. Tenon moves the task into `openspec/changes/archive/`
(through `openspec archive <change-name> --skip-specs --yes --json` on an OpenSpec Track) and records the
result Finished; the commit of the archive follows as `step.next` says. To give up
earlier, `tenon task terminate <change-name>` archives it as Terminated and commits only the
task directory.

## Expected result

Every transition has the correct Workflow edge, guard evidence, the step's recorded
outputs, read receipts for its handed-over inputs, and exact review receipt where
required.

## Verification

```bash
tenon status <change-name> --json
tenon document status <change-name> --json
tenon check <change-name>
```

At Build completion, `build_sha` contains a canonical `build:v1` token bound to
the revision, physical repository, and physical worktree. Old bare Git SHAs or
workspace baselines are rejected and must be recaptured in Build; the runtime
never backfills them. A missing, malformed, stale, or unproven token blocks
Verify with `verify-build-revision-untrusted` and remediation
`return-to-build-and-capture-current-revision`. The same closed blocker is
used by readiness, HTTP/SSE projections, and AFK settlement.

## Common failures

### Review acknowledged but transition still fails

Confirm the request was bound to the same event and current phase visit.

### Build wants to alter proposal/design meaning

Use `requirements-changed`; do not conceal drift by rewriting approved
documents from Build.

### Verify changed implementation files

Verify must inspect the frozen baseline. A correction belongs on the
`verify-fail → build` return path.

### The `verify-fail` edge is refused with the rounds used up

`step.next` says `rounds-exhausted` or asks for the remaining blockers to be accepted. Do not
look for another event and do not raise the limit yourself: show the user the failing tests,
the remaining reviewer blockers and the ways out from the
[Verification round limit](#verification-round-limit), and wait for the decision.

### Verify reports an untrusted build revision

Return to Build and run `build-complete` to capture a fresh `build:v1` token.
Do not set or backfill `build_sha` by hand; the transition record is part of
the provenance proof.

## Next action

Read [documents, Skills, and evidence](documents-skills-and-evidence.md) or
[Dashboard status semantics](dashboard-and-local-api.md).
