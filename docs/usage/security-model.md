# Security model

## Goal

Explain the trust boundaries around local HTTP, managed releases, project files,
hooks, automation, credentials, and diagnostics.

## Scope

Tenon targets a local, single-user developer workstation. It is not a
remote multi-tenant service and should not be exposed directly to an untrusted
network.

## Dashboard boundary

- The server binds to `127.0.0.1`.
- Local Host headers are validated.
- A random 256-bit handshake token is stored with restrictive permissions.
- Mutations require the token and JSON content type.
- Request bodies are bounded.
- Secrets returned to the UI are masked.
- Server reuse validates release and state-scope identity.

Read endpoints remain part of the local workstation trust model. A malicious
process running as the same OS user may be able to access local resources; the
loopback boundary is not a sandbox.

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

## Reporting

Use the private instructions in [SECURITY.md](../../SECURITY.md). Do not disclose
an unpatched vulnerability or secrets in a public Issue.

## Verification

```bash
tenon doctor --json
tenon runtime status --json
curl --fail http://127.0.0.1:18765/api/health
```

Review host fidelity in [installation](installation.md) and optional automation
controls in [AFK and loops](automation-and-loops.md).

## Common failures

- binding/proxying the Dashboard to a public interface;
- treating localhost as authorization-free;
- placing tokens in logs or fixtures;
- running an untrusted AFK image;
- enabling Tap interception without a retention plan;
- assuming every adapter has a hard pre-tool veto;
- running `tenon test trust --yes` on a repository whose commands you have not read.

## Next action

For operational help, use [Support](../../SUPPORT.md). For vulnerabilities, use
the private reporting path in [SECURITY.md](../../SECURITY.md).
