# Custom Workflows and Tracks

## Goal

Create a declarative process whose graph, Skills, gates, and document reads
match the work, optionally split into Tracks that routing can offer.

## Prerequisites

- an initialized Tenon project
- a unique Workflow name (a file named `default` or `design-system` replaces the
  shipped template of that name)
- known step IDs, transition events, Skill IDs, and document ownership

## Author a Workflow

Project Workflows live at:

```text
.pipeline/workflows/<name>.yaml
```

A small example:

```yaml
name: release-note
openspec: true
steps:
  - id: shape
    label: Shape
    gate: review
    skills:
      - id: writer
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: shape-complete
        to: implement
  - id: implement
    label: Implement
    gate: auto
    skills:
      - id: editor
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: implement-complete
        to: prove
  - id: prove
    label: Prove
    gate: review
    skills:
      - id: verifier
    inputs: []
    outputs: []
    guards: []
    transitions: []
document_contract:
  version: v1
  slots:
    - kind: proposal
      owner_step: shape
      producers: [writer]
  reads:
    - step: implement
      kinds: [proposal]
    - step: prove
      kinds: [proposal]
```

A step has one of two gates: `review` (a person confirms before leaving) or
`auto` (the step's declared outputs must all be set before leaving). `gate: null`
or an omitted gate means `auto`. The outputs check applies to forward edges only;
return edges such as `verify-fail` or `requirements-changed` are never blocked by
it. Outputs the engine writes itself (`build_sha`, `archived`) are not part of
the check. A Change keeps the plan it froze when it started, so Changes started
before a Workflow was recompiled keep the gate behaviour they recorded.

The contract is optional. Without it, Tenon does not infer documents
from the number or names of steps.

`document_contract` requires `openspec: true` on the Workflow. A Workflow that
declares `tracks:` puts the contract under each `tracks.<id>`, next to the steps
it references, never at the top level.

The Dashboard Workbench provides a visual editor for Workflows. The saved YAML,
not the drawing alone, is the project definition.

## Use the Workflow

```bash
tenon init release-note-2026-07 --workflow release-note
```

`release-note` has no `tracks:`, so it is a flat Workflow: its only Track is
implicit and `--track` is not written. Status and Dashboard Todo now use
`shape`, `implement`, and `prove`, not the default seven phase names.

## Add a Track

A Track is a branch of a Workflow, and the branches under `tracks:` are the only
Tracks there are: identity is the pair Workflow + Track id, and there is no
separate Track registry. Declare a branch in the Workflow YAML (or add it on the
Dashboard workflow page); each branch carries its own step list. A branch accepts
a closed set of keys; anything else is rejected when the file is loaded:

| Key | Meaning |
| --- | --- |
| `label` | the name shown in the CLI and the Dashboard |
| `steps` | the branch's step list |
| `document_contract` | the branch's documents, written next to the steps it references |
| `spec` | `openspec` or `none`; omitted, it follows the top-level `openspec` (`openspec: true` means `spec: openspec`), so existing files need no change |
| `route` | automatic routing: `keywords`, `exclude`, `priority`, optional `fallback: true`; omitted, routing never picks the branch and it can only be named |
| `automation` | `eligible` (may enter AFK) and `enqueue_after_spec` (queue the Change when its spec is done); omitted, both are off |

```yaml
name: release-note
tracks:
  docs:
    label: Documentation
    spec: none
    route:
      keywords: [changelog, release note]
      priority: 50
    steps:
      - id: shape
        label: shape
        gate: auto
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions:
          - event: shape-complete
            to: prove
```

A Workflow that declares `tracks:` accepts only the branches it lists.
`tenon init <change> --workflow release-note --track docs` succeeds because
`release-note` declares `docs`; asking for a branch the Workflow does not
declare is rejected before anything is written, and the error lists the
Tracks you can choose:

```text
ERROR: 工作流 'default' 没有轨道 'docs'（可选：lite, pm, frontend, backend）
```

A Workflow with no `tracks:` node is a flat Workflow and its own single Track:
write `--workflow <name>` and no `--track`.

A branch with a `route` block is a routing row: the router offers it when its
keywords score highest. Because it belongs to a custom Workflow, the router does
not choose for you but asks you to select the Workflow + Track pair. Only
`keywords` and `spec` can be edited on the Dashboard Track settings; `exclude`,
`priority`, `fallback` and `automation` are edited in the YAML.
`automation` decides AFK: only a branch with `eligible: true` can be queued, and a
branch without an `automation` block (every flat Workflow included) cannot:
`tenon afk enqueue` exits `3`, and with `--json` reports
`reason: "track-not-afk-eligible"`.

The former built-in Track registry and `.pipeline/tracks.yaml` are not read any
more. If the file exists, Tenon prints one line saying so; move its routing words
into the `route` of the Workflow branches. Inspect the Tracks of every Workflow
the project can use with:

```bash
tenon tracks list --json
tenon tracks show release-note:docs --json
```

`tracks show` takes `<workflow>:<track>`; the Track id alone is enough while it
exists in only one Workflow.

## Skill DAG and guards

Workflow Skills are declarations, not proof they ran. Host hooks and the
internal Skill gate enforce the current step and dependencies; current-visit
provenance is recorded separately. Guards should express deterministic exit
conditions rather than duplicate agent instructions.

## Expected result

- graph validation succeeds;
- the Change has immutable Workflow/Track identity;
- CLI, hooks, Todo, and Dashboard use the same steps;
- only declared documents and reads are enforced.

## Verification

```bash
tenon status <change-name> --json
tenon workflow plan <change-name> --json
tenon tracks show <workflow>:<track> --json
tenon document status <change-name> --json
tenon check <change-name>
```

## Common failures

### A project file changed the default Workflow

A file named `default` or `design-system` replaces the shipped template for that
project or user, Tracks included; a Change started earlier keeps the plan it froze.
`tenon tracks list` shows the Tracks the project really sees. A saved `default`
without a `lite` branch makes `tenon assess` report that the Track has no
change-risk thresholds instead of guessing them.

### A short Workflow unexpectedly has no docs

Add `openspec: true` and a `document_contract.version: v1` with real
owner/producer/read declarations.

### A document producer is rejected

The current step must allow that document kind and the actual current-visit
Skill identity must match a declared producer.

### Track deletion is rejected

An active Change still references it. Preserve the active identity and finish or
terminate the Change (`tenon task finish`, `tenon task terminate`) first.

## Next action

Read [documents, Skills, and evidence](documents-skills-and-evidence.md) and
[CLI reference](cli-reference.md).
