# CLI reference

## Goal

Provide a navigable command-family map while keeping
`tenon <command> --help` as the exact flag authority.

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
tenon --version
tenon runtime status
tenon runtime repair --rollback
tenon dashboard --open
```

`tenon --version` (`-V`) prints the version of the plugin payload the command runs from (the plugin manifest); for an
installed runtime it is the number `tenon doctor` shows as `runtime=`. It needs no project and changes nothing.

```text
tenon setup --<one-host> [--target <dir>] [--auto-update] [--dry-run] [-y]
tenon setup --claude|--codex --from-source <repo> [--skip-build] [--dry-run]
tenon update --<one-host> [--target <dir>] [--dry-run] [-y] [--auto]
tenon update --claude|--codex --to-stable [--dry-run] [-y]
tenon host-target-plan [--host <registered-host> --operation <setup|update>] --json
tenon runtime status [--json]
tenon runtime repair --rollback [--json]
tenon dashboard [--port <port>] [--background] [--open] [--dry-run]
tenon doctor [--json]
tenon uninstall [--dry-run] [-y]
```

`tenon setup --claude|--codex --from-source <repo>` is the source development install, for working inside a Tenon
checkout. It builds the checkout (`npm --prefix <repo> run build`, skipped by `--skip-build`), fetches any missing
upstream skills and the local `skills/skills.lock.json` index from `skills/sources.yaml` (the whole command aborts
before any host change if that fetch fails), registers the checkout directory as the `tenon` marketplace, and
publishes a managed runtime whose manifest records `devSource` (commit, `dirty`, a content digest of the installed
files, a digest of the skills index) instead of a stable tag. It never poses as a release: the plugin version stays
the checkout's `plugin.json` version and only `/api/health` shows `<version>+dev.<sha7>`. A development install turns
auto-update off, `tenon update` refuses it, and `tenon update --claude|--codex --to-stable` switches back to the
latest stable release. Without `--from-source`, setup and update behave exactly as before and accept only stable
tags. `tenon doctor` reports `identity:release` as a warning for a development install and `source:drift` when the
checkout no longer matches what is installed. `--from-source` combines with exactly one of `--claude` / `--codex`,
not with adapter hosts or `--auto-update`.

Known risk: `--from-source` runs the build of the checkout you give it (`npm --prefix <repo> run build`) and fetches
upstream skills from that checkout's `skills/sources.yaml`. It then installs that checkout's hooks and skills into the
host for good, so they run in every later session. Whether a directory counts as a Tenon repository is decided only by
that checkout's own files, and nothing asks for extra confirmation when an agent starts the command. It carries the
same weight as any other command an agent can run: it is an explicit developer command, so use it only on a checkout
you trust.

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
tenon assess --files <path>... [--workflow <name>] [--track <track>] [--json]
tenon init <name> [--workflow <name>] [--track <track>] [--preset <preset>] [--domain <track>]
tenon list [--json] [--finished]
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
tenon task add-dep|remove-dep <name> <dep>
tenon task finish <name> [--json]
tenon task terminate <name> [--yes] [--json]
tenon task delete <name> [--yes] [--json]
```

`get` returns an empty line with exit `0` for a missing/unknown field. CAS
mismatch exits `3`; failed guard check exits `2`; invalid transitions exit `1`.
A transition of a new Change that is refused because a handed-over input is unread exits
`1`; one refused by an unmet guard, a missing `required-output` included, exits `2`.
An illegal or unknown `transition` event also lists the legal events for the
current step, on a second line, in the active language.
Use command help and machine-readable output before scripting additional
assumptions.

