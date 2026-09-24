# Installation and host selection

## Goal

Install one complete Tenon release for exactly one coding-agent host,
verify the managed runtime, and load its packaged hooks and Skills.

## Prerequisites

- Node.js 22 or later
- Git
- the selected host CLI available on `PATH`; for Codex:
  `npm install -g @openai/codex`, then `codex --version`
- Docker only for later AFK container execution

Tenon does not require users to install mandatory Skills one by one.

## Native host setup

New users install the complete Codex plugin without cloning the repository:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.10/install.sh | /bin/bash -s -- --codex
```

For Claude:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.10/install.sh | /bin/bash -s -- --claude
```

Preview the complete Codex Marketplace and packaged setup plan without invoking
the host or writing user/project state:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.10/install.sh | /bin/bash -s -- --codex --dry-run
```

The versioned script installs only prebuilt assets from the immutable stable
`v0.1.10` release. It never clones or compiles the source repository.

The Claude Code host clones this repository as a plugin marketplace, and its
default clone timeout is 120 s. On a slow link raise it for the install, e.g.
`CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS=1800000`; a timed-out clone leaves the host
without the plugin, so rerun the install after raising it.
The bootstrap adds the selected native marketplace plugin, resolves the install
root from the host's own inventory, and invokes the same
`tenon setup --<host>` operation. Tenon does not guess private host
cache locations.

Tenon's version numbering restarted at 0.1.0, and the retired 1.x releases were
removed. On a machine that still runs a 1.x installation, run the versioned
`v0.1.10/install.sh` command once per host. `tenon update` on 1.x reports a
downgrade and changes nothing: that refusal ships inside the already published
1.x release and cannot be fixed retroactively. From v0.1.0 onward, every routine
upgrade is one `tenon update --codex` (or `--claude`) command and uses a stable
release tag as its delivery identity.

Setup always starts the packaged Dashboard and waits for readiness. Piped/CI
installs do not open a browser; they print the verified local URL and
`tenon dashboard --open`. An interactive first setup may open the browser.
Manual and automatic updates keep it closed while preserving readiness.

### Codex authentication

Plugin installation and account authentication are separate. After a successful
Codex setup, Tenon runs the read-only `codex login status` check. It never starts
a login flow, reads `auth.json`, or records credentials.

Use one route:

```bash
# A ChatGPT plan that includes Codex
codex login

# A remote or browserless terminal
codex login --device-auth

# A Platform API key created at https://platform.openai.com/api-keys
printenv OPENAI_API_KEY | codex login --with-api-key

