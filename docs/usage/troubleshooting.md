# Troubleshooting

## Goal

Diagnose routing, waiting/running state, evidence, runtime, and Dashboard
problems with read-only checks before applying a bounded repair.

## Prerequisites

- project root and suspected Change name, when applicable
- the exact host and current session
- no manual edits to canonical state, ledgers, or pending markers

## First-response bundle

Build the redacted diagnostic package; it is local only and prints what it contains:

```bash
tenon support bundle [--out <path>]
```

It includes versions, `doctor`, `runtime status`, a configuration summary, the
recent Dashboard server log and hook timings when available, stays under 5 MiB and
is written with mode `0600`. Tokens, cookies, login codes, private keys, emails,
your home path and your user name are removed before anything is written, but read
the archive before sharing it.

The individual read-only checks, when you want one answer:

```bash
tenon doctor --json
tenon runtime status --json
tenon list --json
tenon status <change-name> --json
tenon document status <change-name> --json
tenon afk status <change-name> --json
```

If Dashboard is involved:

```bash
curl --fail http://127.0.0.1:18765/api/health
```

`/api/health` is the only API read that needs no session; `/api/snapshot` and the
rest answer `401` to `curl` by design. Use `tenon status --json` and the other
CLI reads, or sign in with `tenon dashboard --open`.

Collect error messages and exit codes, but remove secrets and sensitive Tap
content before sharing.

### Reading the Dashboard server log

The server mirrors its output into `<state>/logs/dashboard.log` (rotated by size:
the current file plus `.1` and `.2`, 1 MiB each). Credentials, cookies and one-time
login codes are redacted before they reach the file.

```bash
tenon logs                 # last 100 lines across the rotated files
tenon logs --lines 500
tenon logs --follow        # keep printing new lines until Ctrl+C
```

The managed background server has no terminal, so this file is the only place its
warnings and unexpected `500` responses (method, path and message, never the query)
are recorded.

### Changing the CLI language

CLI help, usage errors and the most common errors follow `TENON_LANG=en|zh`, then
`LC_ALL`, `LC_MESSAGES` and `LANG`. With no signal, or with `LC_ALL=C`/`POSIX`
(hooks pin this for stable output), the historical Chinese output is kept. Message
codes and exit codes do not depend on the language. An illegal or unknown
`tenon transition` event lists the legal events for the current step in either
language.

## Symptom guide

### Normal conversation does not trigger a Workflow

Check:

1. whether the request was only discussion/system/slash-command input;
2. `tenon doctor`;
3. Codex `/hooks` trust;
4. whether a new host session was opened after setup/update;
5. project root and hook installation.

Do not force a Change merely to make every conversation governed.

### Codex plugin is installed but authentication is yellow

Run `codex login status`. If it is not logged in, use `codex login` for a
ChatGPT plan that includes Codex, or `codex login --device-auth` on a remote
terminal. For a Platform key created at https://platform.openai.com/api-keys,
use `printenv OPENAI_API_KEY | codex login --with-api-key`, then rerun
`codex login status`. Platform API keys use separate usage-based billing.
Tenon does not perform the login or read the credential.

`auth:codex` reports the local host login. `afk:credential-codex` separately
reports whether an AFK container can receive an API key or readable Codex home;
one green light does not imply the other is green.

### An unrelated old Change is selected

Run `tenon list --json` and inspect the prompt for an explicit resume. Recent
mtime is not selection authority. Explicitly activate the intended Change:

```bash
tenon session activate <change-name>
```

When the host provides a session id, a generic “continue” from an unbound new
conversation must not fall back to the per-user `active-change`. Name the
Change explicitly or activate an exact host-session binding.

### Everything takes the default seven phases

Inspect Track/Workflow identity and simple exclusions. Simple requires positive
bounded evidence and no exclusion. Free/custom require explicit selection.

### A task stays `waiting`

Waiting can be:

- an exact review request;
- unresolved agent/user interaction;
- a fresh confirm/review/interaction gate;
- AFK queued without a running worker;
- a guard/evidence failure.

Inspect status, document status, AFK status, and Dashboard detail. Re-request an
expired review through the CLI; do not delete a marker to fabricate approval.

### UI says waiting while work is running

Check the bound host-session identity and recent terminal/worker activity. A
normal conversation is running only while its host session is actually active;
an unfinished task alone is not running. AFK uses worker lifecycle, not host
conversation activity.

### Todo does not match the Workflow

Status must identify the effective Workflow. Default has seven phases; simple
has change/verify/done/escalated; custom uses its own graph. Restart/update only
after the health endpoint proves the Dashboard release is stale.

### Document exists but transition fails

```bash
tenon document status <change-name>
tenon check <change-name>
```

