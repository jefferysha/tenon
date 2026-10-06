# Security model

## Goal

Explain the trust boundaries around local HTTP, managed releases, project files,
hooks, automation, credentials, and diagnostics.

## Scope

Tenon targets a local, single-user developer workstation. It is not a
remote multi-tenant service and should not be exposed directly to an untrusted
network.

## Who the local boundary is built against

| Adversary | Can do | What stops it |
| --- | --- | --- |
| A web page in your browser | cross-site requests, DNS rebinding, reading cross-origin responses | Host check on every request, Fetch-Metadata / `Origin` checks, a `SameSite=Strict` session cookie, the write token, no CORS headers |
| Another OS user on the machine | connect to the loopback port, read world-readable files | no session means `401`; no credential is stored on disk; the state directory is private to you |
| **A coding agent running as you** (shell, reads every Tenon state file, can reach the loopback port) | `curl /` for a token, read or write the API, read a token file, script a request | `GET /` and every read answer `401` without a session; nothing on disk, in the environment, in process arguments or in any response can be exchanged for a session; approving a review also needs a presence nonce only a signed-in page can request |
| Same user with control of your browser, of process arguments, or of a second server it starts itself | obtain a session | **Not defended.** This is the same power as running `tenon review acknowledge` or editing the files directly; the host hook's fail-closed gate and the AFK policy, not the server, are what apply |

The last row is deliberate and worth reading twice: the loopback boundary is
not a sandbox against code that already runs as you. What changed in 0.3 is that
the Dashboard no longer hands out the keys to whoever asks. Before it, `GET /`
returned the write token to any caller and the hook tried to spot the abuse by
pattern-matching the command; the server is now the boundary and the hook is an
audit signal.

## Dashboard boundary

- The server binds to `127.0.0.1`.
- The Host header is validated on every request, reads and Server-Sent Events
  included.
- Only `GET /api/health` and static `/assets/*` are public. Every other request
  needs a live session cookie: `401` without one, including `GET /`, which
  answers with a sign-in prompt that contains no token.
- A session comes from a **one-time login link** (256-bit, single use, 2 minutes)
  held only in server memory. It is delivered in exactly two ways: the server
  opens your browser itself (`tenon dashboard --open`; the caller learns only
  whether a browser was opened), or it is printed to the terminal of whoever
  launched the server (an interactive terminal, or a launcher that set
  `TENON_DASHBOARD_PRINT_LINK=1`). The page trades the link for an `HttpOnly;
  SameSite=Strict` cookie scoped to the port, stored server-side only as a hash,
  idle 12 hours, absolute 7 days, at most 64 live sessions.
- Nothing is written to disk. A `dashboard-token.json` left by an older release is
  deleted when the server starts.
- Mutations additionally require the random write token (sent as `Authorization:
  Bearer` / `X-Pipeline-Token`), which is embedded only in the page served to a
  signed-in session, plus a JSON content type; a write whose `Origin` is not the
  Dashboard, or a request a browser marked cross-site, is refused.
- **Approving a review needs a person present.** The page asks for a second,
  explicit click; that click requests a single-use nonce (30 seconds) bound to
  the session, change, review ref and expected revision, and the approval must
  present it. A process with no session, or with a session but no fresh nonce for
  that exact review, cannot approve over HTTP. `tenon review acknowledge` in the
  terminal is unchanged and stays governed by the host's interaction gate.
- Pages are served `no-store`, `frame-ancestors 'none'` and
  `Referrer-Policy: no-referrer`.
- Request bodies are bounded.
- Secrets returned to the UI are masked.
- Server reuse validates release and state-scope identity.

Residual risks to keep in mind: browser cookies are not port-isolated, so any
other program that can make your browser talk to a different port on
`127.0.0.1` could see the cookie header it sends; and the login link sits in the
argument list of the opener process for a few milliseconds. Both need code
running as you, which is the row the model does not defend.

## Project filesystem

Dashboard operations use registered project roots as trust anchors and reject
untrusted path traversal/symlink cases. Workflow file operations use realpath,
descriptor, and inode checks where available.

