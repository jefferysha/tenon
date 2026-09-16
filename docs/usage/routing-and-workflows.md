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
| Default | Normal PM/frontend/backend work | Matching Track, normally `default` Workflow |
| Free | Explicit user choice only | `free` Track on the selected Workflow |
| Custom | Explicit named Workflow/selection | Selected Track plus authored Workflow |

Routing uses deterministic regular-expression signals, exclusions, scores, and
priorities. It is not semantic AI intent classification. When a custom choice is
ambiguous, the correct behavior is to ask/select explicitly, not guess.

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
by project files.

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

### Free still pauses at review

That is expected when the selected Workflow declares a review gate.

### A three-step Workflow has no OpenSpec documents

Workflow length does not imply a document contract. Add `openspec: true` and an
explicit `document_contract` only for documents the Workflow really produces and
reads.

## Next action

Read [custom Workflows and Tracks](custom-workflows-and-tracks.md) or
[documents, Skills, and evidence](documents-skills-and-evidence.md).
