# Updates, recovery, and uninstall

## Goal

Update one host, recover from a damaged managed release, and uninstall only
Tenon-owned project files.

## Prerequisites

- an existing verified installation
- exactly one host selected for update
- a new host session after update

## Update

If the installed launcher is a retired 1.x release, first run the immutable
`v0.3.2/install.sh` one-liner once for that host. This is the explicit migration:
1.x ranks below every 0.x release, so `tenon update` on 1.x reports a downgrade
and changes nothing. The command below is the single routine update path
from v0.1.0 onward.

Immediate native-host update:

```bash
tenon update --codex
# or
tenon update --claude
```

The selected host updates the one complete Tenon plugin. There is no separate CLI self-update
channel; Skills, hooks, CLI, workflows, Dashboard, and adapters share one release transaction.
The native host exclusively owns its cache. Tenon commits only its immutable runtime, launchers,
and Dashboard boundary, then read-only scans the Tenon project registry and prints explicit
`tenon sync` commands without mutating project workspaces.

Inspect without mutation:

```bash
tenon update --codex --dry-run
```

Enable the native daily background check explicitly:

```bash
tenon setup --codex --auto-update
```

Auto-update is opt-in and host-scoped. The updater verifies the complete
candidate, atomically activates it, and refreshes the managed Dashboard. A
running coding-agent session keeps the Skills/hooks already loaded; start a new
session. Codex may ask you to trust changed hooks again.

## Migration from the retired identity

Plugin IDs cannot be renamed by an ordinary same-identity update. The retired
repository is therefore a frozen, migration-only channel: it installs and
verifies `tenon@tenon`, atomically activates the Tenon runtime, waits for a real
new-session proof, and only then removes the old plugin, marketplace, and
byte-matching owned launchers. Any failed verification preserves a retryable
state. The active migration window ends on 2026-10-31; the Tenon product does
not expose an old CLI alias.

Redeploy a non-native adapter from the current release:

```bash
tenon update --cursor --target /absolute/path/to/project
```

The adapter does not own an independent marketplace auto-updater.

## Runtime status and recovery

Read-only status:

```bash
tenon runtime status
tenon runtime status --json
```

Exact rollback:

```bash
tenon runtime repair --rollback
```

Repair can select only the previous complete verified release. It is not a
general unsigned path or a bypass around project Workflow gates. A rollback proves the stable launcher pair before it moves
the selection, so a refused rollback changes nothing and leaves nothing behind.