The implementation does not claim to eliminate every hostile same-UID
time-of-check/time-of-use race on platforms that lack the necessary `*at`
filesystem primitives. Do not register untrusted writable roots.

## Managed releases

Release payloads are validated, content-addressed, staged, and atomically
activated. The launcher revalidates the selected payload. Recovery can select
only a previous complete verified release.

This protects against accidental partial/corrupt updates; it is not a substitute
for host marketplace/source trust or OS account security.

## Dependency supply chain

CI and the pre-tag release candidate run `npm run check:dependencies`. The canonical gate combines the High/Critical
advisory audit with `npm ls --all`, so invalid, extraneous, or incompatible
resolved trees fail too. A formal release starts by dispatching
**Release candidate (pre-tag)** with the exact current `main` SHA and a new tag,
or with an existing tag that already peels to that SHA when recovering an
interrupted release.
Its untrusted verification job is read-only, does not persist checkout
credentials, and fails closed unless canonical push CI succeeded for that exact
SHA. All build, test, and packaging commands run there without release secrets.
It normalizes the upload action's bare SHA-256 into GitHub's REST artifact
digest form and publishes a payload bound by that digest and a per-asset
SHA-256 manifest, plus separate approval evidence. A default-branch-owned
`workflow_run` writer revalidates the repository, canonical workflow, completed
run, exact artifact, and approved SHA. The writer checks out and executes no
repository code and runs no npm lifecycle. With minimal permissions, it creates
the tag or idempotently accepts an existing tag only when its peeled commit is
the approved SHA, then creates or repairs the GitHub Release after validating
every existing asset digest. Release automation never runs `npm publish`; an
optional npx package is only a GitHub Release asset.

## Hooks and review

Host capabilities vary by adapter tier. Tier C static guidance is not a native
hard veto. Codex requires explicit hook trust.

While a review is pending, the PreToolUse gate allows only a strict read-only
command set (plus `tenon review request|acknowledge` and `tenon dashboard --open`,
which gives an agent no session); everything else, including any command that
reaches the loopback control surface in any spelling, is blocked. Commands that
may reach the Dashboard are also recorded as a security signal against the
pending receipt. That detection reads the decoded command words and the script a
command runs, not the raw request, but it is best-effort (a computed address or
an encoded payload escapes it); the server-side rules above are what hold when the
hook does not fire, as in an unhooked host or under AFK.

Review receipts bind the current Change/visit/event. Continuous delegation does
not authorize:

- bypassing evidence or guards;
- publishing, deploying, or sending external content;
- spending money or using new credentials;
- changing production systems or real user data;
- weakening security boundaries.

## Test evidence

A test record is evidence only if it could not have been produced by the agent it is
meant to constrain. The threat model is a coding agent that wants a green gate, running
as the same OS user: Tenon raises the cost and leaves a trace, it does not claim to stop
a hostile process that can read your files.

- **Only Tenon writes evidence.** The hook refuses shell and editor writes to run
  records, the per-change test plan and its ledger, shared baselines and
  `known-failures.yaml`, and to the local seal and its key. It recognises 13 write
  shapes: inline interpreter code (`python -c`, `node -e`, `perl -e`), `curl -o` and
  `wget -O`, `tar -x` and `unzip -d`, `git checkout|restore … -- <path>`, `git apply` and
  `patch`, variable paths, script files that name a protected path and are not clean
  tracked files, `xargs sh -c` and `find -exec`, `cp/mv/install/rsync/ln` variants, `tee`
  variants, redirect variants (including heredocs fed to an interpreter) and in-place
  editors. The match is static and best effort.
  Reading is not a write: read records with a plain read utility (`cat`, `ls`, `jq`, `grep`,
  `head`, `tail`, `wc`, `find -name`) or the editor's Read tool. A read that goes through
  inline interpreter code (`node -e`, `python -c`) or `xargs`, or that is chained with any
  write after it, is refused as well, because a static match cannot tell it from a write.
