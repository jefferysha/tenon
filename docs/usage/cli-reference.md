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

## Tests

```text
tenon test run <change> <test-id> [--json]
tenon test status <change> [--step <id>] [--json]
tenon test baseline <change> <test-id> --run <run-id>
tenon test report <change> [--step <id>] [--write <path>] [--locale zh-CN|en]
tenon test code-size [--base <ref>]
```

A step declares the tests it needs in the workflow YAML. Only a run through
`tenon test run` produces a record, so an agent's own test run never satisfies a
required test. Tenon executes the declared command in its own process group,
records the exit code, duration, actor, input digests and output files under
`.tenon/users/<slug>/tests/<change>/<run-id>.json`, and keeps the log plus copies
of the declared outputs in the gitignored per-user local directory. Exit codes:
`0` pass, `2` fail (the record is written), `1` usage or environment error (no
record). The command receives `TENON_CHANGE_NAME`, `TENON_TEST_ID`,
`TENON_TEST_RUN_ID`, `TENON_TEST_ARTIFACTS` and `TENON_BASE_BRANCH`.

`test status` reports each declared test of the step with the same evaluation the
transition uses, so a status pass is a transition pass; it exits `2` while a
required test is failed, stale, missing or running. A record goes stale when the
candidate, the test declaration digest or the workflow fingerprint moves.
`test baseline` promotes the metrics of one passing run to the acting user's
baseline and keeps the previous value in its history; baselines are per user
because benchmark numbers depend on the machine. `test report` generates the
tests section of the verification report from the records and, with `--write`,
replaces the marked region in an existing repository file. `test code-size` is
the deterministic probe behind the builtin `code-size` direction and prints one
JSON line of metrics. It counts source files only: the same path scope as the
workspace candidate (no `openspec/`, `.tenon/`, `.pipeline/`, `docs/`,
dependencies or test caches) and no Markdown files.

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
tenon review acknowledge <change> [--delegated]
tenon agent next <change> [--json]
tenon agent prompt <change> <agent> [--host <id>] [--json]
tenon agent record <change> <run-id> [--json]
```

`tenon agent` drives the executors and reviewers a step declares. Tenon only
orders them, renders the handoff, records the verdict, and binds it to the
candidate; the host runs every model. `next` returns the current wave, `prompt`
starts or resumes one agent and prints its handoff, and `record` reads the
trailing ```tenon-result``` block of the report. A reviewer never reports its own
verdict: Tenon derives pass or fail from the finding severities and the step's
`block_at`. Human `review request/acknowledge` remains a separate exact-event
confirmation boundary and may be combined with reviewers.

`review acknowledge` exit codes: `0` approved, replayed, or approved with a
review-marker cleanup warning; `2` no matching pending review (missing, already
consumed, stale binding, or the event is no longer a workflow exit); `3`
revision conflict (Dashboard CAS path only); `4` idempotency conflict; `1`
invalid command (for example an `--event` that differs from the pending
receipt) or unexpected error. A failed acknowledgement writes nothing.

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
live in the global agent library and are frozen into
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