# Verify either route
codex login status
```

A ChatGPT-plan login does not require a separate API key. Platform API keys use
separate usage-based billing. Keep keys out of argv, logs, and support reports.
Authentication guidance does not block a non-interactive or CI install.

This Marketplace bootstrap is the currently available one-command install.
The repository can also build a thin npx package as a digest-verified GitHub
Release asset. Release automation never publishes it to npm. Documentation
will publish the final `npx --yes @<publisher>/tenon setup --codex` command only
after a separately authorized npm publication from an owned scope. It is not a
second runtime or installer transaction.

Setup validates the complete package, publishes an immutable managed release,
creates stable `tenon` and `tenon-hook` launchers, starts the packaged
Dashboard, and waits for its health check. Piped/CI installation prints the
verified URL and `tenon dashboard --open` without opening a browser; only an
interactive first setup may request automatic browser opening.

The published commands are tested at two levels. CI installs a pinned real Codex CLI and
builds an isolated Git mirror from the exact candidate checkout, tags that mirror with the same
stable release version, and runs the versioned installer against it in a separate temporary
`HOME`, `CODEX_HOME`, `TENON_RUNTIME_HOME`, and Dashboard port. After the immutable public tag is
created, the public acceptance downloads only that tag's `install.sh`. Both paths verify the stable launcher, doctor, managed
runtime, Dashboard API and HTML identity, a new Codex app-server's plugin/Skill/hook discovery,
and a second identical installation that keeps the same release and listener.

The acceptance never copies a user's Codex credentials and never changes hook trust. Codex
therefore reports Tenon hooks as untrusted until the user performs the `/hooks` step below; that
is the expected human safety boundary, not an installation failure.

After installation, use `tenon setup --codex` to repair host wiring and
`tenon update --codex` (or `--claude`) to update the one complete host plugin. Manual and
opt-in automatic updates use the same candidate validation, managed release, launcher, and
Dashboard transaction; there is no second CLI self-update channel.

### Codex hook trust

Codex keeps a one-time local trust boundary for third-party hooks:

1. finish `tenon setup --codex`;
2. open Codex and run `/hooks`;
3. trust `tenon`;
4. start a new Codex session.

Until trust is granted, the plugin and Skills can be installed while
SessionStart/UserPromptSubmit hooks remain inactive. Normal-chat routing will
therefore not run. If an update changes the hook bundle and Codex asks again,
review and trust it again.

### Claude session loading

Start a new Claude session after setup or update. A running host session keeps
the Skills and hooks it already loaded.

## Adapter setup

An installed release can deploy a non-native adapter into a project:

```bash
tenon setup --cursor --target /absolute/path/to/project
tenon setup --gemini --target /absolute/path/to/project
```

Supported flags:

```text
--codex --claude --cursor --gemini --copilot --pi
--devin --zed --aider --continue --cline --amp
```

Exactly one flag is accepted. `--target` defaults to the current directory for
non-native adapters. Use `--dry-run` to inspect the plan:

```bash
tenon setup --cline --target /absolute/path/to/project --dry-run
```

Native Codex/Claude marketplace releases own automatic refresh. Other adapters
are redeployed from the currently installed complete release; they are not
independent marketplace products.

## Host fidelity

Fidelity describes three governance capabilities: session/task context
injection, pre-tool veto, and Skill-execution tracking.

| Tier | Hosts | Injection | Veto | Tracking |
| --- | --- | --- | --- | --- |
| A | Claude Code, Codex, Gemini CLI, Continue CLI, Cline, Amp | native equivalent | native equivalent | native equivalent |
| B | Cursor | static/later fallback | native fail-closed | native |
| B | GitHub Copilot coding agent | instructions/user-prompt fallback | native | native |
| B | Pi | native | advisory extension | native |
| B | Aider | process-start file | commit gate | post-commit |
| C | Devin, Zed | static | manual CLI review receipt | manual/degraded |

Boundaries:

- Continue means Continue CLI (`cn`), not the IDE extension.
- Gemini's known caveat concerns sub-agent context injection, not the main
  session hooks.
- Amp uses an in-process plugin protocol. Its adapter capabilities are Tier A,
  but payload details have not been verified in a credentialed real Amp session.
- Tier C has no native enforcement hook. Static instructions are not a hard
  pre-tool veto.

## Managed runtime locations

Payload, state, and configuration use OS-standard application-data locations:

- macOS: `~/Library/Application Support/tenon/`
- Linux: XDG data/state/config locations
- Windows: Local AppData for data/state and Roaming AppData for configuration

Tenon-owned files never use `~/.claude` or `~/.codex` as storage. The project registry and
credentials live in the Tenon config root; runtime selection, audit, Dashboard token, and pidfile
live in the Tenon state root. `TENON_RUNTIME_HOME` redirects the complete product domain for
isolated testing or operations.

The stable command launcher is normally `~/.local/bin/tenon`. Treat the
host-owned marketplace/cache directory as private implementation detail.

## Expected result

```bash
tenon runtime status --json
tenon doctor --json
```

The runtime reports an active verified release. Doctor reports the effective
protections and any honest yellow degradation, such as optional Docker or AFK
credentials not being configured.

## Verification

```bash
tenon dashboard --open
```

The packaged SPA and API become healthy on
`http://127.0.0.1:18765/` unless `--port` is explicitly used.

## Common failures

### `tenon: command not found`

Run the one-line Marketplace installer again, then
ensure `~/.local/bin` is on `PATH`.

### Setup accepts neither zero nor multiple hosts

This is intentional. Choose one host per operation.

### Codex is installed but normal conversation does not route

Run `/hooks`, trust `tenon`, and open a new session.

### Adapter has weaker enforcement than Codex

Check the fidelity table. Degraded behavior is part of the adapter contract, not
an installation failure.

### Docker or credentials are yellow in doctor

They are optional for interactive workflows. Configure them only before using
AFK with the corresponding runner.

## Next action

Continue with the [first governed task](quickstart.md), or read
[updates and recovery](updates-recovery-and-uninstall.md).
