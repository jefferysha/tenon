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
evidence that can be checked: frontend and backend require the unit-class suites of
the project's test catalog to pass (Build's `test: changed` level), and pm requires the
`spec-consistency` reviewer (`block_at: medium`, a language-agnostic comparison
of the implementation against the proposal, design, delta spec and tasks).
Writing `pass` without that evidence is refused and names what is missing.

Every heavy Track also declares [agents](agents.md): Explore runs the `researcher`
executor; Build runs the `builder` executor (one subagent per independent task,
merged into one report) before its reviewers; Verify declares the `code-size`
test (`tenon test code-size --json`) and the required `code-size` reviewer that reads its
result. The test has **no ceiling by default**: it records `files_changed`, `lines_added`,
`lines_deleted` and `largest_added_lines`, exits `0`, and never blocks the exit or needs a waiver;
the reviewer judges from the measured values whether the size is reasonable for the kind of change.
A project that wants a ceiling writes `pass.metrics` under that test in its own workflow, for
example `pass: { metrics: [{ name: lines_added, max: 3000 }] }`; a run over the ceiling then fails
with `metric-threshold`. Only then, if the user decides to let it through, register
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

A step declares what it needs from the test system with one key, `test:`, which takes a
level: `none` (no requirement, the same as omitting the key), `plan` (the change has a test
plan and the project catalog has a suite of every required class), `changed` (run the suites
the change touches, on the changed scope) or `full` (run the required classes in full, plus any
other class the change touches). The project's `.tenon/tests/catalog.yaml` says how tests run
and what each level means, the change's `test-plan.yaml` records only the choices you make by
hand (extra suites, mapped cases, waivers), and the workflow only names the level. A suite is
*touched* when a file the change modified matches the suite's `files` or `covers` glob; a suite
without `covers` is touched only by its own test files, and a change that edits only source files
gets the non-blocking notice `suites-without-covers` (see the [CLI reference](cli-reference.md)).
The older multi-field `test_policy` key is the legacy spelling, still readable for changes that
froze it (a step cannot declare both). A step's own `tests` keep working next to its level.

What the levels mean is defined in the catalog, not in the workflow. An optional top-level
`levels` key in `.tenon/tests/catalog.yaml` overrides the built-in defaults for `plan`,
`changed` and `full`; each level takes only these keys: `required` (test classes the catalog must
have a suite for), `touched` (classes that run only when the change touches them), `scenarios`
(`off | required | passing`), `coverage` (`lines`, `branches`, `functions`, `statements`,
`changed_lines`, each 0–100), `flaky` (`{ max, fail_on_new }`) and `require_baseline`. The `plan`
level accepts only `required` and `scenarios`. A key you leave out keeps its built-in default:

```yaml
levels:
  plan:    { required: [unit] }
  changed: { required: [unit], touched: [static] }
  full:    { required: [unit], touched: [integration, e2e, static, benchmark] }
```

The built-in defaults set `scenarios: off`, no coverage or flaky threshold and
`require_baseline: false`, so an ordinary task is not asked for more than its changes need. A
project that wants more writes it back: `levels.full.coverage: { lines: 80 }` makes every `test:
full` step check line coverage for suites that declare a coverage report. An unknown level, key or
class, or a coverage value outside 0–100, makes the catalog invalid (`tenon test catalog validate`
shows the line) and every test exit blocks until it is fixed. The levels count in the catalog
digest, and the catalog stays protected test configuration: changing it in a task needs the
review confirmation.

Test classes group the suite kinds into five (plus `custom`, which runs only when asked for by
name): `unit` (`unit`, `coverage`), `integration` (`integration`, `regression`, `contract`,
`smoke`), `e2e` (`e2e`, `playwright`, `browser`, `a11y`, `visual`), `static` (`typecheck`, `lint`,
`code-size`, `design-system`) and `benchmark`. A suite's `kind` may be a class name or any older
kind name, which stays valid as an alias; levels match by class, while a frozen legacy policy
still matches the kind names literally, so its requirements do not widen.

Changed test files are claimed, not registered (a frozen legacy `files: registered` is judged the
same way, so it no longer asks for one-by-one registration). A test file the change added or modified that a
suite's `files` glob matches belongs to that suite, which then runs at the levels that run it. Claiming
is computed when the step is evaluated and is not written to `test-plan.yaml`, so adding test files
never makes earlier runs stale. After the suite ran, a claimed file must show at least one executed
case, otherwise the exit blocks with `registered-test-not-executed`. A file that looks like a test
but no suite claims is an orphan (`test-file-orphan`) and blocks until
`tenon test register <change> --auto` appends its exact path to a suitable suite. Paths under `openspec/`, `.tenon/` and
`.pipeline/` are never test changes, and the test-file name rules apply only to source extensions
(js, ts, py, go, rs, java and similar), so `fixtures/data.spec.json` or an archived `.spec.report` is not
a test.