- **What the hook cannot see, the gate detects.** Each change's record chain head is
  sealed by `tenon test run` in a per-user, HMAC-signed local file; records written around
  the command leave a chain whose head is not the sealed one (`record-unsealed`, no human
  override, the next run starts a new chain). Baselines and known failures that changed
  after Tenon last wrote them are `protected-file-tampered`.
- **Definitions of "pass" need a human.** Changes to the test catalog, baselines, the known
  failure list and project workflows in a change's diff block review gates until you
  confirm the exact content (`tenon review request` lists them; delegated confirmation
  cannot approve them). Known failures name one case and expire within 30 days.
- **Reports and the candidate are pinned.** A report must be newer than the run and is
  copied, with its digest, into the run's artifact directory. The workspace fingerprint
  excludes only test outputs that the catalog or the frozen workflow declares, so nothing
  can hide under a directory that merely looks like test output.
- **Repository-provided commands are untrusted on first use.** `tenon test run` executes
  catalog and inline-test commands only after you ran `tenon test trust` on this machine
  for their exact text; CI declares `TENON_TEST_TRUST=1`. The hook refuses an agent call
  that contains either.
- **Reviewers cannot be rerun into a pass.** Every run of a reviewer on the same candidate
  counts and the most severe verdict wins, unless the rerun carries a recorded reason.

Residual risk: a process with your privileges can read the seal key and forge a consistent
seal, build a path the hook cannot parse, or edit `.pipeline/workflows/*.yaml` through the
Dashboard; the human confirmation in review is the backstop for the last two.

CI has no seal key. `tenon verify --ci` re-derives the chain, the plan, the verdicts, the candidate
tree and the protected-file approval lines from committed files, which catches every edit that does
not also recompute and keep consistent the whole record set. It cannot prove the records came from
a trusted `tenon test run`, that an approval line was given by a human, or that the suites ran;
anchoring the chain head in `refs/notes/tenon` adds a second place a forger must write. See
[CI verification](ci-verification.md).

## Credentials and AFK

AFK runner credentials are read through controlled environment/config sources
and doctor reports only presence/source, never values. Container execution
requires a trusted image and explicit autonomy policy.

L3 unattended execution should be enabled only after reviewing:

- sandbox/image provenance;
- paths and operation allowlists;
- budget/concurrency limits;
- verification and review gates;
- Git/merge policy;
- cancellation and recovery.

## Tap and sensitive diagnostics

Tap is off by default. Forward interception requires an explicit local CA and
can expose prompts, headers, tokens, bodies, and CA private material. Keep all
captures local, minimize retention, and sanitize before sharing. Never put raw
traces or secrets in GitHub Issues.

## Logs and the support package

The Dashboard server log (`<state>/logs/dashboard.log`) never receives a credential:
every line passes the shared redactor first (tokens, API keys, cookies, session and
one-time login codes, private keys, URL passwords), the file is mode `0600`, and the
managed background server's login link is never returned or logged in the clear.
`tenon support bundle` runs a second, stricter pass for anything that leaves the
machine (adds emails, home paths and user names), caps the archive at 5 MiB and
uploads nothing. Redaction is pattern based: open the archive and read it before
sharing, and report a miss as a bug.

## Reporting

Use the private instructions in [SECURITY.md](../../SECURITY.md). Do not disclose
an unpatched vulnerability or secrets in a public Issue.

## Verification

```bash
tenon doctor --json
tenon runtime status --json
curl --fail http://127.0.0.1:18765/api/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18765/api/snapshot   # 401 without a session
```

Review host fidelity in [installation](installation.md) and optional automation
controls in [AFK and loops](automation-and-loops.md).

## Common failures

- binding/proxying the Dashboard to a public interface;
- treating localhost as authorization-free, or expecting `curl` to read the
  Dashboard API (it is meant to get `401`; use `tenon dashboard --open`);
- placing tokens in logs or fixtures;
- running an untrusted AFK image;
- enabling Tap interception without a retention plan;
- assuming every adapter has a hard pre-tool veto;
- running `tenon test trust --yes` on a repository whose commands you have not read.

## Next action

For operational help, use [Support](../../SUPPORT.md). For vulnerabilities, use
the private reporting path in [SECURITY.md](../../SECURITY.md).
