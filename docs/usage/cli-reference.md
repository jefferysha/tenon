# CLI reference

## Goal

Provide a navigable command-family map while keeping `tenon <command>
--help` as the exact flag authority.

## Prerequisites

- installed `tenon` launcher
- current project directory for project/change commands

## Installation and runtime

Canonical first-host examples:

```bash
tenon setup --codex
tenon update --codex
tenon host-target-plan --json
tenon host-target-plan --host codex --operation setup --json
tenon runtime status
tenon runtime repair --rollback
tenon dashboard --open
```

```text
tenon setup --<one-host> [--target <dir>] [--auto-update] [--dry-run] [-y]
tenon update --<one-host> [--target <dir>] [--dry-run] [-y] [--auto]
tenon host-target-plan [--host <registered-host> --operation <setup|update>] --json
tenon runtime status [--json]
tenon runtime repair --rollback [--json]
tenon dashboard [--port <port>] [--background] [--open] [--dry-run]
tenon doctor [--json]
tenon uninstall [--dry-run] [-y]
```

`tenon dashboard --open` signs you in: the running (or freshly started) server opens your
browser itself with a one-time login link that is never returned to the command, so the
page loads already signed in. A bare `tenon dashboard` runs the server in the foreground and
prints that link to an interactive terminal; a launcher that reads the server's stdout can ask
for it with `TENON_DASHBOARD_PRINT_LINK=1`. See
[Signing in](dashboard-and-local-api.md#signing-in).

`host-target-plan` is a machine-readable, read-only contract. With only
`--json` it returns the registered host catalog; with both `--host` and
`--operation` it returns one `host-target-plan/v1` preview. It never runs
setup or update, and it rejects custom host IDs. Native-host previews target
their user-scoped installation. Adapter-host previews use `--target .`; enter
the intended project directory before copying or running that command.

Host flags:

```text
--codex --claude --cursor --gemini --copilot --pi
--devin --zed --aider --continue --cline --amp
```

## Changes and state

### Interaction observability

```text
tenon interaction scorecard <fixture-dir> --json
```

This read-only command replays the tracked v1 JSON fixtures and emits deterministic
tenon-interaction-scorecard/v1 JSON. It reports the three fixed metrics, completeness,
accepted stale decisions, same-state repeats, invalid resumes, diagnostic counts, and
unclassified extension codes. A Change projection, when present, is the regular
non-symlink file .pipeline-interactions.jsonl; projection failures warn after canonical
success and never change canonical state. Prompt, token, credential, and artifact fields
are rejected by the closed codec.

```text
tenon init <name> --track <track> --preset <preset> [--workflow <name>]
tenon list [--json]
tenon status [name] [--json]
tenon workflow plan <name> [--json]
tenon get <name> <field>
tenon set <name> <field> <value>
tenon set-many <name> <key=value...>
tenon cas <name> <field> <expect> <next>
tenon transition <name> <event>
tenon check <name>
tenon advance <name>
tenon handoff <name> [--phase <phase>] [--json]
tenon handoff <name> --bundle --target <phase> \
  [--budget-bytes <bytes>] [--json]
tenon session activate <name> [--continuous] [--host-session <id>]
tenon session route-context <name> [--json]
tenon state status|repair-projection|import-legacy <name> [--json]
```

`get` returns an empty line with exit `0` for a missing/unknown field. CAS
mismatch exits `3`; failed guard check exits `2`; invalid transitions exit `1`.
Use command help and machine-readable output before scripting additional
assumptions.

`tenon workflow plan <name> --json` is the Agent-facing orchestration source
for an in-flight Change. It returns the immutable plan captured when the
WorkflowRun started, including steps, Skills, gates, guards, artifacts, and
transitions. Editing or deleting `.pipeline/workflows/<workflow>.yaml` affects
new runs only; it does not rewrite the Todo or Skill DAG of an existing run.

`handoff --bundle` compiles a deterministic `context-bundle/v1` from the
authoritative document ledger for the target phase. Each input carries its
document kind, path, recorded SHA-256, materialization mode, and policy reason;
the bundle itself carries an aggregate SHA-256. Missing files, digest drift,
duplicate slots, or an exceeded UTF-8 byte budget fail closed. The bundle is a
derived handoff artifact, not a replacement canonical document; repair stale
inputs with `tenon document record` under an allowed producer and then
re-run the handoff.

## Identity and ownership

```text
tenon user [--json]
tenon user set <email> [--name <name>]
tenon owner take <change>
tenon owner set <change> <email> [--name <name>]
```

Identity is self-declared, not authenticated. `tenon user` resolves it from
`TENON_USER`, then the machine-local `user.json`, then `git config user.email`,
and prints `Name <email> source`; with no identity it exits `1` (`--json` still
prints `{"user":null}`). `tenon user set` writes `user.json`; `TENON_USER`, when
set, still wins and a warning says so.

`tenon owner take` makes the current user the Change owner; `tenon owner set`
hands the Change to another user and is allowed only for the current owner.
Both print the new owner as `Name <email>`, append an `assignee` history entry,
and exit `1` for an invalid name or email, a missing identity or Change, or a
non-owner hand-over.

## Tests

```text
tenon test discover [--write] [--json]
tenon test catalog show [<id>] [--json]
tenon test catalog validate [--json]
tenon test catalog add [<id>] [--from <direction>] [--kind <k> --command <cmd> …] [--service --start <cmd> …]
tenon test catalog set <id> [<same options>] [--service]
tenon test catalog rm <id> [--service]
tenon test catalog not-applicable <kind> --reason <text> | --rm
tenon test plan <change> [--seed] [--json]
tenon test register <change> --auto
tenon test register <change> --suite <id> [--scope full|changed|files|grep] [--pattern <regex>] [--select-file <path>]…
tenon test register <change> --file <path>… [--suite <id>] [--kind <kind>]
tenon test register <change> --case <covers> --test "<file › name>"…
tenon test unregister <change> --suite <id> | --file <path> | --case <covers> [--test <ref>] | --waiver <kind|covers>
tenon test waive <change> (--kind <k> | --covers <covers>) --reason <text>
tenon test sync <change> [--json]
tenon test trust [<change>] [--yes] [--status] [--json]
tenon test run <change> [--suite <id>]… [--kind <k>]… [--stage [<step>]] [--all] [--changed] [--json]
tenon test run <change> <test-id> [--json]
tenon test status <change> [--step <id>] [--json]
tenon test baseline <change> --suite <id> --run <run-id>
tenon test baseline <change> <test-id> --run <run-id>
tenon test known add --suite <id> --test "<file › name>" --reason <text> --expires <YYYY-MM-DD> [--link <url>]
tenon test known rm --suite <id> --test "<file › name>"
tenon test known list [--json]
tenon test report <change> [--step <id>] [--write <path>] [--locale zh-CN|en]
tenon test code-size [--base <ref>]
```

Tests are registered on three levels. The project **catalog**
(`.tenon/tests/catalog.yaml`, tracked, human-editable) says which suites exist and how
to run them: `kind`, `runner`, `command`, `cwd`, the report format and path, optional
coverage, artifact paths, `select` templates (`{files}` / `{pattern}`), `services`,
`retries`, `parallel`, and a `benchmark` block for benchmark suites. Report, coverage
and artifact paths must sit under `test-results/`, `playwright-report/` or `coverage/`
(a declaration can never hide source). The workspace fingerprint that binds a run record to
the code ignores exactly the paths the catalog declares (report, coverage and `artifacts`,
resolved against the suite `cwd`) and the `outputs` of the inline tests in the frozen
workflow of open changes: an undeclared `coverage/` or `test-results/` directory, at any
depth, is part of the candidate. The per-change **plan**
(`openspec/changes/<change>/test-plan.yaml`) lists the suites this change uses, the test
files it added or changed, the scenario/task → case mapping (`spec:<capability>/<Scenario
title>` or `task:<number>`) and waivers. Only the `tenon test` commands write it: every
write records a digest in a change-local ledger, so a hand-edited plan becomes
`test-plan-tampered`. The workflow **policy** (`steps[].test_policy`) says what a step
needs: kinds to register, kinds to run, minimum scope, coverage thresholds, flaky limit,
benchmark baseline requirement, browsers, scenario coverage and `files: registered`.
Steps that still declare inline `tests[]` keep working: they run as before and are
judged together with the policy. The default workflow is zero-waiver: only `unit`
is mandatory and every other kind is `run_if_registered` (see the
[default workflow](default-workflow.md)).

A kind that does not apply to the whole project is declared in the catalog instead of waived
per change: `test catalog not-applicable <kind> --reason <text>` writes
`not_applicable: [{kind, reason, approved_by}]` into `catalog.yaml` (`--rm` withdraws it). It
takes effect only after one human confirmation: `review request` lists it as
`not-applicable:<kind>` next to the plan's pending waivers, `review acknowledge` (not
`--delegated`) approves it and records the approver in `approved_by`; until then the policy
still requires the kind and reports `waiver-unapproved`. Changing the reason clears the
approval.