The test-integrity report compares the change with its start and flags case-count drops and rising skips
across full runs, deleted or skipped tests, removed assertions, rewritten snapshots, changed
baselines, added known failures and lowered coverage thresholds (the ten signals are listed in
the [CLI reference](cli-reference.md), the command is
`tenon test integrity <change>`). Levels have no integrity setting, so every Build and Verify step of the
default workflow runs it at `notice`: the signals show up as one `test-integrity` notice in `status`,
`test status` and the Dashboard Tests tab and never block. Only a frozen legacy policy that set
`integrity: block` still turns them into a blocker for its step (an unreadable diff then blocks too, with
`files-diff-unavailable`); there is no per-signal waiver, so a deliberate deletion means
restoring the test.

Defaults by Track (the level is chosen per step on the Dashboard workflow page; the meaning of each
level comes from the catalog):

| Track | spec | build | verify |
| --- | --- | --- | --- |
| lite | (no Spec step) | `changed` | `full` |
| pm | `none` (scenarios are not required to be mapped) | none | `changed` |
| frontend | `plan` | `changed` | `full` |
| backend | `plan` | `changed` | `full` |

With the built-in level definitions this means: unit-class suites are the only mandatory class; a
`changed` step runs just the suites the change touches (static checks such as `typecheck` only when
touched), a `full` step runs every unit-class suite in full and the integration, e2e, static and
benchmark suites the change touches. A change that touches no suite at `changed` runs nothing, and
`tenon test run <change> --stage` says so and exits `0`. The default workflow no longer writes a
coverage threshold: a project that wants one adds `levels.full.coverage` to its catalog, and it
applies only to a suite whose catalog entry declares `coverage`.

OpenSpec scenario mapping is off unless a level asks for it (`scenarios: required | passing`). With
it off, no scenario blocks an exit, `step.next` does not issue `test-plan-map` for it, and the
traceability matrix in the verification report lists only the rows that are mapped plus one line,
"N more scenarios / tasks are not mapped (this step does not require mapping)".

A test class that does not apply to the whole project (a plain-JavaScript project has
no type check) is declared once in the catalog instead of waived per change:
`tenon test catalog not-applicable typecheck --reason '<why>'` writes a
`not_applicable` entry to `.tenon/tests/catalog.yaml`, which also satisfies the class that kind
belongs to. It takes effect only after
a human confirmation: `tenon review request` lists it next to the plan's waivers
(`not-applicable:<kind>`), the user's confirmation (`tenon review acknowledge`,
not `--delegated`) approves it, and `approved_by` records who. Until then the
level still requires the class and reports `waiver-unapproved`. A per-change
`tenon test waive` remains for the one-off case.

`tenon init` runs `tenon test discover --write` itself when the project has no
catalog yet and says so on stderr; review the generated `.tenon/tests/catalog.yaml` and commit it.
Discover claims
unit test files under `src/`, `test/`, `tests/`, `__tests__/` and the project root
(`*.test.*`, `*.spec.*`). `tenon test register <change> --auto` is the one command for the rest: it
discovers a missing catalog, then appends the exact path of each orphan test file this change
touched to the suite that fits. It never widens a glob and never touches files the change did not
change. Every command that edits the catalog (`catalog add|set|rm|not-applicable`, `register --auto`)
rewrites only the lines that changed and keeps comments, blank lines and layout; the one thing lost is
an inline comment on a key you changed. A catalog created from scratch is written whole.

Blockers carry a stable code (`test-catalog-missing`, `test-plan-missing`,
`test-kind-missing`, `test-file-orphan`, `test-not-run`, `test-failed`,
`test-stale`, `no-tests-ran`, `coverage-below`, `scenario-uncovered`, …), a short
label, the full reason and the command that fixes it. (`test-file-unregistered` is no longer issued;
it stays in the vocabulary so older reports still display.)

