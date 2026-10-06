# CI verification

## Goal

Make a pull request prove its own test evidence. `tenon verify --ci` re-checks, from the committed
files alone, what `tenon test run`, `tenon review` and the task state recorded locally, and a
GitHub Action runs it on every pull request, uploads SARIF to code scanning and writes a job
summary. A forged or stale record fails the check.

## Prerequisites

- A repository that already uses governed Changes with the test system (`.tenon/tests/catalog.yaml`,
  a test plan per Change, run records committed under the per-user record directory).
- Node.js 22 or newer on the runner. The action sets it up.
- `actions/checkout` with `fetch-depth: 0`. Protected-file approvals are checked against the
  commit each Change started from; a shallow clone cannot answer that, and the check then fails
  closed with `protected-diff-unavailable` instead of guessing.

## What CI can and cannot verify

CI does not have your local HMAC key. Records and approvals are sealed with a key that lives in the
git-ignored `local/` directory of your user record directory (`env.key` and `test-seal.json`), so CI
cannot prove that a record was written by a trusted `tenon test run`. It re-derives everything else.

| CI re-verifies from committed files | CI cannot prove without the local key |
| --- | --- |
| The record chain: head, forks, loops, stray or missing records, file names, content digests | That a record was written by `tenon test run` on a machine you trust. A forged chain with every digest recomputed that agrees with the plan, the catalog and the code is invisible, unless its head is anchored (below) |
| Records agree with themselves: right Change and user directory, verdict versus suites, retained cases versus totals | That a human gave a review approval. Approvals live in the local seal; the `test:protected-approve` line in the Change history is plain text and can be hand-written |
| Plan, records and catalog agree: plan ledger digest, catalog parses, bindings to catalog, plan, policy and workflow are still fresh, registered test files still exist | That the suites really ran and the report was not faked. Reports and artifacts stay on the author's machine; CI only has the digests in the record |
| Case-level verdicts under the policy of the current step: runs present and passing, registered cases present in the report, coverage, benchmarks, flaky limits, scenario tracing | That the declared identity is real. Identities are declared, not authenticated |
| Candidate: the workspace fingerprint bound into the records equals the fingerprint of the checked-out tree | |
| Protected files (catalog, baselines, known failures, project workflows) changed since the Change started have an approval line in the Change history with the same content digest | |
| Anchors written to git notes, when present | |

Every report prints this split, so a green check is never read as more than it is. To get evidence
whose root is the runner instead of the author's machine, add a separate job that re-runs the
suites there (`TENON_TEST_TRUST=1 TENON_USER=ci@example.com tenon test run <change> --stage`). A
passing re-run shows the suites pass on a machine you control; the records it writes belong to the
CI user and do not make the committed records any more trustworthy.

## Add it to a pull request

The action lives in this repository and ships with each release. Pin it to a release tag or a
commit SHA of a release that contains `.github/actions/tenon-verify` (replace `vX.Y.Z` below); the
CLI it runs is the single-file bundle inside that same release, so nothing is downloaded at run time.

```yaml
name: Tenon verify
on:
  pull_request:

permissions:
  contents: read
  security-events: write   # upload SARIF to code scanning

jobs:
  tenon-verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: jefferysha/tenon/.github/actions/tenon-verify@vX.Y.Z
        with:
          expected-version: 'X.Y.Z'
```

The same file is kept at `docs/examples/github-actions/tenon-verify.yml`. For pull requests from
forks the token is read-only and the SARIF upload is skipped without failing the job; set
`upload-sarif: 'false'` there. The check itself still runs and still fails the job.

Action inputs:

