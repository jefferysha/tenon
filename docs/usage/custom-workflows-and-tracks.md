# Custom Workflows and Tracks

## Goal

Create a declarative process whose graph, Skills, gates, and document reads
match the work, then bind it to a routing/policy Track.

## Prerequisites

- an initialized Tenon project
- a unique Workflow name other than reserved `default` or `simple`
- known step IDs, transition events, Skill IDs, and document ownership

## Author a Workflow

Project Workflows live at:

```text
.pipeline/workflows/<name>.yaml
```

A small example:

```yaml
name: release-note
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
    gate: null
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

The contract is optional. Without it, Tenon does not infer documents
from the number or names of steps.

`openspec_contract: required` is the legacy complete seven-phase OpenSpec
contract and is appropriate only to that full phase shape. It is mutually
exclusive with `document_contract`.

The Dashboard Workbench provides a visual editor for Workflows. The saved YAML,
not the drawing alone, is the project definition.

## Use the Workflow

```bash
tenon init release-note-2026-07 \
  --track backend \
  --preset full \
  --workflow release-note
```

Status and Dashboard Todo now use `shape`, `implement`, and `prove`, not the
default seven phase names.

## Add a Track

A Track is a branch of a Workflow. Declare it under `tracks:` in the Workflow
YAML (or add it on the Dashboard workflow page); each branch carries its own
step list:

```yaml
name: release-note
tracks:
  docs:
    label: Documentation
    steps:
      - id: shape
        label: shape
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions:
          - event: shape-complete
            to: prove
```

A Workflow that declares `tracks:` accepts only the branches it lists.
`tenon init <change> --track docs --workflow release-note` succeeds because
`release-note` declares `docs`; pairing it with a Workflow that does not
declare the branch is rejected before anything is written:

```text
ERROR: 工作流 'default' 没有轨道 'docs' 的分支
```

A Workflow with no `tracks:` node has no branch model and accepts any Track.

`.pipeline/tracks.yaml` remains a read-only policy overlay: it supplies review
seed, coverage profile, routing, and Skill profile for a Track id. It does not
decide which Workflow a Track may be used with, and there is no command to
register a Track there. Inspect it with:

```bash
tenon tracks list --json
tenon tracks show docs --json
```

Built-in policy identity is protected: built-in Track policy cannot be
overridden.

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
tenon tracks show <track-id> --json
tenon document status <change-name> --json
tenon check <change-name>
```

## Common failures

### Reserved name

Project files cannot override built-in `default` or `simple`.

### A short Workflow unexpectedly has no docs

Add `document_contract.version: v1` with real owner/producer/read declarations.

### A document producer is rejected

The current step must allow that document kind and the actual current-visit
Skill identity must match a declared producer.

### Track deletion is rejected

An active Change still references it. Preserve the active identity and archive
or migrate through an explicit supported operation first.

## Next action

Read [documents, Skills, and evidence](documents-skills-and-evidence.md) and
[CLI reference](cli-reference.md).
