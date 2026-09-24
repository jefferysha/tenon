# First governed task

Install the immutable prebuilt Codex release once before starting this tutorial:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.8/install.sh | /bin/bash -s -- --codex
```

This command does not clone the repository or compile source code. It installs
the packaged `v0.1.8` release, starts and verifies the Dashboard, and prints the
local URL plus `tenon dashboard --open`; piped installation does not open a
browser automatically. Afterward, routine upgrades are one
`tenon update --codex` command and remain bound to stable release tags.

## Goal

Trigger Tenon from normal conversation, identify the new Change, and
inspect its real Workflow and evidence without accidentally reviving old work.

## Prerequisites

- completed [installation](installation.md)
- trusted hooks for Codex
- a new host session
- a Git project you are prepared to modify

## Steps

### 1. Ask for a concrete task

Use normal conversation, for example:

```text
Add keyboard navigation to the project switcher and test it.
```

Do not start by manually choosing an old Change unless you intend to resume it.
The router suppresses pure discussion, sends only tightly bounded low-risk edits
to simple, and otherwise creates a new Change with the selected Track/Workflow.

### 2. Identify the Change

```bash
tenon list --json
tenon status --json
```

Use the returned Change name for subsequent commands:

```bash
tenon status <change-name> --json
```

### 3. Inspect evidence

For a governed Workflow:

```bash
tenon document status <change-name>
tenon check <change-name>
```

`tenon check` is a guard report. It does not advance the state.

### 4. Open the workbench

```bash
tenon dashboard --open
```

Progress and Todo use the effective steps of this Change. Default shows seven
phases; simple shows its own four nodes including the escalation terminal; free
and custom retain the selected Workflow.

### 5. Resume only when explicit

In conversation, say:

```text
Resume change <change-name> and continue its current phase.
```

Or activate it for the current session:

```bash
tenon session activate <change-name>
```

Continuous delegated interaction can be recorded explicitly:

```bash
tenon session activate <change-name> --continuous --host-session <host-session-id>
```

This does not waive Skills, documents, review receipts, guards, publication
authority, security, cost, or external-side-effect boundaries.

## Expected result

- discussion created no Change, or
- a new simple/default/custom Change exists for the current request;
- the status, Todo, and Dashboard agree on its Workflow and phase;
- an unrelated prior Change remains untouched.

## Verification

```bash
tenon status <change-name> --json
tenon document status <change-name> --json
```

For simple, document status may correctly report that no default document
contract applies.

## Common failures

### An old Change appears

Confirm whether the prompt explicitly named/resumed it. Do not repair state
until you have run `tenon list --json` and `tenon status <name> --json`.

### Nothing was created

The request may be pure discussion, a slash command, or a system message. If it
was implementation work, run `tenon doctor`, confirm hook trust, and open a
new host session.

### The task is waiting

Waiting can mean a review request, user interaction, queued AFK work, or a guard
failure. Follow the read-only diagnostics in
[troubleshooting](troubleshooting.md).

## Next action

Read [routing and workflows](routing-and-workflows.md) or continue through the
[default workflow](default-workflow.md).