| Input | Default | Meaning |
| --- | --- | --- |
| `since` | `origin/<base ref>` on pull requests | Verify the Changes touched since the merge-base with this ref |
| `change` | | Verify only this Change |
| `all-open` | `false` | Verify every open Change |
| `step` | | Judge against this workflow step's test policy instead of the Change's current step |
| `candidate` | `error` | `error`, `warn` or `off`; see Candidate mismatch |
| `require-anchor` | `false` | Require an anchor note and a chain head equal to it |
| `fetch-notes` | `true` | Fetch `refs/notes/tenon` from `origin` (best effort) |
| `upload-sarif` | `true` | Upload the SARIF report |
| `sarif-category` | `tenon-verify` | Code scanning category |
| `language` | | `zh` or `en`: language of the job summary, the SARIF messages and the log; empty keeps the CLI default (Chinese unless the runner's locale says otherwise) |
| `node-version` | `22` | Node.js version |
| `expected-version` | | Fail unless the pinned release has exactly this version |
| `cli` | | Use another CLI entry instead of the bundle in the release |

Outputs: `exit-code`, `sarif-path`, `summary-path`, `report-path`. The last step of the action fails
the job when `exit-code` is not `0`, after the SARIF upload had its chance to run.

## What it checks

`tenon verify --ci` reads only committed files, takes no lock and writes nothing except the
output files you name. For every selected Change it runs the checks below. Finding codes are the
SARIF rule ids prefixed with `tenon/`.

| Check | Findings |
| --- | --- |
| Record chain of every user directory | `record-chain-broken` |
| Records agree with themselves | `record-misplaced`, `record-inconsistent` |
| Plan, records and catalog agree; policy of the current step | `test-plan-missing`, `test-plan-tampered`, `test-catalog-missing`, `test-not-run`, `test-stale`, `test-failed`, `registered-test-not-executed`, `coverage-below`, `scenario-uncovered` and the rest of the test-policy codes shown by `tenon test status` |
| Registered test files still exist | `plan-file-missing` |
| Candidate tree | `candidate-mismatch` |
| Protected file approvals | `protected-unapproved`, `protected-changed-after-approval`, `protected-approval-unbound` (warning), `protected-diff-unavailable` |
| Anchors | `anchor-mismatch`, `anchor-behind` (warning), `anchor-unverifiable` (warning), `anchor-missing` (only with `--require-anchor`) |

Which step is judged: the Change's current step; if it declares no test policy, the closest earlier
step that does (a finished Change is therefore judged at verify). Which chain is judged: the
Change owner's. If the owner has no records and exactly one other user has, that chain is used with
the warning `owner-chain-missing`. Other users' chains are only checked for integrity.

Test integrity is judged with the same step policy as the local gate, for steps that run tests or set
`integrity: block`. It reads the committed diff since the Change started for evidence that got weaker:
a deleted test file, fewer declared cases, new skip markers, fewer assertions, rewritten snapshots
(`tenon test integrity <change>` lists them all). With `integrity: block` in the step's `test_policy`,
any signal is the error finding `test-integrity`, and so is a diff that cannot be read
(`files-diff-unavailable`, for example on a shallow clone), so it fails closed. With the default
`integrity: notice`, signals are note-level `test-integrity` findings that never change the exit
code, and an unreadable diff is the note `files-unchecked`. The signals are text heuristics over diff
lines: they point at what deserves a look; they do not prove that tests were weakened, or that they
were not.

## Candidate mismatch

A test record binds the content fingerprint of the whole workspace it ran on. The check compares it
with the fingerprint of the checked-out tree. A mismatch usually means the code changed after the
tests ran; the message lists the files committed after the record finished. It can also come from
differences between the author's workspace and a clean checkout: git-ignored build output inside
the candidate scope, file or directory permission bits (umask), or line-ending conversion. Run the
action right after checkout, before any build step, and declare test output directories in the
catalog. `--candidate warn` turns the finding into a warning; `--candidate off` skips the
comparison and adds a note.

## Run it locally

```text
tenon verify --ci --since origin/main
tenon verify --ci --change add-login --format json --out tenon-verify.json
tenon verify --ci --all-open --also sarif=tenon.sarif --also markdown=summary.md
```

Exit codes: `0` passed, `2` at least one error finding, `1` usage or environment error (missing
selector, unknown Change, unwritable output). Formats: `text` (default, readable, always ends with
the trust split), `json` (`tenon-verify-ci/v1`), `sarif` (2.1.0, one location per result, stable
`partialFingerprints`), `markdown` (job summary). With `--out`, stdout still prints the text
summary.

Language: every format (the text and Markdown reports, the SARIF messages, the JSON `message` and
`trust` strings, the usage errors) follows the CLI language: `TENON_LANG=en|zh`, then `LC_ALL`,
`LC_MESSAGES`, `LANG`; with no signal, or `C`/`POSIX`, the report is Chinese as before. In the
GitHub Action set the `language` input (`zh` or `en`), which is passed to the CLI as `TENON_LANG`.
Finding codes, levels, exit codes, JSON field names and the `[FAIL]`/`[WARN]`/`[NOTE]` markers
never depend on the language. A test-policy finding is one sentence in the Chinese report; in
English it is the short label of its code plus the object it points at (suite id, file path), with
the same fix command.

## Anchor the evidence in git notes (optional)

An anchor copies the record chain head into a git note on the delivery commit. The note lives in
`refs/notes/tenon`, outside the pull request branch, so rewriting the chain (recomputing every
digest) leaves an anchored head that is no longer in the chain.

```text
tenon evidence export add-login --format git-notes --anchor --apply
git push origin refs/notes/tenon
```

`tenon verify --ci` reads the notes of the last 1000 commits. The newest anchored entry for the
owner's chain must be contained in the chain: equal to the head means `verified`; records appended
afterwards give the warning `anchor-behind`; a head that is not in the chain is `anchor-mismatch`.
`--require-anchor` turns a missing or lagging anchor into an error. What an anchor adds is a second
place an attacker must also write; it does not prove the head came from a trusted machine, and it
does not stop records appended after the anchor unless `--require-anchor` is set. Restrict who can
push `refs/notes/tenon` to make that second place meaningful.

## Export the evidence

```text
tenon evidence export <change> --format agent-trace [--contributor ai --model anthropic/claude-opus-4-5]
tenon evidence export <change> --format otel
tenon evidence export <change> --format git-notes [--anchor] [--apply]
tenon evidence export <change> --format trailer [--apply]
```

Everything prints to stdout (or `--out <file>`); only `--apply` writes the repository. The record
chain must be intact (exit `2` otherwise). All outputs are deterministic for the same evidence.

- `agent-trace`: an [Agent Trace](https://agent-trace.dev) record (specification version `0.1`).
  Files and added line ranges come from the Change diff; the contributor is `unknown` unless you
  assert `human`, `ai` or `mixed`, because Tenon does not know who wrote which line. Tenon's own
  evidence sits in `metadata["dev.tenon"]`.
- `otel`: OTLP/JSON spans shaped like the OpenTelemetry GenAI conventions: `invoke_workflow` for the
  Change, `tenon.step` per step visit, `invoke_agent` per agent run, `execute_tool` per suite run.
  Nothing is sent anywhere.
- `git-notes`: the JSON note described above on `--commit` (default `HEAD`), merged with notes of
  other Changes on the same commit. A foreign note is never overwritten.
- `trailer`: `Tenon-Change:` and `Tenon-Evidence:` (the chain head digest). `--apply` amends `HEAD`
  with `git interpret-trailers`, refuses staged changes and any commit but `HEAD`, and changes the
  commit id. Write notes after amending, not before.

## Expected result

- A pull request whose Changes carry consistent, fresh evidence passes: exit code `0`, a job summary
  with one row per Change, and an empty (or note-only) SARIF upload that closes earlier alerts.
- A pull request with a tampered, deleted, stale or misplaced record, a deleted registered test file,
  a protected configuration change without an approval line, or a rewritten anchored chain fails with
  exit code `2` and a code scanning alert on the offending file.
- Every report, green or red, lists what CI cannot prove without the local key.

## Verification

```bash
tenon verify --ci --change <change> --format json | head -40
tenon verify --ci --since origin/main --also sarif=/tmp/tenon.sarif
```

## Common failures

| Symptom | Cause and fix |
| --- | --- |
| `protected-diff-unavailable` | Shallow checkout. Use `fetch-depth: 0` |
| `candidate-mismatch` right after a clean author run | Ignored build output, permission bits or line endings differ; see Candidate mismatch |
| `record-chain-broken` | A record was edited, removed or added by hand. Re-run `tenon test run <change> --stage` locally and commit the new records |
| `protected-unapproved` | A catalog, baseline, known-failures or workflow change has no review approval line. Get it approved with `tenon review request` and `tenon review acknowledge`, then commit the Change history |
| `anchor-mismatch` | The chain was rewritten after it was anchored. This is the case the anchor exists for; do not re-anchor to silence it |
| Upload step warns about permissions | The token is read-only (fork pull request). Set `upload-sarif: 'false'` |

## Next action

Add the workflow, open a pull request that touches a governed Change, and read the job summary.
See the [CLI reference](cli-reference.md) for every option and the [Security model](security-model.md)
for the local trust boundary.
