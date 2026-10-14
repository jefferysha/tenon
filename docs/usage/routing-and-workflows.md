# Routing and execution modes

## Goal

Understand why a request creates no Change, is assessed first, goes straight to a heavy Track, or
asks you to pick a Workflow.

## Prerequisites

- installed and trusted hooks
- familiarity with the terms Change, Workflow, and Track

A **Workflow** is the graph of steps, transitions, gates, Skills, and guards (including the
`required-output` guard for files a step must write). Its YAML is the only definition of how a task runs. A **Track** is one branch of a Workflow
(`tracks.<id>` in the YAML) with its own steps, spec method, routing words and automation settings.
A Track is identified by the pair Workflow + Track id, and there is no other kind of Track. A flat
Workflow (no `tracks:`, such as `design-system`) is its own single Track, so `tenon init` needs no
`--track` for it.

Only two Workflows are built in. `default` has four Tracks:

| Track | Label | Use | Spec |
| --- | --- | --- | --- |
| `lite` | Lightweight | fixes, small changes, typo-level edits | none; one review gate |
| `pm` | Product | research, PRD, product work | OpenSpec |
| `frontend` | Frontend | UI work | OpenSpec |
| `backend` | Backend | services, APIs, data; also the fallback | OpenSpec |

`tenon tracks list` lists the Tracks of every Workflow the project can use.

## Decision model

Routing decides only whether a request is development work and which domain it belongs to. It does
not decide how heavy the work is from a keyword: the lightweight Track is offered as a candidate and
the expected change set decides.

| Outcome | Selection rule | What happens |
| --- | --- | --- |
| Discussion | pure explanation/question, slash command, notification | no Change |
| Named | the message names a Track (“use the backend track”, `--track backend`) or a Workflow | used as named, no assessment |
| Heavy signal | the request matches the `route.exclude` words of the lightweight Track (by default architecture, cross-module scope, migration, schema, database, authentication, dependency upgrade, release, deployment, full stack, research, PRD) | the domain's heavy Track directly, no assessment |
| Assess | any other development request | assessment first; the candidates are the lightweight Track and the domain's heavy Track |
| Select | the top score is tied, or the top-scoring Track belongs to a custom Workflow | you choose a Workflow + Track pair |
| Fallback | a request matched a Track's keywords but its own exclusions blocked it and no other Track claims it | the Track with `route.fallback: true` (`backend` in `default`) |

Routing uses deterministic keyword matching, exclusions, scores and priorities. It is not semantic AI
intent classification. When the choice is ambiguous, the correct behavior is to ask, not guess. A
request that matches no Track but looks like code work (a source path, backticked code, a function
call, or words such as function, module, test, bug, error) is not silently ignored: the router prints
one line saying it is not governed and how to start a task after assessing it. Pure discussion
prompts are never nudged.

The dispatch the router injects carries the decision:

```text
<tenon-dispatch>
action: invoke-skill
skill: tenon
workflow: default
track: backend
track_basis: score
intent: new
assess: required
candidate: workflow=default;track=lite
candidate: workflow=default;track=backend
```

`track_basis: user-named` marks a Track the user named. `assess: required` means the Change must not be
created before the assessment, and the `candidate` lines are the Tracks to choose between.
`selection_required: true` (again with `candidate` lines) means the user picks a Workflow + Track
pair before anything is created.

### Routing data

Routing rows come from the Workflow files: every Track with a `route` block (`keywords`, `exclude`,
`priority`, optional `fallback`) is a row, from the project's `.pipeline/workflows/`, then the global
store, then the plugin templates. A Track without `route` is never chosen by score but can still be
named. The generated table is cached as `.pipeline/cache/router.v6.data` and rebuilt when its schema
version or the content of any Workflow file changes, so a Workflow saved on the Dashboard routes the
next message by its new rules. An older cache is discarded and rebuilt. A broken Workflow file is
skipped with a one-line warning and the other Workflows keep routing. The cache is bounded plain data
that the bash hook reads and never evaluates, and routing stays fail-closed.