`tenon status`'s `step.next` walks the test system in order: `test-discover` (no
catalog) → `test-plan-seed` → `test-plan-map` (only for a missing required class, or when the
level requires scenario mapping) →
`test-register-files` (only when orphan test files exist: one `tenon test register <change> --auto`
claims them all) → `run-tests`
(`tenon test run <change> --stage`) → `test-report` (writes the traceability matrix
into the verification report). They come after the step's documents and before its reviewers;
a run that finished but misses the policy becomes a `fix` — or, on a review gate, the
rollback edge. Waivers and catalog `not_applicable` entries need a human: `tenon review
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

## Task start point

"Changed since the task started" has one answer in Tenon: the registration and
sync of test files, the changed-files list, the approval of protected test
configuration, the test-integrity report, the `diff-risk` probe, reviewers
scoped by `attach_on`, changed-line coverage, evidence export, the transition
gates (CLI and HTTP), the Dashboard snapshot and `tenon verify --ci` all compare
against the same start commit. Tenon records it when the task is created and
lets it follow upstream.

- `tenon init` writes the `HEAD` of the checkout as the task field `start_sha`
  (Dashboard task creation and AFK triage do the same). It is left out when the
  repository has no commit or is not a Git repository. The value is kept in a
  small record next to the task state (`.pipeline-run/start-sha/`), not in
  `.pipeline.yaml`, so the release before this field existed still reads and
  continues the task.
- The start is the newest of these candidates:
  1. `start_sha`, when it is an ancestor of `HEAD` and its committer time is not
     later than the task's `created_at` plus 60 seconds (the real value is the
     `HEAD` at creation, so it cannot be later; a value that fails the check,
     whose time cannot be read, or when `created_at` is unusable, is dropped);
  2. the merge-base of `HEAD` and the upstream of `base_branch`
     (`<base_branch>@{upstream}`), when that upstream resolves;
  3. the merge-base of `HEAD` and `base_branch`, when it is not `HEAD` itself
     (a task branch or worktree branch with commits of its own: the fork point).

  Candidates are compared two at a time: if one is an ancestor of the other the
  descendant wins; if they do not form a chain the merge-base of the two wins.
  The list may therefore show too much but never too little. With no candidate
  at all the earlier rule still applies: the last commit before `created_at`.
- No commit message and no author is ever read. The start can only move to the
  `HEAD` Tenon recorded or to a commit reachable from a local upstream
  reference, so rewording a commit hides nothing.
- `start_sha`, `base_branch` and `created_at` decide the start, so only
  `tenon init` writes them. `tenon set`, `set-many` and `cas` refuse them (exit
  `1`, nothing changes); `base_branch` and `created_at` used to be writable.
  The small record under `.pipeline-run/start-sha/` is not covered by the state
  digest, which is why the time check above exists: if that record is rewritten to
  a later commit or deleted, the start only moves earlier and the list shows more
  files, never fewer.
- What you see: commits that others merged into the base branch and that you
  then fetched or pulled stop counting as this task's changes, instead of
  appearing as inherited test files and a changed catalog.
- Limits. The upstream is a local reference, so without a `git fetch` it can be
  stale; that only counts more files. An in-place task that commits on the base
  branch and pushes to its upstream moves its start past those commits, and they
  stop counting as its changes. A worktree task is not affected: its
  `base_branch` is the branch it came from, and its commits are not in that
  branch's upstream until they are merged.
- Compatibility. A task without `start_sha` and without an upstream behaves as
  before. A runtime released before this field existed reads a task that has one
  without trouble. If that older runtime then writes to the task (for example
  after a rollback), the newer runtime reads an empty `start_sha` afterwards and
  the start falls back to the upstream and base-branch candidates, exactly as for
  a task created before the field existed (see [CONTRACT](../CONTRACT.md)).

New tasks are created in their own worktree, which is also what keeps two tasks
in one repository from sharing a start; see
[Where the task lives](quickstart.md#where-the-task-lives-the-task-worktree).

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

If verification fails:

```bash
tenon review request <change-name> --event verify-fail
# after the user confirms, in one of the three ways above:
tenon transition <change-name> verify-fail
```

Fix in Build, freeze a new baseline, and verify again. A `verify-pass` receipt
cannot approve `verify-fail`, or vice versa. Verify is limited to two rounds; once they
are used up this edge is refused (see [Verification round limit](#verification-round-limit)).

A return edge does not ask for the skills of the step's agents. Those skills (for
example `test-driven-development`, which belongs to `builder`) can only be
loaded while the agent runs, so requiring them would force you to start a
builder just to go back: `requirements-changed` from Build works before any
builder has run in that visit. Skills the main thread loads are still required on
a return edge, and forward edges require all of them. `tenon status`,
`tenon check` and the Dashboard transition agree on this; see
[Agents](agents.md#use-agents-in-a-workflow).

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

What the token binds depends on the task's `isolation`. `branch` binds a Git
object. `worktree` and `in-place` bind a content fingerprint of the workspace
(without `.git`, dependencies, OpenSpec and document evidence, pipeline control
files and test caches), because the implementation in a task worktree is
usually not committed when Build ends and Build never requires a commit. The
identity stays bound to the physical repository and the physical worktree, so
verifying a worktree task from another checkout gives `worktree-mismatch`. A
token of the wrong kind for the task's `isolation` (for example a Git-object
token on a `worktree` task, left by an older task whose `isolation` was set to
`worktree` by hand) gives `isolation-mismatch`. Both mean: return to Build and
capture again. The CLI, the Dashboard transition and the Dashboard snapshot take
the kind from the same function (`expectedBuildRevisionKind`), so they cannot
disagree. See [CONTRACT](../CONTRACT.md).

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
the provenance proof. For a task in a worktree, run the verification from that
worktree: another checkout gives `worktree-mismatch`.

### Files from other people's merges show up as this task's changes

The start is the newest of `tenon get <change> start_sha` and
`git merge-base HEAD <base_branch>@{upstream}` (see the candidates above), and
`tenon test sync <change>` lists the files that start leaves in. Run `git fetch`
so the upstream reference is current. Do not try to edit `start_sha`,
`base_branch` or `created_at`: they are read-only after `tenon init`. See
[Task start point](#task-start-point).

## Next action

Read [documents, Skills, and evidence](documents-skills-and-evidence.md) or
[Dashboard status semantics](dashboard-and-local-api.md).
