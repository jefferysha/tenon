# First governed task

Install the immutable prebuilt Codex release once before starting this tutorial:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.3.2/install.sh | /bin/bash -s -- --codex
```

This command does not clone the repository or compile source code. It installs
the packaged `v0.3.2` release, starts and verifies the Dashboard, and prints the
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

In the main checkout of a Git repository a new Change lives in its own worktree,
not in the directory you started from. `tenon list` shows where
(`WORKTREE` column, `worktree` in `--json`); see
[Where the task lives](#where-the-task-lives-the-task-worktree).

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

## Where the task lives: the task worktree

In the main checkout of a Git repository, `tenon init` creates every new Change
in its own worktree. Several tasks in one repository then run side by side, and
none of them sees another's changed files, test registrations or build
fingerprint.

| What | Value |
| --- | --- |
| worktree | `<project>/.worktrees/<change>` |
| branch | `tenon/<change>`, created from the current `HEAD` and tracking nothing |
| task fields | `base_branch` is the branch you started from, `start_sha` is that `HEAD`, `isolation` is already `worktree` |

`.worktrees/` is added to the repository's `.git/info/exclude` when no ignore
rule covers it, so no tracked file changes and `git status` in the main checkout
stays the same. Creation is all or nothing: if `init` fails the worktree and the
branch are removed again, and an existing path or branch of that name makes
`init` exit `1` without touching either.

**When the task is created in place instead.** `isolation` then has no preset,
and `tenon init` says why on stderr (`[INIT] 原地建立任务，不建 worktree：<reason>`):

- the directory is not a Git repository (or not the repository root);
- the repository has no commit yet;
- `HEAD` is detached;
- the directory is itself a linked worktree;
- you passed `--in-place` (only when you want that; the `tenon` skill passes it
  only if you ask) or set `TENON_INIT_IN_PLACE=1`, which Tenon's own test
  harness uses and which prints no reason.

Changes created from the Dashboard or by AFK triage are always created in place.

**Switching in.** Text output keeps stdout empty. Its last two lines on stderr are
`worktree: <absolute path>` and how to switch in. With `--json` stdout is one line:

```json
{"change":"<name>","path":"<change directory>","worktree":"<absolute path or null>","worktree_reason":"<reason or null>"}
```

`worktree_reason` is `null` for a worktree and otherwise one of `not-git`,
`no-commits`, `detached-head`, `linked-worktree`, `requested`. In Claude Code the
`tenon` skill switches with `EnterWorktree` (`path` is the worktree) and then runs
`tenon session activate`; from then on commands, review confirmations and hooks
use the worktree as the project root. Codex has no equivalent: the skill asks
you to open a new session in that directory and ends the turn. Resuming a task
that lives in a worktree works the same way: the dispatch carries
`worktree_path` and the switch comes first.

**Preparing the worktree (`setup`).** A new worktree has no installed
dependencies or build output. The test catalog can declare a top-level `setup`
command, and `tenon init` runs it in the new worktree (output forwarded to
stderr) when the catalog is trusted there:

- Trust is by command digest. `init` copies your trusted digests from the main
  checkout's local seal into the worktree's, so a committed catalog, whose
  digest is the same, is trusted at once. If the main checkout's catalog has
  uncommitted edits, the worktree holds the committed version, whose digest is
  not in your record: `setup` is **not** run, and `init` prints the command and
  asks you to run `tenon test trust` yourself in the worktree (an agent cannot
  confirm it for you), then run the setup by hand. Changing a command in the
  worktree later needs a new confirmation, as anywhere else. Review approvals
  and test-record chain heads are not copied.
- Trust binds the command text (the catalog's command digest). It does not bind
  the repository files the command reads when it runs, such as the `package.json`
  lifecycle scripts or the scripts they call. This is the same trust model as
  for test suites. So once `setup` is trusted, a later commit that changes those
  files makes `init` run the changed version in the new worktree without asking
  again. If you do not want `setup` to run automatically, create the task with
  `tenon init --in-place`, or remove `setup` from the catalog.
- A failing `setup` only warns, with the command to rerun it
  (`WARN: [SETUP] …`); the exit code of `init` stays `0`. A missing catalog, an
  invalid catalog or no `setup` key is reported and skipped.
- This repository's `.tenon/tests/catalog.yaml` declares
  `setup: npm ci && npm run build:packages`. Editing that command asks for
  `tenon test trust` again.
- `setup` can take minutes. Give the shell call a generous timeout (the skill
  uses 600000 ms); a timeout only stops `setup`, the task already exists and
  `tenon status <change>` confirms it.

**Finding the task again.** `tenon list` has a `WORKTREE` column (`worktree` in
`--json`): the absolute path, or `-` / `null` for a task of the current root. Run
from the main checkout it also lists the unarchived tasks under `.worktrees/`.
Commands that read a task by name (`status`, `get`, …) still need the task's own
root: from the main checkout they fail with the error
`change not found: <name> (it lives in the worktree <path>; …)`. `tenon workflow progress`
is the exception and finds the task from the main checkout too. A plain "continue" in the main checkout,
when only worktree tasks can be continued, lists them with their paths and asks
you to pick one.

**Finishing.** Delivery and finishing happen on the `tenon/<change>` branch. When
the task is archived Tenon leaves the worktree and the branch in place and only
reports the cleanup command (`cleanup` on the `finish-change` action and on the
`finished` stop):

```bash
git worktree remove '<path>' && git branch -d 'tenon/<change>'
```

Run it yourself, in the main checkout and not inside the worktree it removes,
when you are done. `git branch -d` refuses a branch that is not merged, so no
commit is lost. The Dashboard registers each worktree as its own project and has
no view across worktrees.

## Step progress in the terminal

After `tenon init`, `tenon session activate`, `tenon transition` or
`tenon step run <change>` succeeds, a PostToolUse hook prints one line in the
terminal, taken from the Change's frozen plan: `✓` for steps already passed, `●`
for the current one, `○` for those not reached, and `✓` everywhere once the
Change is archived:

```text
Tenon · <change>
立项 ✓ → 调研 ● → 规格 ○ → 实现 ○ → 验证 ○ → 交付 ○ → 完结 ○
```

The labels are the ones the workflow declares. The same line is
`tenon workflow progress <change>`. After a return edge (for example
`verify-fail` back to Build) the later steps show `○` again; that is expected.
The line does not depend on the host's Todo tool, which recent Claude Code models
do not offer by default; when the host has one, the skill also fills it from
`tenon workflow plan <change> --json`. The hook runs only after the host reports
the command as successful, so a failed command prints no line, and any hook
problem prints nothing rather than an error; run the command above yourself when
you want the line.

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

### `change not found` for a Change you just created

In the main checkout of a Git repository a new Change lives in
`.worktrees/<change>`. The error names the worktree path; switch to that
directory (Claude Code `EnterWorktree`, Codex a new session there) and run the
command again. `tenon list` shows every task with its path. See
[Where the task lives](#where-the-task-lives-the-task-worktree).

### The task is waiting

Waiting can mean a review request, user interaction, queued AFK work, or a guard
failure. Follow the read-only diagnostics in
[troubleshooting](troubleshooting.md).

## Next action

Read [routing and workflows](routing-and-workflows.md) or continue through the
[default workflow](default-workflow.md).
