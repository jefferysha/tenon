# Troubleshooting

## Goal

Diagnose routing, waiting/running state, evidence, runtime, and Dashboard
problems with read-only checks before applying a bounded repair.

## Prerequisites

- project root and suspected Change name, when applicable
- the exact host and current session
- no manual edits to canonical state, ledgers, or pending markers

## First-response bundle

Run:

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
curl --fail http://127.0.0.1:18765/api/snapshot
```

Collect error messages and exit codes, but remove secrets and sensitive Tap
content before sharing.

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

### Dashboard mutations return 401

Use the packaged same-origin `tenon dashboard`. Vite dev does not own the
production handshake token.

### AFK is queued but not running

Check Docker, image, credentials, loop admission, budget, concurrency, and
autonomy level. PM auto-enqueue does not start a worker.

### Managed runtime is damaged

```bash
tenon runtime repair --rollback
```

If no verified previous release exists, rerun host-scoped setup.

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
