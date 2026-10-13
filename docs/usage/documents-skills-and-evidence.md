# Documents, Skills, and evidence

## Goal

Understand what Tenon records about the files each step writes, which of them the
next step must read, and how a Workflow can require a file before a step can be
left.

## Prerequisites

- an active Change created after the document-mechanism rework; a Change created
  earlier keeps its frozen rules, see [Changes created before the upgrade](#changes-created-before-the-upgrade)
- the skills the current step declares, plus the packaged `tenon` skill
- a git repository (outside git nothing is observed, see
  [Common failures](#common-failures))

## What a Workflow declares

A Workflow does not list the input or output documents of a step. A Skill writes
what its own `SKILL.md` says (`brainstorming` a design under
`docs/superpowers/specs/`, `openspec-propose` the proposal and delta specs, and so
on); Tenon records what actually happened. The only document condition a Workflow
can state is a [required output](#required-outputs): a path pattern the step must
have produced before it can be left.

## Step outputs

A *step visit* is one pass from entering a step to leaving it; a step entered again
through a return edge is a new visit. A visit has two moments:

- **Entering.** Tenon takes a checkpoint: git `HEAD` plus every file that differs
  from `HEAD` (untracked included, ignored files not) with its SHA-256.
- **Leaving.** After every gate has passed and before the transition is committed,
  inside the Change lock, Tenon compares the workspace with the checkpoint. Each
  file that was added, modified or deleted is a *step output*, recorded with its
  source Skill (or `unknown`). The same code runs for `tenon transition` and for
  the Dashboard.

Because the comparison looks at the files, not at who wrote them, it covers
writes made by shell commands and subagents as well as by the Skill itself.

The records live in `openspec/changes/<change>/.pipeline-step-outputs.json`: Tenon
state, written only by Tenon commands, committed and archived with the task
directory. It keeps the latest 512 visits and at most 2000 outputs per visit.

What is not observed: files ignored by git; any path with a segment starting with
`.pipeline` or named `node_modules`; paths under `.git`, `.tenon`, `.claude`,
`.agents`, `.codex`, `.superpowers`, `.worktrees`, `.turbo`; `.github/hooks/`;
`openspec/.gitignore`; other Changes' directories under `openspec/changes/`; dotfiles
directly in the Change directory. A symlink is hashed by its target string, and a
submodule or nested repository is not entered.

When `HEAD` moved during the visit (a commit, a rebase), only the commits of this
Change count: commits reachable from the upstream refs (`origin/HEAD` and the
branch's own upstream) are excluded, so files merged by others are not attributed
to the step.

Outside a git repository, or when a git command fails, the visit is recorded as
`observation: unavailable`: no outputs, and the transition is not blocked. More
than 20000 changed paths record `truncated`.

## Source Skill

The host hook records when each Skill was loaded in the current visit. For an added
or modified file the source is the last Skill loaded no later than the file's
modification time (compared per second); the orchestration skill `tenon` is never
a source. A file with no such Skill, and every deleted file, shows as `unknown`.
This is a best effort: two Skills loaded in the same second, or a checkout that
rewrites modification times, can blur it. It only labels outputs and never decides
a gate.

## Handoff to the next step

The next step receives only what its *direct upstream* produced: the visit that
transitioned into it. Earlier steps' outputs are not handed over; a Skill that needs
one reads it itself. The first step has no inputs.

A handed-over *input* is a document the upstream visit added or modified and that
still exists. Documents are files ending in `.md`, `.mdx` or `.markdown`. Code and
other files are recorded as outputs and shown in the Dashboard but are not inputs, so
a verification step is not asked to read dozens of source files.

`tenon status --json` puts the unread inputs into a `read-documents` action
(`documents` lists the paths). The agent reads each file into its context, then
records the receipt. The step may change an input: the change is recorded as an output
of the step.

## Read receipts

```bash
tenon document read <change-name> all
tenon document read <change-name> <path>
```

The command hashes the current content and writes a receipt into the current visit.
Only a handed-over input can be named; a path outside the project is refused. An input
counts as read when the visit holds a receipt whose digest equals the digest the
upstream recorded or the file's current digest, so editing a file after reading it
does not require reading it again (the edit becomes an output of this step). An input
deleted since is no longer listed.

Every edge out of a step needs all inputs read: forward, return and completion
edges alike. Only the abandon edge (terminating the task) does not. A transition
with an unread input is refused with exit code `1`; `tenon status` and
`tenon check` list the same blocker as `source: document`, `code: input-unread`,
`subject: <path>`, naming the upstream step and the command to run.

```bash
tenon document status <change-name>
tenon document status <change-name> --json
```

`document status` prints the step's inputs (`READ` or `UNREAD`, upstream step, source
Skill), outputs (`added`, `modified` or `deleted`, source Skill) and required outputs
(`PRODUCED` or `MISSING`). The JSON form is
`{ change, workflow, mode, observation, inputs, outputs, required }`. It exits with
code `2` while an input is unread or a required output is missing, and `0` otherwise.
The same view is `step.documents` in `tenon status --json`, with `mode: "observed"`.

## Required outputs

A step states a file it must write with a `required-output` guard, on the step's
`guards` or on an edge's `guards` (`when` is supported):

```yaml
guards:
  - type: required-output
    path: openspec/changes/{change}/specs/*/spec.md
```

The pattern is a project-relative path with `/` separators. `{change}` is the task
name, `*` matches any characters inside one path segment, `**` (alone in its segment)
matches any number of segments, and `?` matches one character. Validation rejects an
empty pattern, an absolute path, `..`, a backslash and any other `{...}` placeholder.

The guard is satisfied when, in this run, a visit of this step produced (added or
modified) a matching file that still exists. A matching file that was already in the
repository does not count unless the step changed it, so an older design under
`docs/superpowers/specs/` cannot satisfy a new Change's Explore step. Returning to the
step does not ask for the file again. When the visit could not be observed
(`unavailable` or `truncated`), the guard falls back to "a matching file exists".

A missing required output refuses the transition with exit code `2`, naming the step and
the pattern; `tenon check` lists it with the other unmet conditions, and `step.next`
turns it into a `fix`. A required output is the only document condition the
Workflow YAML carries; the default workflow's patterns are listed in the
[default workflow](default-workflow.md).

## Independent of the specification

Observation, handoff, read receipts and required outputs know no specification
format. They work the same on every Track and Workflow: the lightweight Track,
`spec: none`, a flat custom Workflow. `spec: openspec` only turns on the OpenSpec
lifecycle of a Track: the `tasks.md` skeleton (the source of the Todo list), delta-spec
validation and application, the `spec-migration-applied` condition and the
`openspec archive` finish. A new Change gets no proposal or design skeleton; the Skill
writes them.

A Spec Kit style flow is therefore a plain Workflow whose steps require its own files:

```yaml
name: speckit
steps:
  - id: specify
    label: Specify
    gate: auto
    skills: []
    guards:
      - type: required-output
        path: specs/*/spec.md
    transitions:
      - event: specify-complete
        to: plan
  - id: plan
    label: Plan
    gate: auto
    skills: []
    guards:
      - type: required-output
        path: specs/*/plan.md
    transitions:
      - event: plan-complete
        to: done
  - id: done
    label: Done
    gate: auto
    skills: []
    guards: []
    transitions: []
```

Nothing in Tenon knows the names `spec.md` or `plan.md`; they are only paths in the
guards. See [custom Workflows and Tracks](custom-workflows-and-tracks.md).

## Skill resolution and trust

Mandatory default Skills are bundled with the immutable release. Resolution
uses the bundled trust tier first. External sources are considered only for a
true not-found case; a damaged bundled Skill fails closed rather than silently
substituting a same-named external copy.

The packaged `tenon` Skill is the orchestration entrypoint. Phase and supporting
Skills still need real current-visit evidence.

## Review evidence

Documents and Skill receipts do not replace human review. Review is a separate,
exact event receipt:

```bash
tenon review request <change-name> --event <event>
```

The user confirms it: by replying with an approval phrase (the hook writes the
receipt), in the Dashboard (`tenon dashboard --open`), or by running
`tenon review acknowledge <change-name>` in their own terminal. The agent must
not run that manual form. Deleting a pending marker does not create approval.

## Changes created before the upgrade

A Change keeps the plan it froze when it started. A Change whose frozen plan carries
the former document contract (slots and reads per document kind) finishes under
it, unchanged: the document ledger `.pipeline-documents.json`, kinds with fixed paths,
producer checks, per-kind read receipts, the `scaffold-document`, `record-document` and
`register-field` actions, and `step.documents` with `mode: "contract"` and its `reads`,
`records` and `updates` tables.

| Command | New Change | Change created before the upgrade |
| --- | --- | --- |
| `tenon document read <change> all` or a path | writes a read receipt for the handed-over inputs | `all` or a document kind, as before |
| `tenon document status <change>` | inputs, outputs, required outputs | records and reads |
| `tenon document scaffold`, `record`, `init`, `migrate-delta` | refused, exit `2` | work as before |
| `tenon artifact register` | refused, exit `1` | works where the frozen step declares the artifact |

The refusal reads: the outputs of this task are recorded automatically by Tenon when a
step is left, and the command only serves tasks created before the upgrade. A Change
with no frozen plan that was bound to the former full OpenSpec profile gets the
frozen OpenSpec document table.

A Change created before the upgrade whose frozen plan has no contract (for example the
lightweight Track) switches to observation: the visit that was already running has no
checkpoint and is recorded as `unavailable` with no inputs and no blocking; observation
starts again from the next transition.

## Expected result

- every transition leaves a record of the step's added, modified and deleted files, with
  a source Skill or `unknown`;
- the next step lists only its direct upstream's documents and cannot be left before
  they are read;
- a `required-output` guard blocks a step until it has written a matching file;
- `tenon document status` and the Dashboard Workspace show the same inputs, outputs and
  required outputs.

## Verification

```bash
tenon document status <change-name> --json
tenon check <change-name>
```

## Common failures

### The transition is refused with unread inputs

Read the files listed in `documents` of the `read-documents` action, then run
`tenon document read <change-name> all` and transition again.

### A required output is reported missing

Have the Skill write the file at the pattern's path. A file that existed before this
Change does not count unless the step changed it; a file written in a different step
does not count for this one.

### The source Skill shows `unknown`

The file was written by a shell command or a subagent while no Skill had been loaded
in this visit, in the same second as the Skill load, or before the first Skill of the
visit. The output is still recorded and handed over; only the label is missing.

### Nothing is recorded for a step

The project is not a git repository, a git command failed, or the visit started before
the upgrade and has no checkpoint (`observation: unavailable`). Required outputs then
only check that a matching file exists.

### `document record` or `artifact register` is refused

The Change is new: nothing needs to be recorded. See
[Changes created before the upgrade](#changes-created-before-the-upgrade).

### A read receipt does not satisfy an input

The receipt digest matches neither the upstream's recorded digest nor the file's
current content. Read the current content again.

### Build discovered changed requirements

Return to Spec with `requirements-changed`; revise and review there.

## Next action

Read [default workflow](default-workflow.md) or
[custom Workflows and Tracks](custom-workflows-and-tracks.md).
