# Custom Workflows and Tracks

## Goal

Create a declarative process whose graph, Skills, gates, and required outputs
match the work, optionally split into Tracks that routing can offer.

## Prerequisites

- an initialized Tenon project
- a unique Workflow name (a file named `default` or `design-system` replaces the
  shipped template of that name)
- known step IDs, transition events, Skill IDs, and the files each step must
  produce

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
    guards:
      - type: required-output
        path: docs/release-notes/{change}.md
    transitions:
      - event: shape-complete
        to: implement
  - id: implement
    label: Implement
    gate: auto
    skills:
      - id: editor
    guards: []
    transitions:
      - event: implement-complete
        to: prove
  - id: prove
    label: Prove
    gate: review
    skills:
      - id: verifier
    guards: []
    transitions: []
```

A step has one of two gates: `review` (a person confirms before leaving) or
`auto` (the step can be left as soon as its leave conditions are met). `gate: null`
or an omitted gate means `auto`. The leave conditions are the guards written on
the step and on the edge taken; `auto` adds no check of its own. It no longer
derives an "outputs are all set" check, because a step has no `outputs` any more:
a value the step must have set is a `field-nonempty` guard, a file it must write is
a `required-output` guard. A Change keeps the plan it froze when it started, so a
Change started before keeps the gate behaviour it recorded.

A new custom Workflow that freezes a build revision for Verify writes the
`freeze-build-sha` action on the `build-complete` edge and the `build-head-unchanged`
guard on the `verify-pass` edge, as `templates/workflows/default.yaml` does; they are
no longer inferred from a step's `outputs`.

The Dashboard Workbench provides a visual editor for Workflows. The saved YAML,
not the drawing alone, is the project definition.

## Documents and required outputs

A Workflow does not declare the input or output documents of a step. Skills write
what their own `SKILL.md` says; Tenon records the files each step added, modified or
deleted with the Skill that wrote them, hands the Markdown documents of the direct
upstream step to the next step (which must read them before it can be left), and
enforces `required-output` guards. This is the same for every Workflow and Track,
OpenSpec or not. See [documents, Skills, and evidence](documents-skills-and-evidence.md).

To require a file, put a `required-output` guard on the step (any exit needs it) or
on one edge:

```yaml
guards:
  - type: required-output
    path: docs/release-notes/{change}.md
```

`path` is a project-relative path with `/` separators. `{change}` is the task name,
`*` matches any characters inside one segment, `**` (alone in its segment) matches
any number of segments, and `?` matches one character. A guard may carry `when`
like any other guard. The guard passes when, in this run, a visit of that step
added or modified a matching file that still exists; a matching file that was
already in the repository does not count unless the step changed it. Validation
rejects an empty pattern, an absolute path, `..`, a backslash and any placeholder
other than `{change}`.

### Keys that were removed

The Workflow no longer accepts `document_contract` (top level or under a
`tracks.<id>` branch), non-empty step `inputs`, `outputs` or `artifacts`, and the
`nonempty-output` guard that depended on `outputs`. Saving the file, creating a
Change and compiling a new plan reject them and name the replacement: documents are
recorded automatically, a document condition is `required-output`, a field condition
is `field-nonempty` or `field-equals`.

```text
document_contract 已删除：步骤的文档产出由 Tenon 在离开步骤时自动记录；需要门禁时写 { type: required-output, path: <路径> }
```

Empty `inputs: []`, `outputs: []` and `artifacts: []` are still read (the Dashboard
saved files with them before) and are no longer written back. A Change created before
the upgrade keeps its frozen plan with the old keys and finishes under them.

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
- every step's actual outputs are recorded when it is left, and only the declared
  `required-output` guards are enforced.

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

### A short Workflow does not produce the docs I expected

A Workflow creates no document by itself: the Skills of each step write what their
own `SKILL.md` says. Add a `required-output` guard to the step that must leave the
file behind, so the step cannot be left without it.

### Saving the Workflow fails and names `document_contract`, `inputs`, `outputs` or `artifacts`

These keys were removed. Delete them; write `required-output` for a file condition
and `field-nonempty` or `field-equals` for a field condition (see
[Keys that were removed](#keys-that-were-removed)).

### A required output is reported missing

Only a file the step added or modified in this Change counts, and only while it still
exists. See [documents, Skills, and evidence](documents-skills-and-evidence.md#required-outputs).

### Track deletion is rejected

An active Change still references it. Preserve the active identity and finish or
terminate the Change (`tenon task finish`, `tenon task terminate`) first.

## Next action

Read [documents, Skills, and evidence](documents-skills-and-evidence.md) and
[CLI reference](cli-reference.md).