`.pipeline/tracks.yaml` and the former built-in Track registry are not read any more. If the file
exists, Tenon prints one line saying so; move its rules into the `route` of the Workflow branches
(see [custom Workflows and Tracks](custom-workflows-and-tracks.md#add-a-track)).

## Assess before you create the Change

For an `assess: required` dispatch the agent reads the relevant code, lists the files it expects to
change and runs

```bash
tenon assess --files <path>...
```

then shows you the result and its recommendation. Only after you confirm does it run `tenon init`; in
continuous or AFK mode it takes the recommendation. When it picks the lightweight Track it passes
`--domain <track>` with the dispatch's other candidate, so a later escalation can open the right heavy
Track directly. A manual `/tenon <request>` is a slash command, so the router leaves it alone and the
`tenon` skill decides the same way: a Workflow or Track you name wins, a heavy signal goes to the
domain's heavy Track, and any other development request is assessed first. A project-defined Workflow
is used only when you name it.

`tenon assess` classifies paths with exactly the rules and limits of the risk probe below; it reads no
file contents. Without `--workflow` and `--track` it assesses the `default` Workflow's `lite` Track.

| Exit | Meaning |
| --- | --- |
| `0` | within the lightweight limits; recommends the lightweight Track |
| `3` | over a limit; lists the breached limits (for example `auth_files 1 > 0`) and recommends a heavy Track of the same Workflow |
| `1` | error: no `--files`, a path that is absolute, contains `..` or leaves the repository through a symlink, or a Track that declares no `diff-risk` thresholds (“this track has no change-risk thresholds”; Tenon does not guess them) |

`--json` prints `{ workflow, track, metrics, exceeded, reasons, recommendation }` on stdout; errors go
to stderr.

## The lightweight Track

`lite` is the Track for work that is neither a heavy signal nor larger than the limits: fix a bug,
add a function, refactor a module, correct a typo. It has no OpenSpec lifecycle (`spec: none`) and
declares no required output; Tenon still records what each step wrote and hands the previous step's
documents to the next one:

```text
open → build → verify → done
```

and a separate terminal `escalated` reached from any of the first three steps through `scope-expanded`.

| Step | What happens | Evidence |
| --- | --- | --- |
| `open` | restate the goal and the acceptance check in one sentence; no exploring, no interview skills | none |
| `build` | `test-driven-development`, then the suites the change touches (`test: changed`) and the `diff-risk` probe | touched suites run, changed test files executed, probe passing |
| `verify` (review gate) | `verification-before-completion`, the unit-class suites in full plus the other classes the change touches (`test: full`), the required reviewers `code-review` and `security`; the user's single confirmation | tests, reviewers, human confirmation |
| `done` / `escalated` | terminal; `done` moves the task to `openspec/changes/archive/` and commits the whole workspace once (`chore(tenon): finish <change>`); `escalated` is archived without a commit | |

The test levels are the ones the heavy Tracks use for Build and Verify (see the
[default workflow](default-workflow.md)): unit-class suites are the only mandatory class, the others
run when the change touches them, and test files the change adds are claimed by the catalog's
globs instead of being registered. `code-review` is required with `block_at: medium`; it
reads the diff against the goal and acceptance check the host writes at the end of its prompt, not a
spec. `security` declares `attach_on: [auth, dependency, contract]` and so joins only when the task's
changes touch such a path. The track never pushes and never opens a pull request; that stays your
decision. Measured on the integration test (`lite-track.integration.test.ts`, a three-file bug fix):
at most 25 `tenon` calls and two user replies (trusting the test commands once, confirming `verify`);
a small heavy-Track backend change takes 70–90 calls and 6 or more replies.

### Risk escalation

Assessment is a forecast; the probe is the safety net. The `build` step declares a required
`diff-risk` step test (`tenon test diff-risk --json`) whose `pass.metrics` are the limits, all
editable in the Workflow YAML. `tenon assess` reads the same metrics:

| Metric | Default limit | Breached when |
| --- | --- | --- |
| `files_changed` | 8 | more source files changed than the limit |
| `contract_files` | 0 | an OpenAPI, proto, GraphQL, schema or `contract` path changed |
| `auth_files` | 0 | an auth, login, session, jwt, password, permission, crypto or secret path (or `.env*`) changed |
| `dependency_files` | 0 | a package manifest or lock file changed |
| `migration_files` | 0 | a migration path changed |
| `deleted_tests` | 0 | a test file was deleted |
| `protected_test_files` | 0 | the test catalog, baselines, known failures or a project workflow changed |

When the probe fails, `tenon status --json` (and `tenon step run`) stops asking to finish the step
and returns a single `transition` for `scope-expanded` with an `escalate` payload: the breached limits
in `reasons`, and in `then` the command to open the heavy-Track Change and link it. If the lightweight
Change recorded a domain (`tenon init --domain`), `then` is
`tenon init <new> --workflow default --track <domain> --preset full`
followed by `tenon set <new> depends_on <old>`; without a recorded
domain it lists the possible Tracks for you to choose. A probe that has not run, or is stale, is an
ordinary required test, so a direct `build-complete` is refused: the probe is a gate, not advice.
`scope-expanded` itself is an abandon edge: leaving through it needs no unit run, reviewer, document or
skill evidence, the Change ends with the result Escalated and is archived, and the workspace is left
uncommitted for the new Change to adopt. Do not split a change or hide files to get the probe to pass.

## How a task ends

Every task ends the same way: its directory moves to `openspec/changes/archive/<date>-<name>/` and the
result is recorded as Finished, Escalated or Terminated. The Workspace lists these under Ended.

- `tenon task finish <change>` for a task whose state machine reached its end (Finished, or Escalated).
  `step.next` hands it out as the `finish-change` action. For a Track with `spec: openspec` Tenon runs
  `openspec archive <change> --skip-specs --yes --json` itself; for `spec: none` it moves the
  directory in place, adding `-2`, `-3` to a name already archived on the same day.
- `tenon task terminate <change>` for a task you give up before it ends: the result is Terminated,
  only the task directory is committed (`chore(tenon): terminate <change>`) and the code it changed is
  left for you. A terminated task cannot be resumed; open a new task and link it with `depends_on`.

There is no hiding: the former `archive` and `unarchive` subcommands of `tenon task` no longer exist and
exit `1` with a pointer to these two commands.

## Custom Workflow selection

Create or save a valid project Workflow at:

```text
.pipeline/workflows/<name>.yaml
```

Declare Tracks as branches under `tracks:`; give a branch a `route` block and the router offers it as a
candidate. Because the top-scoring branch then belongs to a custom Workflow, the router asks you to
select a Workflow + Track pair instead of choosing for you. Then initialize a Change explicitly:

```bash
tenon init <change-name> \
  --workflow <name> \
  --track <track> \
  --preset full
```

A flat Workflow takes no `--track`. `tenon init --workflow standard` and `--workflow simple` fail and
name `--workflow default --track lite`; the retired Track ids `standard`, `simple`, `chat` and `free`
given to `--track` fail and list the Tracks the Workflow offers.

`default` and `design-system` ship as templates: a project or user-level file with the same name
overrides them (that is how the lightweight limits are changed).

## Explicit resume

Recent modification time is not a routing authority. Resume a known Change by
name in the request or:

```bash
tenon session activate <change-name>
```

When multiple candidates exist and none was selected, do not guess.

`tenon session activate <change-name> --host-session <id>` creates an exact
host-session binding. A later “continue” in that conversation resolves this
binding before the per-user `active-change` candidate, so another
conversation cannot hijack the resume target. If a host supplies a session id
but that new conversation has no valid binding, generic “continue” fails closed
instead of falling back to the per-user `active-change`. An explicitly
named Change still has the highest priority. This sidecar identifies the
conversation and powers liveness only; it never participates in canonical
guards or transitions.

A Change created before an upgrade keeps the Workflow snapshot it froze, including an old `standard`,
`simple`, chat or free Change: it finishes under the rules it started with.

## Expected result

The selected Track has a stable Workflow/Track identity and every surface derives its steps from the
same effective plan.

## Verification

```bash
tenon status <change-name> --json
tenon tracks show <workflow>:<track> --json
tenon assess --files <path>... --json
```

Inspect the Dashboard Progress view to confirm its step graph matches status.

## Common failures

### A one-line task uses a heavy Track

Line count does not define risk. Check whether the request matches a `route.exclude` word of the
lightweight Track (API, schema, dependency, security, release), or whether `tenon assess` reported a
breached limit.

### A request got no governance at all

Check whether the router printed the one-line “not governed” notice: it appears when no Track
matched but the prompt looks like code work. Assess the change with `tenon assess --files <path>...`
and create the Change with `tenon init`, or name a Track in the prompt. Discussion-shaped prompts
(“why …”, “what is …”) are never routed and never nudged.

### Routing ignores my Workflow

A Track is a routing row only if it declares `route.keywords`. Save the Workflow, then send the next
message; the table is rebuilt from the file content. `tenon tracks list` shows the `ROUTABLE` column.

### A three-step Workflow has no OpenSpec documents

Workflow length does not imply documents, and a Workflow creates none itself: the Skills of each step
write what their own `SKILL.md` says. Add `openspec: true` (or `spec: openspec` on the branch) only for
the OpenSpec lifecycle (the `tasks.md` skeleton, delta-spec validation and application, the OpenSpec
archive), and a `required-output` guard on every step that must leave a file behind. See
[documents, Skills, and evidence](documents-skills-and-evidence.md).

## Next action

Read [custom Workflows and Tracks](custom-workflows-and-tracks.md) or
[documents, Skills, and evidence](documents-skills-and-evidence.md).