`tenon init` takes the Track from the Workflow's own branches: a Workflow with
`tracks:` needs `--track` (the default Workflow's are `lite`, `pm`, `frontend`,
`backend`), a flat Workflow such as `design-system` takes none.
`--workflow standard` and `--workflow simple` exit `1` and print
`--workflow default --track lite`; the retired Track ids `standard`, `simple`,
`chat` and `free` given to `--track` exit `1` and list the Tracks the Workflow offers.
`--domain <track>` is for a lightweight Change: it records
which other Track of the same Workflow (it must exist there) the Change would
escalate to, so the `escalate.then` of its risk probe can name that Track
directly. Without it `then` lists the possible Tracks for the user to choose.
`tenon tracks list` shows the available Tracks. See
[Routing and execution modes](routing-and-workflows.md#assess-before-you-create-the-change).
A new Change gets the checkpoint of its first step and, on a Track with `spec: openspec`,
the `tasks.md` skeleton; it gets no proposal or design skeleton and no document ledger.

`tenon assess` evaluates the files you expect to change against the change-risk
thresholds of a Track (the `pass.metrics` of its `diff-risk` step test; by default
`--workflow default --track lite`) with exactly the classification the risk probe
uses, and reads no file contents. Paths must be repository-relative; absolute
paths, `..` segments and symlinks that leave the repository exit `1`, and so
does a Track without `diff-risk` thresholds. Exit `0`: within the limits;
exit `3`: over a limit, with the breached limits listed (for example
`auth_files 1 > 0`) and a heavy Track recommended. `--json` prints
`{ workflow, track, metrics, exceeded, reasons, recommendation }`.

`check <name>` without an event reports the guards of the current step together
with those of its forward edges, lists every unmet condition at once and exits
`2`. `advance <name>` moves only along a single forward edge; it never takes a
return edge or the abandon edge `scope-expanded`.

`task finish` and `task terminate` end a task by moving its directory into
`openspec/changes/archive/<date>-<name>/` and recording the task result
(`finished`, `escalated` or `terminated`). `finish` accepts only a task that has
reached a terminal step (Finished or Escalated); for a Track with `spec: openspec`
Tenon runs `openspec archive <name> --skip-specs --yes --json`, otherwise it moves
the directory itself and adds `-2`, `-3` to a name already archived that day.
`terminate` accepts any task that has not ended, records Terminated and commits
only the task directory (`chore(tenon): terminate <name>`); the code the task
changed is neither committed nor reverted. Exit codes: `0` done; `1` usage, name,
missing task or identity, wrong state, or failure; `2` confirmation needed (rerun
with `--yes`); `3` blocked (for example by a running AFK job or by a dependent
task). `--json` prints `{ change, result, archived_dir, ended_at }` (`terminate`
adds `commit`). The former hide subcommands `archive` and `unarchive` of `tenon task`
no longer exist; they exit `1`, naming `finish` and `terminate`. `tenon list --finished`
lists the ended tasks, archived ones included.

`tenon workflow plan <name> --json` is the Agent-facing orchestration source
for an in-flight Change. It returns the immutable plan captured when the
WorkflowRun started, including steps, Skills, gates, guards, and transitions.
Editing or deleting `.pipeline/workflows/<workflow>.yaml` affects
new runs only; it does not rewrite the Todo or Skill DAG of an existing run.

`handoff --bundle` compiles a deterministic `context-bundle/v1` for the target phase.
For a new Change the inputs are the documents handed over to the step the task is
on (its direct upstream's outputs; `--target` defaults to the current step), each
summarised, and a digest must equal the one the upstream recorded or a read receipt
of this step, otherwise the compile fails closed and asks for a re-read. For a Change
created before the upgrade the inputs come from the authoritative document ledger and
carry their document kind, recorded SHA-256, materialization mode, and policy reason.
The bundle itself carries an aggregate SHA-256. Missing files, digest drift,
duplicate slots, or an exceeded UTF-8 byte budget fail closed. The bundle is a
derived handoff artifact, not a replacement canonical document; for a Change
created before the upgrade repair stale inputs with `tenon document record` under an
allowed producer and then re-run the handoff.

### Verification round limit

A step that has a review gate and at least one return edge (in the default workflow, Verify with `verify-fail`) is limited in how many rounds it is verified. A round is one entry into the step since the count was last reset, the current one included: the first entry is round 1, and every `verify-fail` back to Build followed by `build-complete` enters Verify again. The count starts again from 1 when the task lands on a step earlier than every return target (in `default`, through `requirements-changed` back to Spec). Deleting a marker, rerunning a command or switching agent never resets it.

The limit comes from three places, the later one winning: the built-in 2 (a limited step that declares nothing, such as a step of a custom workflow or of a plan frozen before the key existed), the step's `max_rounds` key (the default workflow declares 2 on the Verify step of every track, see [Default workflow](default-workflow.md#verification-round-limit)), and the task field `max_rounds`.

```text
tenon set <change> max_rounds <N>
tenon get <change> max_rounds
```

`set` accepts an integer from 1 to 20; anything else exits `1` and writes nothing, and the write is recorded in the change history. `get` prints an empty line while the field was never set. The value applies to every limited step of that task. Raising the limit is the user's decision: an agent runs `set max_rounds` only when the user explicitly says so. Because the write changes the task state, a review request that is already open or approved becomes invalid: read `step.next` again and run `tenon review request` again. A value at or below the current round counts as used up at once; only a value above it brings the return edge back.

`tenon status <change> --json` reports the count in `step.rounds`, right after `exits`:

```json
"rounds": { "current": 2, "max": 2, "source": "workflow" }
```

`source` is `workflow` (the step's `max_rounds`), `default` (the built-in 2) or `task` (the task field). The value is `null` on steps that are not limited (Build, a review gate without a return edge) and on a finished task.

When `current` has reached `max` and a required test or a required reviewer still fails, the step stops going back by itself:

- `step.next` no longer returns `request-review`, `choose-exit` or `transition` for the return edge. If only required reviewers fail, or every failing required test is waived, it returns `request-review` for the forward edge with three extra fields: `residual` (the failing reviewers, as `reviewer:<agent>`), `rounds` and `alternatives` (the other ways out). If a required test fails without a waiver, it returns `stop` with `code: rounds-exhausted`; its `message` names the failing tests and says a step-test waiver can be registered first. Both list the other three ways out: raise the limit (the user's decision), return to Spec, or end the task. Returning to Spec takes two steps because the limited step has no direct edge for it (every return edge it declares is itself a return target, so landing there does not reset the count, and once the rounds are used up those edges are refused too): after the user raises the limit, go back through the return edge `verify-fail` to Build, then run `tenon transition <change> requirements-changed` on Build; once the task is in Spec the count starts again from round 1 and the user can lower `max_rounds` again. On a custom workflow the text names the return edge and the event of the return target that lands on an earlier step from the plan; when no step is earlier than every return target it says that going back would not reset the count.
- `step.exits[]` shows the return edge as `ready: false` with the blocker `{ "source": "guard", "code": "rounds-exhausted", "message": … }`. Forward edges and the abandon edge `scope-expanded` are unchanged.
- `tenon review request <change> --event <return event>` and `tenon transition <change> <return event>` exit `1`, write nothing, and print the rounds used, the limit and `tenon set <change> max_rounds <N>`. The Dashboard transition answers HTTP `409` with `code: "rounds-exhausted"` (and `step`, `event`, `current`, `max`, `source`). Return edges of steps that are not limited, such as `requirements-changed` on Build, stay available.
- Before the limit is used up nothing changes: the return edge is offered and refused exactly as before.

**Accepting residual blockers.** On a step whose rounds are used up, `tenon review request <change> --event <forward event>` lets the required reviewers that fail on the current candidate through instead of refusing the request. It freezes each of them in `.pipeline-review-waivers.json` as a pending residual blocker (key `reviewer:<agent>`, the reviewer run, the code candidate and the blocking findings) and prints them one by one with their findings; show that output to the user together with `alternatives`. Before the limit is used up a failing required reviewer still refuses the request.

- Only a human confirmation accepts them: the user's approval phrase ("确认继续", "继续执行"), or `tenon review acknowledge <change>` run by the user in their own terminal. It writes the acceptance under the same lock as the approved receipt and appends one `review.residual-accepted` row per reviewer to the change history (reviewer, run, candidate, findings, the confirming user, and `summary=`: the findings summary frozen with the request, at most 5 entries joined by `|`, with any `|` inside an entry replaced by a full-width `｜`, each entry sanitized). `tenon check` then prints a `[WARN]` line for the accepted reviewer instead of blocking, and `tenon transition <change> <forward event>` is no longer refused because of it.
- `review acknowledge --delegated` and AFK mode never accept them: while a residual blocker is pending the command is refused, nothing is written and the review stays pending. The Dashboard review console does not list them either, so its Approve answers HTTP `409` with `code: "residual-pending"`; confirm in the terminal.
- The acceptance is bound to the reviewer's run and to the code candidate it was given for. A code change, or a new run of that reviewer (a rerun with `--rerun-reason` included), ends it: the forward edge is blocked by that reviewer again and the request has to be made and confirmed again. When an approved receipt does not cover the current verdict, `step.next` returns `fix` with the blocker `residual-unaccepted`; run `tenon review revoke <change> --reason <reason>` and request the review again.
- Residual blockers cover reviewers only. A failing required test is still handled by a step-test waiver (`tenon test waive <change> --test <step-test-id> --reason <text>`), which the same review request can list together with the residual blockers.

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
tenon test unregister <change> --suite <id> | --file <path> | --case <covers> [--test <ref>] | --waiver <kind|covers|test:step-test-id>
tenon test waive <change> (--kind <k> | --covers <covers> | --test <step-test-id>) --reason <text>
tenon test sync <change> [--json]
tenon test sync <change> --prune [--json]
tenon test trust [<change>] [--yes] [--status] [--json]
tenon test run <change> [--suite <id>]… [--kind <k>]… [--stage [<step>]] [--all] [--changed] [--json]
tenon test run <change> <test-id> [--json]
tenon test status <change> [--step <id>] [--json]
tenon test integrity <change> [--step <id>] [--json]
tenon test baseline <change> --suite <id> --run <run-id>
tenon test baseline <change> <test-id> --run <run-id>
tenon test known add --suite <id> --test "<file › name>" --reason <text> --expires <YYYY-MM-DD> [--link <url>]
tenon test known rm --suite <id> --test "<file › name>"
tenon test known list [--json]
tenon test report <change> [--step <id>] [--write <path>] [--locale zh-CN|en]
tenon test code-size [--base <ref>]
tenon test diff-risk [<change>] [--json]
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
workflow of open changes, plus one general rule: a file under a directory named `test-results`,
`playwright-report` or `coverage` (at any depth) that git does not track and whose extension is
an evidence format (log, txt, xml, md, csv, png, jpg, jpeg, gif, webp, webm, mp4, lcov, info) is
not part of the candidate, so a server that writes a log during an e2e run does not invalidate the
frozen build. Tracked files, source or script extensions (js, ts, mjs, sh, py, …), files without an
extension, and formats that code or a browser can load or unpack straight from those directories
(json, html, htm, zip, gz, har) still count, so a directory name cannot hide code or a page; a
suite that really produces such a file declares it as an output in the catalog. When git cannot
be read every file in those directories counts. The per-change **plan**
(`openspec/changes/<change>/test-plan.yaml`) lists only the choices made by hand: suites added with
`register --suite`, resource files registered with `--file --kind`, the scenario/task → case
mapping (`spec:<capability>/<Scenario title>` or `task:<number>`) and waivers. Test files the change
added or changed are claimed, when a step is evaluated, by the suites whose `files` glob matches
them; they are not written to the plan. Only the `tenon test` commands write the plan: every
write records a digest in a change-local ledger, so a hand-edited plan becomes `test-plan-tampered`.
The workflow's **level** (`steps[].test`) says what a step needs from all this: one of `none`, `plan`,
`changed` and `full`. What each level requires is defined by the optional top-level `levels` key
of the catalog, in this file, and falls back to built-in defaults:

```yaml
levels:
  plan:    { required: [unit] }
  changed: { required: [unit], touched: [static] }
  full:    { required: [unit], touched: [integration, e2e, static, benchmark] }
```

Each level accepts six keys: `required` and `touched` (test classes), `scenarios` (`off`, the
default, `required` or `passing`), `coverage` (`lines`, `branches`, `functions`, `statements`,
`changed_lines`, 0–100), `flaky` (`{ max, fail_on_new }`) and `require_baseline` (default `false`);
`plan` takes only `required` and `scenarios`. A level runs the suites of its `required` classes (all of
them, in full, at `full`; only those the change touches, on the changed scope, at `changed`) and the
suites of its `touched` classes that the change touches; a suite is touched when a changed file matches
its `files` or `covers` glob. A suite without `covers` counts as touched only when one of its own
test files changed. When a change edits only source files, such a suite does not run at `changed`
(as a `required` or `touched` suite) or at `full` (as a `touched` one), and `tenon test status` and
`test run --stage` print the non-blocking notice `suites-without-covers` naming it. To make source
changes trigger the suite, write its `covers` with
`tenon test catalog set <id> --cover-glob "<glob>"`. A level that finds nothing to run
is satisfied: `test run --stage` says so and exits `0`. An invalid `levels` block (unknown level, key
or class, a coverage value outside 0–100) makes the catalog invalid and blocks every test exit; the
`levels` key counts toward the catalog digest. The classes are `unit` (kinds `unit`, `coverage`),
`integration` (`integration`, `regression`, `contract`, `smoke`), `e2e` (`e2e`, `playwright`, `browser`,
`a11y`, `visual`), `static` (`typecheck`, `lint`, `code-size`, `design-system`), `benchmark` and
`custom` (runs only when named); a suite's `kind` can be a class or an older kind name, which is an
alias. The older multi-field `steps[].test_policy` is the previous spelling: a frozen change that holds
one is still read and judged by its kind names, and a step cannot declare it together with `test`.
Steps that still declare inline `tests[]` keep working: they run as before and are
judged together with the level (see the [default workflow](default-workflow.md)).

A kind that does not apply to the whole project is declared in the catalog instead of waived
per change: `test catalog not-applicable <kind> --reason <text>` writes
`not_applicable: [{kind, reason, approved_by}]` into `catalog.yaml` (`--rm` withdraws it), and
the declaration also satisfies the test class that kind belongs to. It
takes effect only after one human confirmation: `review request` lists it as
`not-applicable:<kind>` next to the plan's pending waivers, `review acknowledge` (not
`--delegated`) approves it and records the approver in `approved_by`; until then the level
still requires the class and reports `waiver-unapproved`. Changing the reason clears the
approval.

When a required step test has failed and the user decides to let it through, register a
step-test waiver with
`tenon test waive <change> --test <step-test-id> --reason <text>`. (The default `code-size` test has
no ceiling and does not fail on size; this applies once a project writes a `pass.metrics` ceiling
under it in its workflow.) The id must be a test declared by a step of the change's workflow, otherwise
the command exits 2 and lists the available ids; the step must declare a test level (or a legacy
policy) for the
waiver to be judged. It is the same mechanism as a kind waiver: it is written into the plan,
listed with its reason as `test:<id>` by `review request`, and approved together by the human
confirmation of that review gate; until then `waiver-unapproved` still blocks the exit. Wherever a
`test:<id>` waiver is listed (the `review request` checklist, the verification report, the reviewer
prompt and the `test-waived` hint), a second line gives the measured value read from the latest
failed record on the current candidate, such as `最新运行：lines_added=2810（上限 2000）` (latest run,
limit in brackets), or `当前候选上没有失败记录` (no failed record on the current candidate) when there
is none. It is read again each time, while the reason you wrote stays labelled as the registrant's
own claim and is never checked. After
registration `step.next` stops issuing `run-test` and goes on to the reviewers and
`request-review` as usual; the reviewer prompt (rendered in Chinese) carries a
`豁免（已批准|待评审批准）：<reason>` line (waiver, approved or awaiting review approval) under that
test's result. A waiver only covers a fresh failed record: a test that was not run, is running
or is stale keeps blocking, and a code change means running it again.
`test unregister <change> --waiver test:<id>` withdraws it.

`test discover` scans package scripts and tool configs (vitest, jest, mocha, node:test,
Playwright, tsc, eslint, pytest, go) and prints suggested suites with reporter flags that
produce parseable reports; `--write` appends the ones whose id is not yet in the catalog.
`tenon init` runs it for you when a workflow with a test level finds no catalog and says
so on stderr (nothing is written when no tool is recognised, and an existing catalog is never
touched). For JavaScript unit suites without an `include` in the tool config, the test-file
globs cover `src/`, `test/`, `tests/`, `__tests__/` and root-level `*.test.*` / `*.spec.*`
files (when none of those directories exists, any `*.test.*` / `*.spec.*` file below the
suite's `cwd`).
`*.bench.*` files in a vitest project become a `vitest-bench` benchmark suite whose metrics
are `<bench name>.mean_ms` for every `bench('name', …)` it can read (a name it cannot read is
never guessed); any other `bench` script is reported with the exact `catalog add` command to
register it, because a benchmark must declare its metrics and thresholds.
The bench command follows the project's vitest major version: the installed
`node_modules/vitest/package.json` (the nearest `node_modules` from the project directory up to
the repository root), and only when vitest is not installed the `vitest` range declared in
`package.json`. vitest 3 and 4 get `npx vitest bench --run --outputJson=test-results/bench.json`;
vitest 5 removed `--outputJson` (and the module-level `bench()` import: benchmarks are written as
`test('…', async ({ bench }) => { await bench('name', fn).run() })`), so vitest 5 and later get
`npx vitest bench --run --reporter=default --reporter=json --outputFile.json=test-results/bench.json`.
Both write `test-results/bench.json` and the suite keeps the `benchmark-json` report format; the
parser reads either shape into the same `<bench name>.mean_ms`, `.p99_ms` and `.hz` samples (vitest 5:
`latency.mean`, `latency.p99` in ms and `throughput.mean` in operations per second, taken from the
JSON reporter's `benchmarks[].tasks[]`; results replayed with `bench.from()` are not measured by the
run and are skipped), so the metric names declared in the catalog carry over; the two vitest
generations use different statistics engines and their numbers are not guaranteed to be comparable,
so rebuild the baseline (`tenon test baseline`) after a major upgrade. The bench name is the metric
name, so two benchmarks with the same name (or names that differ only in punctuation, which the metric
name drops) make the report fail to parse with the duplicate named, instead of one silently
overwriting the other; give every `bench()` its own name. When the major version cannot be
determined (vitest neither installed nor declared with a range that fixes one, such as `latest`,
`workspace:*`, `catalog:` or `>=3`; or the nearest `node_modules/vitest` has no readable `x.y.z`
version in its `package.json`, a half-finished install, in which case discover neither looks at a
farther install nor falls back to the declared range), discover does not write a benchmark suite, because a command that
is right for one major version exits `1` on the other: it prints a note with both `catalog add`
commands instead, so install the dependencies and run `tenon test discover` again or register the
suite by hand. On vitest 5 and later, a bench file that still imports the module-level `bench` from
`'vitest'` (`import { bench } from 'vitest'`, `import { describe, bench } from 'vitest'`, also a
multi-line import or a CommonJS `require`) is bound to fail with `bench is not a function`, so
discover does not write the suite either: it prints a note naming those files and the fixture form
(`test('…', async ({ bench }) => { await bench('name', fn).run() })`; options go second, as in
`bench(name, options, fn)`). Migrate the files and run `tenon test discover` again.
`catalog add --from <direction>` starts a suite from a test direction (bare tool
invocations are replaced by the runner's recommended invocation); `catalog validate`
lists every problem as `catalog.yaml:<line>: …` (exit `2`). `test plan --seed` creates the change's
plan when it is missing. For a step with a test level it writes no suites and no test files (the
level, the catalog and the change's diff decide what runs when the step is evaluated) and only
reports the required classes the catalog has no suite for, plus the scenarios and tasks still to map
when the level asks for mapping, with ready-to-run `register --case` commands. For a legacy policy it
still adds the suites that own or cover the files this change touched and one suite per required
kind, but no longer registers test files. Only scenarios and the tasks under the
implementation (`build`) section of `tasks.md` must be mapped (`scenarios: required|passing`
blocks on them); tasks in any other stage section are listed separately as optional (shown as
"optional", not "uncovered", in the verification report) and never block. The scaffold prompt
"break this stage into verifiable tasks" is not a task the author wrote: the seed, `test sync` and
`test plan` no longer list it, and the traceability matrix shows it as optional.
When the level does not ask for mapping (`scenarios: off`, the default), the matrix lists only the
rows already mapped and one line, "N more scenarios / tasks are not mapped (this step does not
require mapping)", and no `scenario-uncovered` blocker is raised.
`test register <change> --auto` is the one-command form for orphan test files: it discovers a
missing catalog, then looks only at test-like files this change added or changed (never the whole
repository, and never anything under `openspec/`, `.tenon/` or `.pipeline/`) that no suite's `files`
glob claims, and appends the exact path of each to the suite that fits (`e2e/` specs go to a Playwright
suite; helpers and `*.bench.*` files are not claimed automatically). It does not widen any glob, so
`tools/x.test.mjs` is added as that one path and no `tools/**` appears, and a file the change did
not touch stays untouched. It only adds, so it is safe to repeat; with no suitable suite it stops
with the `catalog add` command and writes nothing. `test sync` diffs the change against its start
and lists orphan test files (no suite claims them), registrations whose file is
gone, and registrations the catalog no longer claims (the suite left the catalog, or no
suite's `files` glob matches the path anymore; `--json` field `registeredButUnclaimed`); it
uses the same computation as the gate (exit `2` when something is pending).

Every command that writes the catalog (`catalog add|set|rm`, `catalog not-applicable`,
`register --auto`, and `init` into an existing catalog) edits only the lines of the nodes that
changed, at three levels: top-level keys, `suites` entries and keys inside an entry. New nodes are
appended at the end of their list or map, a removed node loses only its own lines (the comment
above it stays with what follows), and every other byte, comments and blank lines included, is kept.
An inline comment on a key you changed is the only thing lost. The new text is parsed again and must
equal the intended catalog, otherwise nothing is written. `discover --write` into a missing catalog
writes a new file as before.

Registrations only ever grow (`register` and `plan --seed` add, `sync` reports), and the
suite exit check expects every registration that names a suite to be executed whatever the
suite's globs say. So when a suite's `files` glob was widened and later narrowed again, the
files registered in between stay in the plan and block the exit
(`registered-test-not-executed`). `test sync <change> --prune` is the way out: it deletes from
the plan's `files` exactly the registrations the current catalog does not claim and keeps the
rest as they are. A registration is kept when its suite is in the catalog and that suite's
`files` glob matches the path, or, for a registration without a suite, when any suite's glob
does. A resource file registered with `register --file --kind` and no suite (a visual
snapshot, say) is kept: it never runs and never blocks. The output lists each deleted path
with the reason (no suite claims it, the named suite is not in the catalog, or the named
suite's `files` glob no longer claims it); `--json` prints
`{ change, digest, pruned: [{ path, suite?, reason }] }` with `reason` one of `no-owner`,
`suite-missing`, `glob-mismatch`. It only touches `files`: suites, the case mappings and
waivers stay, and it does not read the diff. Nothing to delete is a success (exit `0`, the
plan is not rewritten); a missing or invalid catalog, a catalog without any suite, a plan
that was edited by hand, or running as someone other than the owner is refused (exit `1`).
The write goes through the same locked, digest-recording path as `test register`, so the
plan stays readable by `test plan` and the exit check, and the change history gets a
`test:plan-write op=prune` line.

Why this cannot be used to drop a legitimate registration: a legitimate test file is always
claimed by its suite's glob, so it is only pruned after the glob in the catalog was changed
first, and a task's changed test configuration is listed in the review request for the user
to approve.

The start of a change is the merge-base with its base branch, or the last commit before
the change was created when working on the base branch itself; the diff includes staged,
unstaged and untracked files. When that diff cannot be read the gate blocks with
`files-diff-unavailable` (it fails closed, it does not degrade to a notice).

`test run` writes one v2 record per invocation (`.tenon/users/<slug>/tests/<change>/<run-id>.json`)
chained by `prev_digest`; editing a record breaks the chain and every v2 record of that
change counts as not run until a new run starts a fresh chain. Before a record's digest is computed, the
repository root (its logical and its real path, also as a `file://` URL, so `/var/…` and `/private/var/…`
spellings alike) in every string field, failed-case messages and stacks included, is rewritten to a
repository-relative path and your home directory to `~/`, so a committed record carries no
machine-specific absolute path. Local logs under `local/artifacts/` are not committed and stay as they were,
and records written by earlier releases are not rewritten. Records are tracked in the
repository by design (they are the evidence other people and CI read), so their number can be capped:
set `TENON_RECORD_RETENTION=<n>` and after each run only the newest `n` per user and Change are kept
(inline step tests always keep the newest 20 per test). By default nothing is pruned, because the previous
release (v0.2.1) cannot read a pruned chain (see "Compatibility with the previous release" in
[Updates, recovery and uninstall](updates-recovery-and-uninstall.md)).
When it is set, pruning removes the oldest prefix and leaves a `chain-base` marker next to the records naming the
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
(the step's stage run set: the suites its level runs for this change's diff, plus any suite the plan
adds explicitly with `register --suite`; `test: full` forces full runs and the same set is what
`status` and `check` evaluate). With no selection flag `--stage` is implied.
`--stage` runs catalog suites only: inline `tests[]` (suites whose id starts with `step:`)
stay on `tenon test run <change> <test-id>` and the summary lists the commands still to
run; a step whose level has nothing to run for this change says so and exits `0`, without
writing a record.
Declared services start once per invocation in their own process group, are probed
(URL, port or log text) and are reaped afterwards including grandchild processes;
a URL or port that already answers before start is refused, because the tests would
hit an old server. `parallel: true` suites run concurrently, the others one by one.
Reports are parsed per case: `junit`, `playwright-json`, `vitest-json`, `jest-json`,
`go-json`, `tap`; benchmarks read `benchmark-json` (also hyperfine and vitest bench output: the
`--outputJson` file of vitest 3 and 4 and the JSON reporter of vitest 5),
`k6-summary` and `lighthouse-json`; coverage reads `istanbul-summary`, `lcov` and
`cobertura`, and `changed_lines` is computed from the diff. A stale report from an earlier
run is deleted before each execution. A run fails on: no report (`report-missing`),
an unparseable report (`report-unreadable`), zero or all-skipped cases (`no-tests-ran`),
exit code and report disagreeing (`exit-report-mismatch`), a claimed or registered file or mapped case
that never ran (`registered-test-not-executed`; a file claimed by several suites only has to run in one of them),
coverage below the step's level
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
  digests of baselines and `known-failures.yaml` as written by Tenon commands, and your review
  approvals (trust decisions made before this release also live here and are honored only in a
  project that is not a git repository; in a git repository trust lives only in the trust store
  below). A chain whose head is not the sealed head (records written around `tenon test run`) is `record-unsealed`, has no approval path, and the next
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
- *First-run trust.* `tenon test run` refuses to execute a command you have not trusted on this
  machine. Trust is recorded per user, per repository and per command: every executable command
  has its own digest (a suite's `command`, `cwd`, `select.files` / `select.grep`, sorted `env` and the
  services it uses; for an inline step test its `command` and `cwd`), so editing one command asks
  again for that command only, and a label or `covers` edit asks for nothing. Only the commands a
  run is about to execute are checked, and the refusal (exit `1`, no record) lists just the untrusted
  ones, which is also what the `trust` object of `run-tests` shows. The repository identity is the real
  path of `git rev-parse --git-common-dir`, so every worktree of one repository shares the trust, and
  the checkout must appear in `git worktree list --porcelain`: a copied tree whose `.git` file points
  at a trusted repository gets nothing. The entries live in the user-level state directory
  (`<state>/test-trust/<user>.json`, signed with an HMAC key beside it, mode `0600`, at most 2000
  entries with the oldest dropped first), never in the repository, and an unreadable or tampered file
  counts as no trust. Only a checkout with no `.git` in its directory or any parent (not a git repository) falls back to
  the old seal in the checkout, and a `trusted[]` entry written there by an earlier release still trusts a catalog whose
  whole digest it lists; `tenon test trust` writes there too. A git repository never honors the old seal in the checkout,
  tracked or not: any file in a checkout, the seal and its HMAC key included, can arrive with the repository or an archive,
  and could carry a seal computed to trust itself, so any check that only looks at checkout content (such as "is it
  tracked by git") can be forged. Re-run `tenon test trust` once in your own terminal for commands you trusted in a checkout
  before; when the old seal lists the current whole digest, `tenon test run` prints one more line saying so. In a git
  repository with no user-level state directory `tenon test trust` fails instead of writing a checkout seal.
  A checkout that has a `.git` but whose repository identity cannot be read (git fails or times out, or the `.git` is a forged
  pointer) is untrusted: neither the user-level entries nor the old seal count, `tenon test run` tells you to
  fix git first, and `tenon test trust` refuses to write anything. `tenon test trust [<change>]` lists the untrusted commands and asks `[y/N]` in an
  interactive terminal (`--yes` for your own scripts, `--status` to show each command, exit `2` if
  any is untrusted, `--json`). CI sets `TENON_TEST_TRUST=1` explicitly; every run then prints a line
  saying trust came from the environment. The Tenon hook refuses an agent's shell call that
  contains `tenon test trust` or a `TENON_TEST_TRUST=` assignment, and any write into a
  `test-trust/` path, so the decision stays with you. Trust names a path, not file contents: a
  different repository cloned later at the same path inherits the command-level trust, the same
  level as pulling new commits into a trusted one.

**Test integrity.** `tenon test integrity <change>` answers one question: is the evidence weaker
than at the start of the change? It compares the change with its start (the same start as the
changed-files list) and reports ten signals, each with a subject and a one-line fact:

| Signal | Source | Fires when |
| --- | --- | --- |
| `case-count-drop` | run records | the latest full run of a suite has fewer cases than an earlier full run in this change |
| `skip-count-rise` | run records | the latest full run has more skipped cases than the first full run |
| `test-file-deleted` | diff | a test file is deleted (a delete plus a same-named file added elsewhere counts as a move) |
| `tests-removed` | diff | a modified test file declares fewer cases (`it(`, `test(`, `def test_`, `func Test…`, `@Test`, `#[test]` …) |
| `test-skipped` | diff | a skip marker is added (`.skip`, `xit`, `describe.skip`, `test.todo`, `@pytest.mark.skip`/`xfail`, `@unittest.skip`, `t.Skip`, `@Disabled`/`@Ignore`, `#[ignore]` …) |
| `assertion-weakened` | diff | cases are still there but assertion lines (`expect(`, `assert`, `t.Errorf`, `assert_eq!` …) were removed |
| `snapshot-rewritten` | diff | a snapshot file (`__snapshots__/`, `*.snap`, `*-snapshots/`) is modified, deleted or a binary snapshot changed; only adding snapshots is not a rewrite |
| `baseline-changed` | diff | anything under `.tenon/tests/baselines/` changed |
| `known-failure-added` | diff | `known-failures.yaml` gained a case |
| `coverage-threshold-lowered` | diff | a coverage threshold (`lines`, `branches`, `functions`, `statements`, `fail_under`, `threshold`, `target`) went down or was removed in a test-runner config, `pyproject.toml`/`setup.cfg`/`.coveragerc`, `package.json` or `.pipeline/workflows/*.yaml` |

All of them are text heuristics over `git diff -U0` and the run records: a signal says "worth a
look", not "tampered", and a renamed case or a swapped assertion library can still show up.
What a signal does is set per step: `notice` (the default, and the only mode a test level can have, so
every Track of the default workflow uses it) lists the signals as one
`test-integrity` notice in `test status`, `status` and the Dashboard Tests tab and never blocks;
`block` turns the same signals into one `test-integrity` blocker at that step, and an
unreadable diff then fails closed (`files-diff-unavailable`). Only a frozen legacy policy can still
say `integrity: block`; it has no per-signal waiver: restore the test.
The check runs only on steps whose level runs tests (`changed`, `full`) or whose legacy policy
runs tests or declares `integrity: block`. `tenon test integrity` exits `0` unless the step's mode is `block` and
there is a signal (or the diff cannot be read): then `2`. `--step` picks another step's policy;
`--json` prints `{ change, step, pass, mode, state, signals[], truncated? }`. At most 400 relevant
files are read; beyond that a `files-truncated` notice says so.

`test status` reports each declared test of the step with the same evaluation the
transition uses, so a status pass is a transition pass; with `--json` a step that declares
a test level also carries a `policy` object (the level and its effective requirements, blockers with
fix commands, notices, suites, the scenario/task trace, claimed files and orphans, and the record chain
state). It exits `2` while
anything blocks. A record goes stale when the candidate code, the catalog entries of the
suites it ran, the plan, the step's level definition or the workflow fingerprint changes; a record
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
`code-size` direction and prints one JSON line of metrics (`files_changed`, `lines_added`,
`lines_deleted`, `largest_added_lines`). It counts source files only: the
same path scope as the workspace candidate (no `openspec/`, `.tenon/`, `.pipeline/`,
`docs/`, dependencies or test caches) and no Markdown files. The direction and the default workflow
set no ceiling, so exit code `0` is a pass and the `code-size` reviewer judges the numbers; the
measured values are recorded in the run record even without a ceiling, and the reviewer reads them
in its prompt. A project that wants a limit adds `pass.metrics` (for example `lines_added` with a
`max`) under the test in its workflow YAML, and a run over it fails with `metric-threshold`.
`test diff-risk` is the
probe behind the builtin `diff-risk` direction, the risk gate of the `lite` Track
([Routing and execution modes](routing-and-workflows.md#the-lightweight-track)). It only reads
the repository and prints one JSON line measured from the task's starting point (committed
and uncommitted changes both count): `files_changed` (source files, same scope as
`code-size`), `contract_files`, `auth_files`, `dependency_files` and `migration_files`
(files in those path classes: OpenAPI/proto/GraphQL/schema and `contract` names; auth,
login, session, jwt, password, permission, crypto and secret names and `.env*`; package
manifests and lock files; migration directories), `deleted_tests` (deleted test files) and
`protected_test_files` (changes to the test catalog, baselines, known failures or project
workflows; the catalog that `tenon init` generated for a project that had none is not
counted). The thresholds are not in the command: they are the `pass.metrics` of the
workflow's `diff-risk` step test, so changing a limit is a workflow YAML edit. The task name
is the argument or `TENON_CHANGE_NAME`.

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
closed `next` action list to execute in order. `run-tests` and `run-test` carry a
`trust` object when some of the commands they are about to run have not been trusted by the user
yet (it lists only those; trust is shared by every worktree of the repository; ask the user to run
`trust.command` in their own terminal first). `test-register-files` appears only when orphan test
files exist, with one `tenon test register <change> --auto`, and `test-plan-map` only for a required
class the catalog has no suite for or a level that asks for scenario mapping. A `transition`
carrying `escalate` means the task has outgrown its Track: the lightweight Track's risk probe
failed, `escalate.reasons` names the breached limits, and `escalate.then` gives the heavy-Track
`tenon init` command to run after the transition, followed by `tenon set <new> depends_on <old>`.
A `finish-change` action carries `command` (`tenon task finish <name>`) and, after it, the `commit`
to make.

`step.documents` has `mode: "observed"` for a new Change: `observation` (`observed`,
`unavailable` or `truncated`), `inputs` (`path`, `from_step`, `skill`, `status` `read` or
`unread`), `outputs` (`path`, `change` `added`, `modified` or `deleted`, `skill`) and
`required` (`path`, `status` `produced` or `missing`, one per `required-output` of the
step). Its only document action is `read-documents`, listing the unread inputs in
`documents` with a `note` that the step may change them and the change is recorded as its
output; a missing required output is a `fix`. For a Change created before the upgrade
`step.documents` has `mode: "contract"` with the `reads`, `records` and `updates` tables
and `next` may also carry `scaffold-document`, `record-document` and `register-field`.

```text
tenon step run <change> [--json]
```

`step run` performs the deterministic part of `step.next` in one call and says what it
did: `read-documents` (`document read <change> all`) and `test-plan-seed`
(`test plan <change> --seed`); for a Change created before the upgrade also
`scaffold-document` (`document scaffold`) and `record-document` (`document record`,
only when the file exists and its skeleton placeholders are replaced). It
stops at the first action that needs the host or the author (loading a skill, dispatching
an agent, writing document content, running tests, review, transitions) and prints why,
together with the fresh `step.next`, so no `status` call is needed afterwards. It is
idempotent: with nothing to do it changes nothing and exits `0`; a refused command exits `2`
and keeps what was already done. `--json` prints `{ change, step_id, did[], stopped, step }`.

```text
tenon spec apply <change> [--dry-run] [--json]
```

`spec apply` rehearses `openspec validate --strict`, `openspec archive` and a
per-capability strict re-validation inside a temporary copy of `openspec/`, then
writes only the changed main spec bytes back under a compare-and-swap and records
`applied-spec.md`. `--dry-run` writes nothing but the receipt. Exit codes: `0`
pass, `1` usage or state, `2` validation or rehearsal failed, `3` no `openspec`
on PATH, `4` a main spec changed during the rehearsal.

## CI verification and evidence export

```text
tenon verify --ci (--change <name> | --all-open | --since <ref>) [--step <id>]
                  [--format text|json|sarif|markdown] [--out <file>] [--also <format>=<file>]…
                  [--candidate error|warn|off] [--require-anchor]
tenon evidence export <change> --format agent-trace|otel|git-notes|trailer
                  [--out <file>] [--commit <rev>] [--user <slug>] [--apply] [--anchor]
                  [--contributor human|ai|mixed|unknown] [--model <provider/model>]
```

`tenon verify --ci` runs where there is no local HMAC key: it re-derives, from committed files only,
the record chain of every user directory, record consistency, the plan, records and catalog
agreement, the case-level verdicts under the policy of the Change's current step (or of `--step`),
the candidate tree against the checkout, the review approval lines for changed protected test
configuration, and the anchors in `refs/notes/tenon`. Exactly one selector is required: `--change`
(active or archived), `--all-open`, or `--since <ref>` (the Changes touched since the merge-base with
`<ref>`). Without `--ci` the command exits `1`. It takes no lock and writes only the files named by
`--out` and `--also`. Exit codes: `0` no error finding, `2` at least one error finding, `1` usage or
environment error. The report always states what CI cannot prove without the local key. Formats:
`text`, `json` (`tenon-verify-ci/v1`), `sarif` (2.1.0 for GitHub code scanning) and `markdown` (job
summary); with `--out`, stdout still prints the text summary. `--candidate warn|off` relaxes the
workspace fingerprint comparison, `--require-anchor` demands an anchor note equal to the chain head.
Details, findings and the GitHub Action are in [CI verification](ci-verification.md).

`tenon evidence export` turns a Change's evidence into other tools' formats. `agent-trace` is an
Agent Trace v0.1 record (the contributor is `unknown` unless asserted with `--contributor`/`--model`),
`otel` is OTLP/JSON spans following the OpenTelemetry GenAI conventions (no network export),
`git-notes` is the JSON note on `--commit` (default `HEAD`) in `refs/notes/tenon`, and `trailer` is the
`Tenon-Change:` and `Tenon-Evidence:` lines. Everything prints by default; `--apply` writes the note
(`git-notes`) or amends `HEAD` with the trailers (`trailer`) and is rejected for the other formats.
`--anchor` (git-notes only) records the chain head as an anchor that `verify --ci` checks. A broken
or empty record chain exits `2`; usage errors exit `1`.

## Documents, artifacts, and review

```text
tenon document read <change> <path|all>
tenon document status <change> [--json]
tenon review request <change> --event <event>
tenon review acknowledge <change> [--delegated] [--as reviewer]
tenon review revoke <change> --reason <text>
tenon agent next <change> [--json]
tenon agent prompt <change> <agent> [--host <id>] [--rerun-reason <text>] [--json]
tenon agent record <change> <run-id> [--subagent <type>] [--host <id>] [--json]
tenon agent list [--role executor|reviewer] [--source official|custom|project] [--json]
tenon agent show <name> [--json]
tenon agent new [<name>] --role <role> --description <text> [--skills a,b] [--tools A,B] [--model <m>] [--hosts a,b] [--host codex|claude|any] [--scope user|project] [--from <agent>]
tenon agent add <file> [--scope user|project] [--replace]
tenon agent validate <file|name>
tenon agent copy <from> <to> [--scope user|project]
tenon agent rm <name> [--scope user|project]
tenon agent export <name> --host claude|codex
```

For a new Change nothing is registered: Tenon records the files a step added, modified or
deleted, and the Skill that wrote each, when the step is left. `document read <change> all`
(or one handed-over input path; a path outside the project exits `1`) hashes the current
content and writes the read receipt for the step's inputs. `document status` prints the
step's inputs (`READ` / `UNREAD`), outputs and required outputs, `--json` prints
`{ change, workflow, mode, observation, inputs, outputs, required }`, and the exit code is
`2` while an input is unread or a required output is missing. A transition with an unread
input exits `1`; one with a missing required output exits `2`. See
[documents, Skills, and evidence](documents-skills-and-evidence.md).

Only for a Change created before the upgrade (a new Change refuses `document init`,
`scaffold`, `record` and `migrate-delta` with exit `2` and `artifact register` with exit `1`,
saying that the outputs of the task are recorded automatically):

```text
tenon document init <change>
tenon document scaffold <change> <kind> [--capability <capability>]
tenon document record <change> <kind> <path> --producer <skill-id>
tenon document record <change> --all [--producer <skill-id>]
tenon document read <change> <kind|all>
tenon artifact register <change> <field> <path> --producer <skill-id>
```

`document record --all` records every document of the current step whose file is already
written, one `document record` each with all its checks (placeholders, the producer's skill
receipt, owner, archive gate): documents the step produces and still lacks or has gone
stale, inputs the step may edit that changed since they were recorded, and documents an
invoked skill still owes. The producer is the one the step accepts that was invoked in this
visit (`--producer` overrides it). Documents that are up to date are left alone, documents
not written or still holding `[待填写…]` placeholders are listed and skipped, and a
document whose path the author must name (a delta spec without `--capability`) is skipped;
only a refused record exits `2`.

Reviewers can declare `attach_on` in their agent file
(`auth`, `dependency`, `contract`, `migration`): they join a step's reviewer set only when
the task's changes touch such a path, so `agent next`, `status --json` and the Dashboard do
not list an unattached reviewer and `agent prompt` refuses it with exit `2`.

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

**Cross-vendor review.** A reviewer in a workflow step can declare `host: codex | claude | any`
(Claude writes, Codex reviews), and an agent definition may suggest one with its own `host:`
line (`tenon agent new --host`). The step's declaration is binding, the agent's suggestion only
routes, and `host: any` on the step overrides a suggestion. When the host that runs
`tenon agent prompt` is not the required one (or when no host is detected: a plain terminal), the
run row is still created, but the prompt is written to
`openspec/changes/<change>/.pipeline-agent-reports/<run-id>.prompt.md` and Tenon prints the exact
commands instead of the prompt:

```text
[ROUTE] reviewer 'security' must run on codex … current host: claude
prompt: openspec/changes/demo/.pipeline-agent-reports/<run-id>.prompt.md
run: codex exec --sandbox workspace-write - < <prompt file>      # or: claude -p --allowedTools "…" < <prompt file>
record: tenon agent record demo <run-id> --host codex
```

With `--json` the same information is in `host`: `{ required, source: step|agent|none, enforced,
current, run_on: { host, command, prompt_file, record } | null }`, and the full `prompt` is still
returned. Tenon never starts the other vendor's CLI itself: you, or the agent in the current host,
run the command. `tenon agent record` stores the host that ran the review (`host`) and how it
knows (`host_source`: `detected` from the process environment, or `declared` with `--host`, which is
how an orchestrating host records a review it ran through the other CLI). The verdict is bound to
the candidate (the content hash of the reviewed code) as before: a candidate change during the
review refuses the record, and a later change makes the verdict stale. When the step requires a
host, a record whose host differs, or is unknown, is refused (`exit 2`, nothing written), and a
record that is in the ledger anyway (written around the command, or from before the requirement)
is not a verdict: `agent next`/`status` show `wrong_host`, the state is `stale`, the exit is
blocked with `reviewer-wrong-host`, and such runs do not count as "a verdict exists", so rerunning
on the right host needs no `--rerun-reason`. The host is a claim by the recorder (the same trust
model as the rest of the ledger), not a cryptographic proof. `agent next --json` and
`status --json` (`step.reviewers[]`) carry `required_host`, `host`, `host_source`, `wrong_host`
(and `route_host` in `status`), and `run-agent` actions carry `host` when the reviewer should run
elsewhere. Scoping by `attach_on` comes first: a reviewer that is not attached to the task is not
listed, routed, waited for or checked for its host, so it never reports `reviewer-wrong-host`; the
host rules apply to the reviewers that are attached.

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

`review revoke <change> --reason <text>` withdraws an approval given by mistake. It turns the current step's approved, not yet consumed receipt back into a pending one for the same event (same `requestedAt` and binding), rewrites the review marker so the gate holds again, and appends a `review.revoked` row (actor, reason, receipt id, event) to the change history. Only the task owner may run it, and `--reason` is required (one line, at most 200 characters). It refuses and writes nothing when the reason is missing, when the receipt is already pending, when there is none, or when a transition already consumed it (exit `1`). If the decision state changed after the approval, the next `review acknowledge` fails on the stale binding; run `review request` for the same event to refresh it.

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
`test:protected-approve` line. Once a step's verification rounds are used up, the same
frozen list also carries the required reviewers that still fail as residual blockers;
see [Verification round limit](#verification-round-limit).

The `tasks.md` skeleton of a new Change, the document skeletons of a Change created
before the upgrade, and project-level spec scaffolds default to Chinese. English
is explicit (`document scaffold` only serves Changes created before the upgrade):

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
tenon tracks show <workflow>:<track> [--json]
tenon init <change> --workflow <workflow> --track <track> --preset <preset>
```

`tenon tracks` is read-only and lists the Tracks of every Workflow the project can
use, with columns `WORKFLOW:TRACK`, `LABEL` and `ROUTABLE`. A Track is a branch of
a Workflow: whether `--track <track>` may be used with `--workflow <workflow>` is
decided solely by whether that Workflow's YAML declares the branch under
`tracks:`. To add a Track, declare the branch in the Workflow file (or in the
Dashboard workflow page), not through a separate registry command; the built-in
registry and `.pipeline/tracks.yaml` are not read. A flat Workflow is its own
single Track, so `tenon init` takes no `--track` for it.

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

Whether a Change may enter AFK is read only from the `automation.eligible` of the Track it
was created on. A Track with no `automation` block (every flat Workflow included) is not
eligible: `tenon afk enqueue` exits `3`, and with `--json` reports
`reason: "track-not-afk-eligible"`. A Track with `enqueue_after_spec: true` queues the
Change automatically when its spec is done (the `pm` Track of `default`).

## Support, logs and language

```text
tenon support bundle [--out <path>] [--json]
tenon logs [--follow] [--lines <n>]
```

`support bundle` writes a local redacted `.tar.gz` (default
`~/tenon-support-<time>.tar.gz`, mode `0600`, at most 5 MiB): versions,
`doctor`, `runtime status`, a configuration summary (key names and counts, never
values), the recent Dashboard server log and hook timings when recorded. Tokens,
API keys, cookies, session/login codes, private keys, URL passwords, emails, home
paths and user names are removed before writing; the command prints each entry,
what was truncated (logs keep their newest part) and how many items were
redacted. Nothing is uploaded. `--json` prints the same facts for scripts.

`logs` reads `<state>/logs/dashboard.log` and its rotations (`.1`, `.2`, 1 MiB each,
three files in total). The server mirrors its stdout/stderr there with credentials
redacted before they reach disk. `--lines` defaults to 100; `--follow` polls for new
lines and survives rotation until Ctrl+C.

Output language: `TENON_LANG=en|zh`, then `LC_ALL`, `LC_MESSAGES`, `LANG`. No
signal, or `C`/`POSIX`, keeps the historical Chinese output (hooks pin `LC_ALL=C` for
stable text). Every command and option description has an English text, usage errors
and the most common errors are catalogued in both languages (stable message codes,
see `packages/cli/src/i18n/`), and JSON fields, `ERROR:`/`WARN:` prefixes and exit
codes never depend on the language. `tenon verify --ci` (all four report formats and its usage errors) is fully
catalogued; see [CI verification](ci-verification.md). The cross-vendor review lines (`agent prompt` `[ROUTE]` routing, the `agent record` host refusal and its `declared` note), the `agent next` lines (roles, states, rerun and host notes), the other `agent prompt` / `agent record` errors, and the `review request` / `review acknowledge` success lines, usage errors and warnings are catalogued as well. Strings not yet in the catalog stay in Chinese.

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
tenon assess --help
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
