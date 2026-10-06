# Routing and execution modes

## Goal

Understand why a request creates no Change, uses simple, enters default, uses a
free Track, or selects a custom Workflow.

## Prerequisites

- installed and trusted hooks
- familiarity with the terms Change, Workflow, and Track

A **Workflow** is the graph of steps, transitions, gates, Skills, artifacts, and
optional document contract. A **Track** is a routing, coverage, Skill-profile,
and automation overlay applied to the selected Workflow.

## Decision model

| Outcome | Selection rule | Governance |
| --- | --- | --- |
| Discussion | Pure explanation/question, slash command, notification | No Change |
| Simple | Positive bounded-edit signal and no exclusion | `simple` Track locked to `simple` Workflow |
| Standard | Implementation-shaped request without a heavy signal | built-in `standard` Track locked to the `standard` Workflow ([The standard lane](#the-standard-lane)) |
| Default | Normal PM/frontend/backend work | Matching Track, normally `default` Workflow |
| Free | Explicit user choice only | `free` Track on the selected Workflow |
| Custom | Explicit named Workflow/selection | Selected Track plus authored Workflow |

Routing uses deterministic regular-expression signals, exclusions, scores, and
priorities. It is not semantic AI intent classification. When a custom choice is
ambiguous, the correct behavior is to ask/select explicitly, not guess.

A prompt that starts with `/` is an explicit command, so the router leaves it alone and injects no
dispatch. `/tenon <request>` therefore runs the `tenon` skill directly, and the skill chooses the lane
the same way the router would: a workflow or Track the user names wins, an implementation request
uses `standard`, only heavy or cross-domain work (architecture, auth, migrations, dependencies,
contracts) uses `default`, and a project-defined Workflow is used only when the user names it.

The packaged simple main path is exactly:

```text
change → verify → done
```

`verify` is a real verification step, `done` is its successful terminal, and
`escalated` is the separate terminal used when the task outgrows simple scope.

## Simple boundaries

Typical positive signals include a typo, copy/comment change, unused import,
formatting, or a narrowly identified configuration value.

Simple is vetoed by risk/scope indicators including:

- cross-module or multi-file scope;
- features, refactors, architecture, algorithms, or business logic;
- APIs, public contracts, schemas, migrations, or databases;
- authentication, authorization, security, transactions, or concurrency;
- dependency upgrades;
- releases, deployments, production data, or external side effects;
- frontend/backend or multi-host changes.

If implementation reveals expanded scope, the simple Workflow transitions to
`escalated`. Start a new governed Change and preserve the relationship instead
of mutating the original Workflow identity.

## The standard lane

`standard` is the default lane for implementation requests that are neither typo-level nor
obviously heavy: fix a bug, add a function, refactor a module. It is a template Workflow
(`templates/workflows/standard.yaml`; editable and overridable per project, like
`design-system`) bound to the built-in `standard` Track, and it has no OpenSpec contract, so
there are no documents to scaffold or record:

```text
open → build → verify → done
```

| Step | What happens | Evidence |
| --- | --- | --- |
| `open` | restate the goal and the acceptance check in one sentence; no exploring, no interview skills | none |
| `build` | `test-driven-development`, then the unit tests (scope `changed`; `typecheck` when registered) and the `diff-risk` probe | unit run, test files registered, probe passing |
| `verify` (review gate) | `verification-before-completion`, full unit run (plus `regression`, `integration`, `e2e`, `playwright`, `a11y`, `visual` when registered), one required reviewer `code-review`; the user's single confirmation | tests, reviewer, human confirmation |
| `done` / `escalated` | terminal; `done` commits the whole workspace once (`chore(tenon): finish <change>`) | |

The test policy is the same zero-waiver one the default workflow uses: only `unit` is
mandatory, everything else runs when the project has it. The reviewers are `code-review`
(required, `block_at: medium`; it reads the diff against the goal and acceptance check the host
writes at the end of its prompt, not a spec) and `security`, which declares `attach_on:
[auth, dependency, contract]` and so joins only when the task's changes touch such a path. The
same `attach_on` applies to `security` in the default workflow. Measured on the integration test
(`standard-lane.integration.test.ts`, a three-file bug fix): 23 `tenon` calls and two user
replies (trusting the test commands once, confirming `verify`); the audit's estimate for a
small default backend change is 70–90 calls and 6 or more replies.

### Risk escalation

The lane is chosen by what the change turned out to be, not by guessing from the prompt. The
`build` step declares a required `diff-risk` step test (`tenon test diff-risk --json`) whose
`pass.metrics` are the limits, all editable in the workflow YAML:

| Metric | Default limit | Breached when |
| --- | --- | --- |
| `files_changed` | 8 | more source files changed than the limit |
| `contract_files` | 0 | an OpenAPI, proto, GraphQL, schema or `contract` path changed |
| `auth_files` | 0 | an auth, login, session, jwt, password, permission, crypto or secret path (or `.env*`) changed |
| `dependency_files` | 0 | a package manifest or lock file changed |
| `migration_files` | 0 | a migration path changed |
| `deleted_tests` | 0 | a test file was deleted |
| `protected_test_files` | 0 | the test catalog, baselines, known failures or a project workflow changed |

When the probe fails, `tenon status --json` (and `tenon step run`) stops asking to finish the
step and returns a single `transition` for `scope-expanded` with an `escalate` payload (the
breached limits, and the instruction to open a `default` task and
`tenon set <new> depends_on <old>`). A probe that has not run, or is stale, is an ordinary
required test, so a direct `build-complete` is refused: the probe is a gate, not advice.
`scope-expanded` itself is an abandon edge: leaving through it needs no unit run, reviewer,
document or skill evidence, and the workspace is left uncommitted for the new `default` task
to adopt. Do not split a change or hide files to get the probe to pass.

### Routing into the lane

Implementation-shaped requests (fix, add, implement, refactor, remove, rename, change, in
English and Chinese) route to `standard`; it outranks the `frontend` and `backend` Tracks, which
stay reachable by naming them. A request is kept out of `standard` when it carries a heavy
signal (architecture, cross-module or whole-project scope, schema, migration or database,
authentication or permissions, dependency upgrades, release or deployment, production data,
full-stack): it goes to the default Workflow as before, and when no domain Track claims it the
`backend` Track is used so it is never left ungoverned. Typo-level requests still go to
`simple`, research and product requests to `pm`. A request that matches no Track but looks like
code work (a source path, backticked code, a function call, or words such as function, module,
test, bug, error) is not silently ignored: the router prints one line saying it is not governed
and how to start a `standard` task. Pure discussion prompts are never nudged.

## Free is not “no rules”

The free Track disables automatic domain routing, coverage overlays, automatic
domain Skill matrix overlays, and automation eligibility. It does not remove:

- the selected Workflow's steps and transition graph;
- Skills declared by that Workflow;
- The default Workflow's frozen `tenon-<phase>` requirement. Explicit artifact
  producers and AFK bundles may select a named profile, but that projection
  remains phase-first and does not turn the profile into an automatic gate;
- review/confirm gates;
- guards;
- artifact declarations;
- a declared OpenSpec or document contract.

Free is explicitly selected and is not the automatic fallback when routing has
no winner.

## Custom Workflow selection

Create or save a valid project Workflow at:

```text
.pipeline/workflows/<name>.yaml
```

Then initialize a Change explicitly:

```bash
tenon init <change-name> \
  --track backend \
  --preset full \
  --workflow <name>
```

Built-in `default` and `simple` definitions are reserved and cannot be replaced
by project files. `standard` and `design-system` ship as templates: a project or
user-level file with the same name overrides them (that is how the `standard` risk limits
are changed).

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

## Expected result

The selected mode has a stable Workflow/Track identity and every surface derives
its steps from the same effective plan.

## Verification

```bash
tenon status <change-name> --json
tenon tracks show <track-id> --json
```

Inspect the Dashboard Progress view to confirm its step graph matches status.

## Common failures

### A one-line task uses default

Line count does not define risk. Check whether the request mentions a simple
exclusion such as API, schema, dependency, security, or release.

### A request got no governance at all

Check whether the router printed the one-line “not governed” notice: it appears when no Track
matched but the prompt looks like code work. Start a task with
`tenon init <name> --workflow standard --track standard`, or name a Track in the prompt.
Discussion-shaped prompts (“why …”, “what is …”) are never routed and never nudged.

### Free still pauses at review

That is expected when the selected Workflow declares a review gate.

### A three-step Workflow has no OpenSpec documents

Workflow length does not imply a document contract. Add `openspec: true` and an
explicit `document_contract` only for documents the Workflow really produces and
reads.

## Next action

Read [custom Workflows and Tracks](custom-workflows-and-tracks.md) or
[documents, Skills, and evidence](documents-skills-and-evidence.md).