`test discover` scans package scripts and tool configs (vitest, jest, mocha, node:test,
Playwright, tsc, eslint, pytest, go) and prints suggested suites with reporter flags that
produce parseable reports; `--write` appends the ones whose id is not yet in the catalog.
`tenon init` runs it for you when a workflow with a `test_policy` finds no catalog and says
so on stderr (nothing is written when no tool is recognised, and an existing catalog is never
touched). For JavaScript unit suites without an `include` in the tool config, the test-file
globs cover `src/`, `test/`, `tests/`, `__tests__/` and root-level `*.test.*` / `*.spec.*`
files (when none of those directories exists, any `*.test.*` / `*.spec.*` file below the
suite's `cwd`).
`*.bench.*` files in a vitest project become a `vitest-bench` benchmark suite whose metrics
are `<bench name>.mean_ms` for every `bench('name', …)` it can read (a name it cannot read is
never guessed); any other `bench` script is reported with the exact `catalog add` command to
register it, because a benchmark must declare its metrics and thresholds.
`catalog add --from <direction>` starts a suite from a test direction (bare tool
invocations are replaced by the runner's recommended invocation); `catalog validate`
lists every problem as `catalog.yaml:<line>: …` (exit `2`). `test plan --seed` adds the
suites that own or cover the files this change touched, one suite per policy-required
kind, and the changed test files, and lists the scenarios and tasks still to map with
ready-to-run `register --case` commands; it also registers the catalog suites of the kinds a
step lists in `run_if_registered` (benchmarks excepted). Only scenarios and the tasks under the
implementation (`build`) section of `tasks.md` must be mapped (`scenarios: required|passing`
blocks on them); tasks in any other stage section are listed separately as optional (shown as
"optional", not "uncovered", in the verification report) and never block. The scaffold prompt
"break this stage into verifiable tasks" is not a task the author wrote: the seed, `test sync` and
`test plan` no longer list it, and the traceability matrix shows it as optional. `test register
<change> --auto` is the one-command form: it discovers a missing catalog, widens the
`files` globs of a suite so that test files no suite claims are claimed (a `test/**/*.test.js`
glob for `test/x.test.js`; `e2e/` specs go to a Playwright suite, helpers and `*.bench.*`
files are never claimed automatically), then seeds the plan and registers those files. It only
adds, so it is safe to repeat. `test sync` diffs the change against its start
and lists unregistered test files, files no suite claims, and registrations whose file is
gone; it uses the same computation as the gate (exit `2` when something is pending).

The start of a change is the merge-base with its base branch, or the last commit before
the change was created when working on the base branch itself; the diff includes staged,
unstaged and untracked files. When that diff cannot be read the gate blocks with
`files-diff-unavailable` (it fails closed, it does not degrade to a notice).

`test run` writes one v2 record per invocation (`.tenon/users/<slug>/tests/<change>/<run-id>.json`)
chained by `prev_digest`; editing a record breaks the chain and every v2 record of that
change counts as not run until a new run starts a fresh chain. Records are tracked in the
repository by design (they are the evidence other people and CI read), so their number is capped:
after each run only the newest 20 per user and change are kept (inline step tests: per test).
Pruning removes the oldest prefix and leaves a `chain-base` marker next to the records naming the
last removed digest, so the remaining chain still verifies; a missing middle record, a marker that
does not match, or a damaged marker is still a broken chain. Test processes run with the running
`tenon` first on `PATH` (the launcher's directory, or a forwarding script for a direct
`node …/tenon.mjs`), so `tenon test code-size --json` also works where no launcher is on `PATH`;
`tenon doctor` reports `env:path-tenon` when the agent's own shell cannot resolve `tenon`. The
delivery commit never includes `.pipeline-owned.json`, `test-results/`, `playwright-report/` or a
root `coverage/`, and the generated `tenon-<name>` host agent files plus those output directories are
added to the clone's `.git/info/exclude` (the project `.gitignore` is not touched). Selection: `--suite`,
`--kind`, `--all` (every plan suite, full), `--changed` (narrow to changed test files when
the suite has a `select.files` template, otherwise the whole suite), `--stage [<step>]`
(the step policy's `run` kinds, plus `run_if_registered` kinds that the plan registered;
policy `scope: full` forces full runs). With no selection flag `--stage` is implied.
`--stage` runs catalog suites only: inline `tests[]` (suites whose id starts with `step:`)
stay on `tenon test run <change> <test-id>` and the summary lists the commands still to
run; a step whose policy has nothing to run says so and exits `0`.
Declared services start once per invocation in their own process group, are probed
(URL, port or log text) and are reaped afterwards including grandchild processes;
a URL or port that already answers before start is refused, because the tests would
hit an old server. `parallel: true` suites run concurrently, the others one by one.
Reports are parsed per case: `junit`, `playwright-json`, `vitest-json`, `jest-json`,
`go-json`, `tap`; benchmarks read `benchmark-json` (also hyperfine and vitest bench output),
`k6-summary` and `lighthouse-json`; coverage reads `istanbul-summary`, `lcov` and
`cobertura`, and `changed_lines` is computed from the diff. A stale report from an earlier
run is deleted before each execution. A run fails on: no report (`report-missing`),
an unparseable report (`report-unreadable`), zero or all-skipped cases (`no-tests-ran`),
exit code and report disagreeing (`exit-report-mismatch`), a registered file or mapped case
that never ran (`registered-test-not-executed`), coverage below the step policy
(`coverage-below`), a benchmark regression beyond the metric threshold
(`benchmark-regression`), flaky cases over the policy limit (`flaky-over-limit`), a required
browser project missing from the report (`browser-project-missing`) and a service that did
not become ready (`service-not-ready`). Failed cases are retried per `retries` (Playwright
gets `--retries`; other runners re-run only the failing cases through `select.grep` /
`select.files`); a case that passes on retry is `flaky` and counted. Every case failing
outside the known-failure list fails the suite. Screenshots, traces, videos and HTML
reports are copied per file into the run's artifact directory and indexed
(`{path, bytes, digest, media}`) so they can be opened or downloaded. Exit codes: `0`
all suites pass, `2` a suite failed (the record is written), `1` usage or environment
error (no record). After the run the command prints the step's exit gate again, with a fix
command for each remaining blocker. `--json` prints the record and the gate.

node:test reports need a `file` on every case, and Node 22 and earlier do not write one: the
built-in `--test-reporter=junit` leaves `file` off `<testcase>` (Node 24 writes it), so without help
the trace, the registered-case check and the run drawer cannot tie a case to its test file.
`test discover` therefore gives node:test suites
`node --test --test-reporter="${TENON_NODE_TEST_REPORTER:-junit}" --test-reporter-destination=test-results/junit.xml`.
`tenon test run` writes a small reporter that ships inside the CLI bundle into the run's own
artifact directory (`.tenon/users/<slug>/local/artifacts/<change>/<run-id>/reporters/`, never into
the project tree) and sets `TENON_NODE_TEST_REPORTER` to its `file:` URL, so the report carries
`file` on Node 20, 22 and 24; run by hand outside `tenon test run` the variable is empty and the
built-in `junit` reporter is used. The command relies on POSIX `${VAR:-default}` expansion, like
the Playwright preset's `VAR=value` prefix. The JUnit parser takes a case's file from
`testcase@file`, a path-like `classname`, the enclosing `testsuite@file`, or a class-like
`classname` such as `com.example.MathTest`; a `classname` like node:test's `test` or a describe
title like `utils.js` is never taken for a file. A case whose file cannot be determined is
recorded with file `(unknown)`. A registered case reference `<file> › <name>` matches such a
case by name alone only when its title path equals the tail of the case's path and exactly one
case in the whole run has that path (a same-named case in another file makes it ambiguous, so it
does not match and stays `registered-test-not-executed`); the file part of the reference is then
not compared. A registered file counts as executed when one of its registered case references
matches that way; a registered file with no case reference cannot be verified from such a report
and is reported as `registered-test-not-executed`, with a hint pointing at the reporter.
Known-failure entries and the `fail_on_new` flaky check still need a real file: they never match an
`(unknown)` case.

Benchmarks run `warmup` then `runs` times and keep the median, p95 and MAD of every
sample. When the spread exceeds half the regression threshold the suite is sampled once
more before judging. Baselines are stored per machine profile (OS, architecture, CPU,
cores, memory tier, runtime major version and the catalog's `profiles_env` values) in
`.tenon/tests/baselines/<suite>/<profile>.json` and are tracked in git; profiles never
compare with each other. A catalog may set `profile: coarse` at the top level to use the
coarse profile instead: OS, architecture, core count and runtime major version plus the
`profiles_env` values (for example `linux-x64-4c-node22-1a2b3c4d`), without CPU model and memory
tier, so hosted CI runners of one size share one baseline. The default is `profile: fine`
(the same as leaving it out); an unknown value is rejected. Changing it makes earlier run
records stale (the catalog digest they bind changes) and points baseline lookups at a different
profile id. A catalog with a `profile:` key is rejected by a Tenon older than
the release that introduced it. Without a baseline for the profile the run passes with a
`baseline-missing` notice and the command to create one (`test baseline --suite --run`),
unless the step policy requires a baseline. `test baseline` accepts only a passing run
on the current record chain and appends an audit line to the user's `audit.jsonl`.

`known add` writes an entry with reason, optional link and an expiry date to
`.tenon/tests/known-failures.yaml`: a listed case that still fails is `known-fail` and
does not block; one that passes is reported as fixed, with the `known rm` command; an
expired entry is treated as an ordinary failure; a failure outside the list blocks.
`known list` marks expired entries. A known failure is a temporary exception, not an
allow-list: `--test` must name one case (`<file> › <name>`; a bare file is refused), the
expiry is at most 30 days from today (a hand-written entry further out is not honored, the
case fails like any other and a `known-failure-too-long` notice explains), and adding or
changing an entry is a change to `known-failures.yaml` that needs the human confirmation
described next.

**Trust root of test evidence.** Four independent layers keep an agent that wants a green run
from getting one:

- *Reports.* Before each invocation Tenon deletes the suite's old report; the report it reads
  must be newer than the start of that invocation (a file back-dated with `cp -p` or `touch
  -d` is `report-untrusted`) and Tenon copies it into the run's artifact directory, recording
  its digest, so a report rewritten after it was read, or one with no copy, is
  `report-untrusted` too. Exit-code/report cross-checking is unchanged.
- *Local seal.* Per user and gitignored, `<user-dir>/local/test-seal.json` is signed with an
  HMAC key in `local/env.key`. It holds the head digest of each change's record chain, the
  digests of baselines and `known-failures.yaml` as written by Tenon commands, your review
  approvals, and your trust decisions. A chain whose head is not the sealed head (records
  written around `tenon test run`) is `record-unsealed`, has no approval path, and the next
  `tenon test run` starts a new chain over it. A missing, damaged or edited seal reads as
  empty, never as permissive.
- *Human confirmation.* Changes to `.tenon/tests/catalog.yaml`, `.tenon/tests/baselines/**`,
  `.tenon/tests/known-failures.yaml` and `.pipeline/workflows/*.yaml` in the change's diff
  block every `gate: review` step (`protected-file-unapproved`) until you confirm the exact
  content. `tenon review request` lists each file with its state and digest, and for the
  catalog and known failures the added, changed or removed suites, services and entries; a
  human `tenon review acknowledge` (or the Dashboard's Approve) seals the approval for those
  digests, `--delegated` is refused while any is pending, and a later edit needs a new
  confirmation. A baseline or known-failures file that no longer matches what Tenon last wrote
  is `protected-file-tampered` and is labeled as changed outside a Tenon command.
- *First-run trust.* `tenon test run` refuses to execute a catalog (and, for inline step tests,
  the frozen workflow's test commands) whose executable text you have not trusted on this
  machine: suite `command`, `select` templates, `cwd`, declared env names and service start,
  ready and stop settings, keyed by digest (a label or `covers` edit does not ask again; any
  command edit does). `tenon test trust [<change>]` lists the commands and asks `[y/N]` in an
  interactive terminal (`--yes` for your own scripts, `--status` to only check, exit `2` if
  untrusted, `--json`). CI sets `TENON_TEST_TRUST=1` explicitly; every run then prints a line
  saying trust came from the environment. The Tenon hook refuses an agent's shell call that
  contains `tenon test trust` or a `TENON_TEST_TRUST=` assignment, so the decision stays with
  you.

`test status` reports each declared test of the step with the same evaluation the
transition uses, so a status pass is a transition pass; with `--json` a step that declares
`test_policy` also carries a `policy` object (blockers with fix commands, notices, suites,
the scenario/task trace, file registration and the record chain state). It exits `2` while
anything blocks. A record goes stale when the candidate code, the catalog entries of the
suites it ran, the plan, the step policy or the workflow fingerprint changes; a record
binds the plan digest with every waiver's `approved_by` treated as empty, so approving a
waiver in review does not make the runs before it stale (any other plan change does). `test
report` generates the tests section of the verification report and, with `--write`,
replaces it in an existing repository file. There are two independently replaced regions:
the v1 table of inline step tests (between `tenon:tests:*` markers, written only when the
workflow has inline tests) and the v2 block (between `<!-- tenon:test-report:begin -->` and
`<!-- tenon:test-report:end -->`) with the traceability matrix, suites with coverage and the
`run_id` of each suite's latest run, benchmark deltas, flaky and known failures and the
blockers left. Bytes outside the markers are never touched, and `tenon status` decides
whether the report still needs regenerating by looking for the latest run ids inside the v2
block. `test code-size` is the deterministic probe behind the builtin
`code-size` direction and prints one JSON line of metrics. It counts source files only: the
same path scope as the workspace candidate (no `openspec/`, `.tenon/`, `.pipeline/`,
`docs/`, dependencies or test caches) and no Markdown files.

Inline step tests (`tenon test run <change> <test-id>`) keep their v1 behavior:
the command is executed in its own process group and recorded with the exit code,
duration, actor, input digests and output files, the log and output copies stay in the
gitignored per-user local directory, and the record goes stale when the candidate, the
test declaration digest or the workflow fingerprint moves. The command receives
`TENON_CHANGE_NAME`, `TENON_TEST_ID`, `TENON_TEST_RUN_ID`, `TENON_TEST_ARTIFACTS` and
`TENON_BASE_BRANCH`; suite runs receive `TENON_TEST_SUITE` (the suite id) instead of `TENON_TEST_ID`, plus
`TENON_NODE_TEST_REPORTER` when a suite command or `select` template references it. Exit codes for
inline tests: `0` pass, `2` fail (the record is written), `1` usage or environment error
(no record).

`tenon status <name> --json` also carries a `step` block: the whole input the
single `tenon` skill needs for the current step — its skills, executors,
reviewers, tests, documents, fields, review receipt, exits with blockers, and a
closed `next` action list to execute in order.

```text
tenon spec apply <change> [--dry-run] [--json]
```

`spec apply` rehearses `openspec validate --strict`, `openspec archive` and a
per-capability strict re-validation inside a temporary copy of `openspec/`, then
writes only the changed main spec bytes back under a compare-and-swap and records
`applied-spec.md`. `--dry-run` writes nothing but the receipt. Exit codes: `0`
pass, `1` usage or state, `2` validation or rehearsal failed, `3` no `openspec`
on PATH, `4` a main spec changed during the rehearsal.

## Documents, artifacts, and review

```text
tenon document init <change>
tenon document record <change> <kind> <path> --producer <skill-id>
tenon document read <change> <kind|all>
tenon document status <change> [--json]
tenon artifact register <change> <field> <path> --producer <skill-id>
tenon review request <change> --event <event>
tenon review acknowledge <change> [--delegated] [--as reviewer]
tenon agent next <change> [--json]
tenon agent prompt <change> <agent> [--host <id>] [--rerun-reason <text>] [--json]
tenon agent record <change> <run-id> [--subagent <type>] [--json]
tenon agent list [--role executor|reviewer] [--source official|custom|project] [--json]
tenon agent show <name> [--json]
tenon agent new [<name>] --role <role> --description <text> [--skills a,b] [--tools A,B] [--model <m>] [--hosts a,b] [--scope user|project] [--from <agent>]
tenon agent add <file> [--scope user|project] [--replace]
tenon agent validate <file|name>
tenon agent copy <from> <to> [--scope user|project]
tenon agent rm <name> [--scope user|project]
tenon agent export <name> --host claude|codex
```

`tenon agent` drives the executors and reviewers a step declares. Tenon only
orders them, renders the handoff, records the verdict, and binds it to the
candidate; the host runs every model. `next` returns the current wave, `prompt`
starts or resumes one agent and prints its handoff (with `--host claude|codex`
it generates the host's `tenon-<name>` subagent file and returns
`subagent_type`), and `record` reads the trailing ```tenon-result``` block of
the report (`--subagent` records the subagent that actually ran). The library
commands register agents in the terminal; see [Agents](agents.md). A reviewer never reports its own
verdict: Tenon derives pass or fail from the finding severities and the step's
`block_at`. Every run of a reviewer on the same candidate (the same code) is kept and the most
severe verdict wins, so a rerun cannot flip a finding away: once a reviewer has a verdict on the
current candidate, `agent prompt` refuses to start it again (exit `2`) unless you change the
code or pass `--rerun-reason <text>`; a run that carries a reason is the verdict that counts
and the reason is recorded. `agent next`, `status --json` (`step.reviewers[]`) and the
Dashboard show the rerun count (`reruns`), whether the verdict was flipped (`flipped`) and the
reason (`rerun_reason`). Human `review request/acknowledge` remains a separate exact-event
confirmation boundary and may be combined with reviewers.

Who may confirm a review: the task owner, like every other write on the task (`transition`, `set`,
`review request`). Someone else reviewing the owner's work says so explicitly with
`review acknowledge <change> --as reviewer`; the confirmation is then recorded in the change history with
`as=reviewer owner=<id>`. Without the flag a non-owner is refused and nothing is written; the alternative is
`tenon owner take <change>`, which moves ownership. The Dashboard's Approve is confirmed by the top-bar user.

`review acknowledge` exit codes: `0` approved, replayed, or approved with a
review-marker cleanup warning; `2` no matching pending review (missing, already
consumed, stale binding, or the event is no longer a workflow exit); `3`
revision conflict (Dashboard CAS path only); `4` idempotency conflict; `1`
invalid command (for example an `--event` that differs from the pending
receipt) or unexpected error. A failed acknowledgement writes nothing.

`review request` also freezes and lists the test-plan waivers that are still
unapproved (`waivers[].approved_by` empty). A human `review acknowledge` writes
`approved_by` for exactly those waivers in the same lock as the approved
receipt, and leaves a `test:waiver-approve` line in the change history;
`--delegated` never approves a waiver and is refused (nothing written, the review
stays pending) while the plan has one, and a waiver added after the request is not
approved by that confirmation (`step.next` asks for a fresh request first). The Dashboard review console's
Approve is the same human confirmation: it lists and approves the same frozen list and leaves the same
`test:waiver-approve` line. Plan writes and baseline updates leave `test:plan-write` /
`test:baseline-update` lines the same way. The same frozen list carries the protected
test-configuration changes of the change (catalog, baselines, known failures, project
workflows) described under *Trust root of test evidence*; approving them leaves a
`test:protected-approve` line.

Document structures and project-level spec scaffolds default to Chinese. English
is explicit:

```text
tenon init <name> ... --document-locale en
tenon document scaffold <change> <kind>
tenon document scaffold <change> delta-spec --capability <capability>
tenon scaffold spec web [--document-locale zh-CN|en] [--strategy skip|overwrite|append]
```

The Change locale is pinned in `.pipeline-document-locale.json`, outside the
strict canonical state schema so an older release can roll back safely.
The `overwrite` scaffold strategy stages the complete top-level project envelope beside the target
and commits it with a persistent transaction receipt. A later invocation first recovers an
interrupted directory switch. A live writer, or an unknown path occupying the target after the old
envelope moved, causes a fail-closed error while preserving recovery evidence.

## Tracks and custom workflow use

```text
tenon tracks list [--json]
tenon tracks show <id> [--json]
tenon init <change> --workflow <workflow> --track <track> --preset <preset>
```

`tenon tracks` is read-only. A Track is a branch of a Workflow: whether
`--track <track>` may be used with `--workflow <workflow>` is decided solely by
whether that Workflow's YAML declares the branch under `tracks:`. To add a
Track, declare the branch in the Workflow file (or in the Dashboard workflow
page), not through a separate registry command.

Custom Workflow authoring is file/Dashboard based; there is no public
`tenon workflow create` command in the current CLI. `tenon workflow plan`
is a read-only runtime introspection command, not a workflow authoring command.

Reviewers are declared per step and never inferred from a Skill or command name:

```yaml
name: release-train
steps:
  - id: verify
    label: Verify
    gate: review
    skills:
      - id: acme-quality-gate
    agents:
      reviewers:
        - agent: security
          required: true
          block_at: medium
        - agent: code-size
          required: true
          block_at: medium
          reads_tests: [code-size]
        - agent: architecture
          required: false
          block_at: high
          depends_on: [security, code-size]
```

Every `required` reviewer must pass on the current candidate before the step can
be left; an advisory reviewer only reports. `reads_tests` names tests the same
step declares, and Tenon hands their results to the reviewer. Agent definitions
live in the agent library (official, custom, and the project's `.tenon/agents/`) and are frozen into
`<change>/.pipeline-frozen/` when the Change is created, so editing the library
never changes a Change that is already running.

## AFK and loops

```text
tenon afk enqueue <change> [--loop <id>]
tenon afk scan [--json]
tenon afk status [change] [--json]
tenon afk run <change> [--level L1|L2|L3] [--image <image>]
tenon afk cancel <change>

tenon loops init <options>
tenon loops list [--json]
tenon loops status [--json]
tenon loops enforce [--loop <id>]
tenon loops budget|cost [loop]
tenon loops graduate [loop]
tenon loops level <loop> [set <L1|L2|L3>] [--confirm]
tenon loops run <loop|pattern> [--dry-run] [--level <level>] [--commit] [--json]
tenon loops sync <loop> <--dry-run|--apply> [...]
```

## Advanced

```text
tenon channel help
tenon mem list|search|context|extract|projects
tenon tap start <client...> [--ca [dir]] [--forward] [--json] \
  [-- <command> ...]
```

Channel is orthogonal worker messaging; memory is read-only; Tap is explicit
opt-in sensitive local diagnostics.

## Verification

Use the installed command as exact authority:

```bash
tenon --help
tenon setup --help
tenon tracks --help
tenon afk --help
tenon loops --help
tenon channel help
```

## Common failures

- choosing zero or multiple setup/update hosts;
- inventing a workflow CRUD command not in help;
- treating `check` as an automatic transition;
- scripting human-readable output when `--json` exists;
- using advanced mutation flags without dry-run/review.

## Next action

Return to the [usage index](README.md) or
[troubleshooting](troubleshooting.md).
