# Default workflow and review gates

## Goal

Operate the governed seven-phase default Workflow, including return edges and
exact review receipts.

## Prerequisites

- an active Change using `workflow=default`
- the single `tenon` skill dispatched by the Tenon entrypoint
- current document evidence for the phase

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
→ `step.next`. Which skills a step loads is declared per track in
`templates/workflows/default.yaml`; the manifest `mandatory_skills` table is a
routing projection of that same data and only overlays automatically when the
Track matrix is enabled.

Skills declared per step (default, by track):

| Step | pm | frontend | backend | free |
| --- | --- | --- | --- | --- |
| `open` | openspec-propose | openspec-propose | openspec-propose | openspec-propose |
| `explore` | brainstorming · grilling · domain-modeling | openspec-explore · brainstorming · grilling · domain-modeling | openspec-explore · brainstorming · grilling · domain-modeling · codebase-design | brainstorming |
| `spec` | openspec-propose · brainstorming · writing-plans · grilling · domain-modeling | openspec-propose · writing-plans | openspec-propose · writing-plans | openspec-propose · writing-plans |
| `build` | prototype · frontend-design | test-driven-development · frontend-design | test-driven-development | test-driven-development |
| `verify` | browser-qa · web-design-guidelines · design-taste-frontend · verification-before-completion | verification-before-completion · e2e-testing · browser-qa · web-design-guidelines · design-taste-frontend | verification-before-completion | verification-before-completion |
| `ship` | — | finishing-a-development-branch | finishing-a-development-branch | finishing-a-development-branch |
| `archive` | — | — | — | — |

`pre_verify_review_result=pass` is Build's verdict; `tenon set` checks the step's
declared readiness evidence before writing it. Every track's Build declares
evidence that can be checked: frontend, backend, chat and free require the
`unit` suites of the project's test catalog to pass (Build's `test_policy`), and
pm / free / chat also require the `spec-consistency` reviewer (`block_at:
medium`, a language-agnostic comparison of the implementation against the
proposal, design, delta spec and tasks). Writing `pass` without that evidence is
refused and names what is missing.

Every track also declares [agents](agents.md): Explore runs the `researcher`
executor; Build runs the `builder` executor (one subagent per independent task,
merged into one report) before its reviewers; Verify declares the `code-size`
test (`tenon test code-size --json`, passing while `lines_added` stays within
2000) and the required `code-size` reviewer that reads its result. On chat and
free, Verify also runs `security` as an advisory reviewer whose findings never
block. A step cannot be left until its executors finish `done`.

Reviewers are scoped by risk. `security` declares `attach_on: [auth, dependency,
contract]` ([Agents](agents.md)), so on the tracks where Verify requires it, it is attached only
when the task's changes touch an authentication, dependency-manifest or interface-contract
path; a task that touches none never waits for it or dispatches it. The same task can be
done on the lighter [`standard` lane](routing-and-workflows.md#the-standard-lane) first and
escalated to this workflow when its changes outgrow that lane.

When a required step test's command is an npm script that the project does not
define, the test is *unconfigured*, not failed: `tenon test run` refuses it
without writing a record and explains how to configure it, and `step.next` raises
it as a `fix` (`test-unconfigured`) at the entry of its own step or the step
before it (configuring is a workspace change and must land before Build freezes
the candidate). The default workflow's only required step tests are `code-size`
(every track's Verify) and the design-system check (pm's Ship); the project's own
tests come from the catalog, so an ordinary project is never asked to add
`typecheck` or `test:integration` scripts just to satisfy the workflow.

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
`tenon test integrity <change>`). The default workflow and the standard lane declare nothing, so
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
Defaults by track (all editable on the Dashboard workflow page):

| Track | spec registers | build runs (changed) | verify runs (full) |
| --- | --- | --- | --- |
| chat / free | `unit` | `unit`; `typecheck` when registered | `unit`; `regression` when registered |
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
rollback edge. Waivers and catalog `not_applicable` entries need a human: `tenon review
request` lists the pending ones, and the user's confirmation (`tenon review acknowledge`,
not `--delegated`) approves exactly those. The plan, baselines, known failures and run records are
written only through `tenon test …`; the write gate refuses direct edits and shell
redirects into them, while `tenon` commands and plain git operations pass. A reviewer
that declares `reads_tests` also gets the latest failing cases, flaky cases, coverage
against the thresholds and benchmark deltas in its prompt.

The `chat` track — the default when the Dashboard picks no track — declares no skills. Its document
contract still governs the outputs, but a default resolution without a track needs no upstream skill
bytes, so it also holds on a clean checkout.

The Verify phase also opens exactly one automated Review attempt for the frozen
`build_sha`. Its standards, spec, and E2E lanes share the same attempt ID and
finite Workflow budget. E2E is a Review lane, not an independent Review count.
No Review Skill, reviewer agent, or E2E runner may start before that attempt is
active. Build TDD, unit tests, type checks, lint, and narrow integration tests
remain Build feedback and do not consume the Review budget.

Ship applies the verified delta spec with `tenon spec apply <change>`, which
rehearses `openspec validate`/`archive` in a temporary copy of `openspec/`,
writes only the changed main spec bytes back under a compare-and-swap, and
records `applied-spec.md`.

Ship also has a machine-enforced migration guard. When the Change contains
`migration/spec-application.json`, the managed apply tool must produce a result bound to the
Change, input receipt, delta, target path, and final digest. Both `tenon check` and
`tenon transition ... ship-complete` revalidate that evidence and fail closed on drift.

## Phase operation

### 1. Inspect current truth

```bash
tenon status <change-name> --json
tenon document status <change-name>
```

### 2. Run the step`s declared skills

The coding agent reads the packaged `tenon` skill and the current Change
documents, performs the work, and records its current-visit evidence. Do not
replace real Skill execution with a claim in prose.

### 3. Check the exit

```bash
tenon check <change-name>
```

Exit `0` means current guard checks pass. Exit `2` means the report contains
unmet guards. Check does not transition.

### 4. Handle a review exit

Bind the request to the exact event:

```bash
tenon review request <change-name> --event <event>
```

After the user reviews and confirms:

```bash
tenon review acknowledge <change-name>
tenon transition <change-name> <event>
```

Use `--delegated` only when the user has already granted continuous authority
for this exact Change:

```bash
tenon review acknowledge <change-name> --delegated
```

Delegation records the confirmation fact. It does not remove evidence, guards,
or authority boundaries.

### 5. Use return edges honestly

If approved requirements/design meaning changes during Build:

```bash
tenon transition <change-name> requirements-changed
```

Revise and review in Spec. Do not overwrite an old digest in Build.

If verification fails:

```bash
tenon review request <change-name> --event verify-fail
tenon review acknowledge <change-name>
tenon transition <change-name> verify-fail
```

Fix in Build, freeze a new baseline, and verify again. A `verify-pass` receipt
cannot approve `verify-fail`, or vice versa.

## Expected result

Every transition has the correct Workflow edge, guard evidence, current
documents/reads, and exact review receipt where required.

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

Use `requirements-changed`; do not conceal drift by re-recording approval
documents from Build.

### Verify changed implementation files

Verify must inspect the frozen baseline. A correction belongs on the
`verify-fail → build` return path.

### Verify reports an untrusted build revision

Return to Build and run `build-complete` to capture a fresh `build:v1` token.
Do not set or backfill `build_sha` by hand; the transition record is part of
the provenance proof.

## Next action

Read [documents, Skills, and evidence](documents-skills-and-evidence.md) or
[Dashboard status semantics](dashboard-and-local-api.md).
