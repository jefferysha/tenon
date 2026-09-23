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
`v0.1.2/install.sh` one-liner once for that host. This is the explicit migration:
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
general unsigned path or a bypass around project Workflow gates.

If no valid previous release exists, reinstall the selected host:

```bash
tenon setup --codex
```

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