Confirm producer Skill, current phase visit, digest, and required read receipt.
File existence is not evidence.

### New documents use the wrong language

New Changes default to Chinese and persist that choice as an immutable
`.pipeline-document-locale.json` sidecar. Keeping presentation metadata
outside the strict canonical schema preserves rollback compatibility. Inspect
the pinned value before changing any content:

```bash
cat openspec/changes/<change-name>/.pipeline-document-locale.json
```

Use `--document-locale en` only when creating a new Change or project scaffold
that must remain English. Setup and update deliberately do not translate
existing or archived Markdown.

### Port 18765 shows the wrong application

Check `/api/health` and release/state-scope identity. Stop the unrelated process
or choose another explicit port:

```bash
tenon dashboard --port 19765 --open
```

Do not accept a page solely because the port responds.

### Dashboard pages or API calls return 401

Nothing is served without a session. Run `tenon dashboard --open` to open your
browser already signed in; the same command is needed after the server restarts
or upgrades. If it reports that no browser could be opened, see
[Signing in](dashboard-and-local-api.md#signing-in). For mutations also use the
packaged same-origin Dashboard: Vite dev never receives the write token.

### Approving a review in the Dashboard says a person must confirm

The approval needs the second, explicit click in the page (it requests a
single-use nonce for exactly that review). A script cannot do this; if the
message appears after you clicked, reload the page and approve again.

### `tenon: command not found` (exit 127) in a test or in the agent's shell

`tenon doctor` reports `env:path-tenon` yellow when `tenon` cannot be resolved on `PATH`. `tenon test run`
already puts the running `tenon` first on `PATH` for the test process, so a required test such as
`tenon test code-size --json` works even where no launcher is on `PATH`; the host's own shell and your CI
still need it. Add the launcher directory (normally `~/.local/bin`) to `PATH`, or run
`tenon setup --claude` / `tenon setup --codex` to install the launcher.

### `env:platform` is red in `tenon doctor`

You are on native Windows, which Tenon does not support (the hooks and installer are bash and test
services are stopped through `/bin/sh`). Install WSL 2 (`wsl --install` in an administrator PowerShell),
then install and run Tenon from the WSL terminal with projects in the WSL file system. The full
platform and Node.js matrix is in [Installation](installation.md#supported-platforms).

### AFK is queued but not running

Check Docker, image, credentials, loop admission, budget, concurrency, and
autonomy level. PM auto-enqueue does not start a worker.

### Managed runtime is damaged

```bash
tenon runtime repair --rollback
```

If no verified previous release exists, rerun host-scoped setup.

### Rollback, update and setup all refuse on a leftover rollback

On every release from v0.1.0 through v0.3.1, `tenon runtime repair --rollback` after a `tenon update` failed on a normal install with
`rollback refuses a third-party launcher checkpoint: tenon`. The selection had already moved to the previous release by
then (`tenon runtime status` shows it as active), but the rollback journal `runtime-rollback.json` was left behind, and
from then on `tenon runtime repair --rollback`, `tenon update` and `tenon setup` all stopped with
`存在未完成的 runtime rollback；请先重跑 tenon runtime repair --rollback` ("an unfinished runtime rollback exists; rerun
`tenon runtime repair --rollback` first"), and rerunning it failed the same way.

The cause was a drift between two generators of the same file: the installer writes `export TENON_NODE_PATH=…` into the
stable launcher, the bootstrap's own launcher text lacked that line, and so the bootstrap read the installer's launcher as
a third-party file, after it had flipped the selection. Nothing is damaged except the leftover journal.

You cannot repair this with the Tenon you have: `tenon update` and `tenon setup` run the release you rolled back to, and
`tenon runtime repair --rollback` runs the bootstrap that release installed, so both are the old code. Run the versioned
`install.sh` of v0.3.2 once for the host. It does not go through the launcher, and the setup it runs finishes the leftover
rollback before it installs v0.3.2:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.3.2/install.sh | /bin/bash -s -- --codex
# or
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.3.2/install.sh | /bin/bash -s -- --claude
```

Setup settles the journal by what the selection says. If the selection is the journal's target (the case above), it
converges the launcher pair and removes the journal, and the runtime stays on the release you rolled back to until the
install activates v0.3.2. If the selection is still the journal's start, the rollback never took effect and the journal
is simply removed. If the selection is neither, something else moved it; setup refuses and `tenon runtime status` shows
what. Afterwards `tenon runtime status` and `tenon doctor` show a valid active release, and the previous release is the
one you had rolled back to.

From v0.3.2 the bootstrap writes the same launcher bytes as the installer (a test pins the whole text in both modes) and
proves the launcher pair before it moves the selection, so a refused rollback changes nothing and leaves no journal. If a
rollback is interrupted after the selection moved, `tenon update` and `tenon setup` finish it instead of refusing, and so
does the same `tenon runtime repair --rollback`.

### `tenon doctor` shows `identity:release` as WARN right after a rollback

A rollback swaps only the managed runtime. The host plugin and a running Dashboard still carry the newer release, so the
release identity does not match. That is the state, not damage, and since v0.3.2 doctor reports it as a warning that says
so. It is shown only while the rollback is the latest runtime event and the host plugin is exactly the release you rolled
away from; any other mismatch stays red. Pick one:

- go back to the newer release: `tenon update --codex` (or `--claude`). This undoes the rollback;
- keep the older release and align the host plugin with it: `tenon setup --codex` (or `--claude`) rebinds the host plugin to
  the release of the runtime you are running.

You can also do neither and keep working on the rolled-back runtime.

### A task is stuck on protected-file-unapproved after a not-applicable approval

On v0.3.0 and v0.3.1, a `not_applicable` entry in `.tenon/tests/catalog.yaml` that was committed before the task started and
not yet approved could wedge the task once you approved it in the review. The approval writes your name into the entry's
`approved_by`. That rewrite of `catalog.yaml` was not recorded as approved, so `tenon test status` and `tenon transition`
stopped with `protected-file-unapproved` for the catalog, and `tenon review request` refused a second request
(`phase 'build' 的 event 'build-done' 已获确认；请直接执行该 transition，不能重复 request`: "the event is already confirmed;
run the transition directly").

v0.3.2 records the approval, so a new task does not get stuck. A task that is already stuck is not repaired by updating, and
no command clears it. Putting `approved_by: null` back does not help: the entry is unapproved again and the request is still
refused. What works is to archive the stuck task and start a new one in the same working tree:

```bash
tenon task archive <name> --yes
tenon init <new-name> --track <track>
```

Run the new task as usual (`tenon test register`, `tenon test run <new-name> --stage`). The entry already carries its
approver, so `tenon review request <new-name> --event <event>` lists only the pending change to the test configuration, which
is the catalog rewrite, and not a waiver to approve. Confirm it once with `tenon review acknowledge <new-name>`; after that
`tenon test status` has no blocker left and `tenon transition` goes through.

The archived task is kept: `tenon task unarchive <name> --yes` brings it back. Archiving does not touch your code, but the
new task starts at the first step of its workflow, and the documents the stuck task wrote stay with it.

### `tenon runtime Node identity changed`

The stable launchers pin the Node binary chosen at setup: no symlinks on its path, its inode, mode, owner and size, the
inode, mode and owner of each parent directory, and the SHA-256 of its bytes. v0.2.0 also pinned the device number,
which macOS changes at every restart, so every command and hook failed after one. v0.2.1 does not store it.

- The message names `tenon setup --claude` (or `--codex`): the Node bytes are unchanged and only their identity moved.
  `tenon setup`, `tenon update`, `tenon doctor` and `tenon runtime` still run through the launcher. Run the setup
  command for your host to re-pin.
- The message prints a command that starts with `env TENON_RUNTIME_ROOTS=`: the pinned Node was replaced or removed,
  for example by an in-place Node upgrade. Run that command as printed. It starts the bootstrap with the Node on your
  `PATH`, and setup pins that Node. Use `--codex` instead of `--claude` for Codex.
- If a v0.2.0 launcher already refuses everything, run the versioned `install.sh` for the host once; it does not use the
  launcher.
- A launcher that still pins a device number but works (for example right after a v0.2.0 `tenon update`) is rewritten
  by the first Tenon command or session start that runs from v0.2.1 or later. `tenon doctor` shows `runtime:launcher`
  as WARN until then and names `tenon setup --claude` / `--codex` as the manual fix.

Hooks print this message at most once every 30 minutes and otherwise exit 0 without output. They never block the host.
The marker is `launcher-node-identity.notice` in the Tenon state directory.

### YAML projection drift

```bash
tenon state status <change-name> --json
tenon state repair-projection <change-name>
```

Use force only after reviewing unknown drift.

## Expected result

The symptom is mapped to a specific layer—host hook, routing, Change evidence,
review, worker, runtime, or Dashboard—before mutation.

## Verification

Repeat only the affected read-only commands and confirm the expected state or
health identity changed for the intended reason.

## Common failures

- treating a yellow optional doctor light as a core installation failure;
- deleting pending markers;
- hand-editing `.pipeline.yaml` or the document ledger;
- using `verify-pass` approval for `verify-fail`;
- assuming a port listener is the correct release;
- sharing tokens, CA material, prompts, or raw traces in a public Issue.

## Next action

Use [Support](../../SUPPORT.md) for a sanitized non-sensitive report, or
[Security](../../SECURITY.md) for a vulnerability.