A rollback swaps only the managed runtime; the host plugin keeps the newer release. Right afterwards `tenon doctor` shows
`identity:release` as a warning that says so, not as a failure. `tenon update --codex` (or `--claude`) goes back to the newer
release; `tenon setup --codex` (or `--claude`) rebinds the host plugin to the release you rolled back to. If the rollback
itself failed on v0.3.1 or an earlier release and rollback, update and setup now all refuse, see the section "Rollback,
update and setup all refuse on a leftover rollback" in
[Troubleshooting](troubleshooting.md#rollback-update-and-setup-all-refuse-on-a-leftover-rollback).

If no valid previous release exists, reinstall the selected host:

```bash
tenon setup --codex
```

### Compatibility with the previous release (v0.2.1)

Whatever Tenon v0.3 writes during normal use stays readable by v0.2.1, so you can roll back with
`tenon runtime repair --rollback`, or keep working next to a teammate who has not updated yet.
v0.2.1 does not treat that data as corrupt, tampered or invalid, and v0.3 reads what v0.2.1 wrote.
The release gate (`tools/test-bundle.sh`) crosses a release with its predecessor in both directions on every run: v0.3.2
against v0.3.1, where v0.3.1 was crossed with v0.3.0.

- **Test run records are never pruned by default.** v0.3 keeps every record of a run chain.
  To cap how many records a task commits, set `TENON_RECORD_RETENTION=<n>` (for example `20`) when
  running `tenon test run`: after each run only the newest `n` records per user and Change are kept and
  a `chain-base` marker is left beside them. v0.3 reads such chains; v0.2.1 does not know the marker and
  reports the chain as tampered (`找不到链首记录`) until a rerun starts a fresh chain. Set it only when
  everyone who runs tests in the repository is on v0.3 or later. Records of inline step tests keep the
  newest 20 per test as before.
- **Agent run host and rerun reason** are stored in `.pipeline-agent-run-meta.jsonl` beside
  `.pipeline-agent-runs.jsonl`, which v0.2.1 ignores, so its closed ledger reader keeps working.
- **Records written by v0.2.1** read as an intact chain in v0.3 but have no local seal, so v0.3 treats them
  like records from another machine (`record-unsealed`): run `tenon test run <change> --stage` once and
  the new run starts a fresh chain.
- **Undeclared test output.** v0.3 counts a `coverage/`, `test-results/` or `playwright-report/` directory that
  no catalog suite declares as part of the workspace, v0.2.1 ignored such directories. In a workspace that
  has one, a run recorded by one version shows as stale (candidate changed) in the other; run the suite
  again, or declare the output in the catalog (`tenon test discover` declares the usual ones).

What you opt into needs v0.3; v0.2.1 reports the file as invalid or ignores the setting, and these are not
made readable on purpose:

- `profile: coarse` or a `not_applicable:` list in `.tenon/tests/catalog.yaml`;
- `integrity: notice` or `integrity: block` written in a workflow's `test_policy`;
- `host: codex|claude` on a workflow reviewer;
- `attach_on` or `host` in a custom agent file (also what `tenon agent copy security <name>` writes);
- `TENON_RECORD_RETENTION` (above).

The standard lane (`track: standard`) is a v0.3 lane the router may pick for small implementation requests.
v0.2.1 reports `未注册的 track 'standard'` for those tasks (`list`, `status` and `get` still work), so finish
or archive standard tasks before rolling back.

## Canonical project-state recovery

Inspect before repair:

```bash
tenon state status <change-name> --json
tenon status <change-name> --json
```

If only the YAML projection drifted from canonical state:

```bash
tenon state repair-projection <change-name>
```

`--force-canonical` is an explicit destructive preference when unknown YAML
drift exists. Do not use it until the diff and canonical record have been
reviewed.

Never hand-edit canonical state or manufacture review/document receipts.

## Uninstall project assets

Preview from the project root:

```bash
tenon uninstall --dry-run
```

Then explicitly confirm:

```bash
tenon uninstall --yes
```

The uninstaller uses `.pipeline-owned.json`:

- unchanged opaque files owned by Tenon may be deleted;
- structured host files are scrubbed while user fields are preserved;
- user-modified opaque files are preserved;
- missing files are skipped;
- known scrubber stubs are reported and conservatively preserved;
- the project `.pipeline/` directory is removed;
- the command refuses to run at the home-directory root by default.

This project-level uninstaller does not claim to remove arbitrary host-owned
marketplace caches or user data outside its ownership manifest.

## Expected result

- update activates a verified release for one host;
- recovery selects only a known-good managed release;
- uninstall prints a precise ownership plan and preserves user-modified files.

## Verification

After update:

```bash
tenon runtime status --json
tenon doctor --json
tenon dashboard --dry-run
```

After uninstall, inspect the printed preserved/stub list and repository diff.

## Common failures

### Update succeeded but current session behaves like the old version

Open a new host session and review Codex hook trust.

### Rollback is unavailable

There is no previous complete verified release. Re-run setup for the selected
host.

### Uninstall refuses without `--yes`

This is the fail-closed confirmation contract. Use `--dry-run` first.

### Uninstall preserves a file

The file was user-modified or the scrubber cannot safely prove ownership.
Review it manually; do not force-delete unrelated host configuration.

## Next action

Read [troubleshooting](troubleshooting.md) or
[security model](security-model.md).
