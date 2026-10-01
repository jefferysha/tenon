# Support

Tenon is an open-source local developer tool. The project does not
currently promise a support SLA, hosted service, release cadence, or
compatibility window.

## Before opening a report

Read:

- [Installation](docs/usage/installation.md)
- [Quickstart](docs/usage/quickstart.md)
- [Troubleshooting](docs/usage/troubleshooting.md)
- [CLI reference](docs/usage/cli-reference.md)
- [Security model](docs/usage/security-model.md)

Build the diagnostic package. It is created on your machine, never uploaded, and
redacted before it is written:

```bash
tenon support bundle                      # ~/tenon-support-<time>.tar.gz
tenon support bundle --out ./support.tar.gz
```

The package holds the Tenon/Node/OS versions, `tenon doctor --json`,
`tenon runtime status --json`, a configuration summary (names and counts, never
values), the recent Dashboard server log (three rotated files, newest part kept)
and hook timings when they exist. It stays under 5 MiB, the file mode is `0600`,
and the command prints exactly what went in and what was removed.

Redaction removes tokens, API keys, cookies, session and one-time login codes,
private keys, `user:password@` URLs, email addresses, your home directory
(replaced by `~`, including the account name inside paths) and your user name.
Project directory names below `~` can still appear (for example in `doctor`
details): open the archive and read it before you attach it to an Issue.

For Dashboard problems, `tenon logs` shows the same server log and
`tenon logs --follow` tails it. When the server does not answer:

```bash
curl --fail http://127.0.0.1:18765/api/health
```

The per-Change reads are still useful when the problem is about one Change:

```bash
tenon list --json
tenon status <change-name> --json
tenon document status <change-name> --json
```

## Questions and non-sensitive bugs

Search or open a
[GitHub Issue](https://github.com/jefferysha/tenon/issues).

Include:

- a short problem statement and expected result;
- exact reproduction steps;
- host and adapter;
- operating system and Node.js version;
- relevant plugin/CLI/runtime identity;
- the selected Workflow and Track;
- the support package (or sanitized command output and exit codes);
- whether the problem reproduces in a new host session;
- whether Codex hook trust is active.

Reduce the report to the smallest project/Change that demonstrates the issue.

## Never post publicly

- access tokens, API keys, OAuth material, cookies, or private keys;
- raw prompts or model responses containing private data;
- local CA private material;
- unredacted Tap traces or HTTP headers;
- real customer/user data;
- an unpatched vulnerability.

For vulnerabilities, follow [SECURITY.md](SECURITY.md).

## Feature and design proposals

Explain the user problem, current workaround, affected Workflow/Track/host, and
the smallest public contract change. Avoid starting with an implementation that
has not established the product need.

## Contribution help

Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[contributor development](docs/usage/contributor-development.md). A patch should
state which checks ran and disclose any skipped credentialed or browser
verification.

