# Contributor development

## Goal

Build and verify Tenon from source without drifting tracked bundles,
generated workflow assets, public contracts, or documentation.

## Prerequisites

- Node.js 22 or later
- npm
- Git
- Docker only for sandcastle/real AFK tests
- credentials only for explicitly selected real-host integration tests

## Setup

```bash
git clone https://github.com/jefferysha/tenon.git
cd tenon
npm ci
npm run build
```

The root package is private. This source workflow is not a published global npm
installation path.

## Architecture

| Path | Responsibility |
| --- | --- |
| `packages/kernel` | state, Workflows, Tracks, guards, evidence, persistence, loops |
| `packages/cli` | command interface and runtime assembly |
| `packages/server` | local HTTP/SSE server and cross-package orchestration |
| `packages/dashboard-app` | React SPA |
| `packages/automation` | AFK queue, admission, runners, lifecycle |
| `packages/channel` | advanced/compatibility worker bus |
| `packages/tap` | local proxy and trace store |
| `hooks` | thin host hook shims |
| `adapters` | host capability/install adapters |
| `templates` | manifest, Skill sources, built-in Workflows |
| `skills` | distributed Tenon Skills |

Read [CONTRIBUTING.md](../../CONTRIBUTING.md), `AGENTS.md`, and the relevant
`.agent-rules/` files before editing.

## Verification

Core:

```bash
npm test
npm run test:web
npm run typecheck:web
npm run build
```

`npm test` runs Vitest with at most `min(8, cores)` workers (`vitest.config.ts`). The
real-filesystem, subprocess and Docker integration suites time out when a many-core machine
runs its default of about one worker per core, so the cap keeps local runs and CI on one
concurrency rule; pass `--maxWorkers=N` to override it for a single run. The Vitest setup
(`tools/vitest.isolate-runtime-home.mjs`) also gives every test file its own declared
identity and runtime home and clears `TENON_RUNTIME_ROOTS`, `TENON_BASE_BRANCH` and
`TENON_CHANGE_NAME`, whatever the host process declares, so the suites pass the same way inside
a Tenon session or under `tenon test run`. Test cleanup that removes temp directories goes
through `rm` with retries (the CLI harness `rm`, `rmDir` in the tap test support) so a late
async write cannot turn into an `ENOTEMPTY` that hides the real failure.

Contracts and distribution:

```bash
npm run check:comments
npm run check:architecture
npm run check:default-workflow-freshness
bash tools/test-hooks.sh
bash tools/test-adapters.sh
bash tools/verify-skills.sh
bash tools/test-bundle.sh
npm run oracle
git diff --check
```

Dashboard browser e2e and benchmarks (run `npm run build` first):

```bash
npm run test:e2e -- --project=chromium
npm run test:e2e
npm run bench:status
npm run bench:snapshot
npm run bench:snapshot:large
```

`e2e/dashboard/a11y.spec.ts` runs axe-core (`@axe-core/playwright`) on the main pages (workspace
incl. the Tests tab, workflow overview and stage, projects incl. the Tests segment, every library
section, skills and a skill detail, the new-project wizard and the settings popover) in light and dark;
the run fails on any `serious` or `critical` violation and prints the rule, the nodes and the fix hint.
Add a page or a state there when you add one to the app.

`test:e2e` drives the built CLI and Dashboard from `e2e/dashboard/` with Playwright
(chromium and webkit projects; install with `npx playwright install chromium webkit`). It seeds
throw-away projects in an isolated `HOME` and `TENON_RUNTIME_HOME` and starts the
Dashboard on a random port, so it never touches your real Tenon state. The same suites are
registered in `.tenon/tests/catalog.yaml` (`dashboard-e2e`, `bench-status`,
`bench-snapshot`, `bench-snapshot-large`, and the rest of the repository's own suites); run them through
`tenon test run <change> --suite <id>`. CI runs and blocks on Chromium only and uploads
`playwright-report/` and `test-results/` when it fails; WebKit is not installed in CI (a
non-blocking WebKit job would rebuild the whole tree, and Linux WebKit has no evidence yet),
so run both projects locally before changing the pages they cover.

`tenon dashboard` only starts its server with a Node whose executable and parent directories
are not group- or world-writable (sticky directories excepted) and are owned by root or the
current user. A Node from a shared tool cache (for example `actions/setup-node` on GitHub-hosted
runners) fails that check, and the guard stays as it is. `tools/lib/isolated-tenon.mjs`, used by
the e2e server and the benchmarks, checks `process.execPath` against the same conditions and,
only when it fails, copies it to `<scratch>/node-bin/node` (mode 0700 directory, 0755 file) and
runs every `tenon` child with that copy; the scratch cleanup removes it. The copy must run on
its own (an official binary does). A Node that fails the check and also loads sibling shared
libraries (for example Homebrew's `libnode`) cannot be copied; the helper then stops with an
error instead of falling back to the untrusted one.

Benchmark regressions (`max_regression_pct: 15`) are judged against a baseline of the same
machine profile. Baselines are not committed from a developer laptop: CI runs the two
suites with `tenon test run`, and after a green run it writes the run as a baseline candidate
to `.tenon/tests/baselines/<suite>/<profile>.json` and uploads it as the
`bench-baseline-candidate` artifact. To establish or refresh the CI-profile baseline,
download that artifact from a green `main` run and commit the files unchanged. Until the
CI profile has a baseline the run only reports `baseline-missing`.

The repository has no general lint or format npm script. Do not claim one ran.

## Change-specific responsibilities

- Workflow template changes: regenerate/check the tracked default artifact.
- CLI/server/web source: rebuild the tracked distribution assets.
- Adapter changes: update registry truth and run conformance tests.
- Skill changes: update sources/locks and run Skill verification.
- Dashboard behavior: run focused tests, full web checks, and real browser
  acceptance against the exact built 18765 release.
- Public behavior: update relevant contracts and docs in the same Change.
- Security/persistence/concurrency: add failure/abuse coverage and document
  recovery.

## Expected result

Source, generated assets, bundles, contracts, tests, and documentation describe
the same behavior.

## Common failures

- editing `dist` or generated workflow files by hand;
- changing source without rebuilding tracked bundles;
- adding a host without registry/conformance evidence;
- bypassing review/document receipts to make a test pass;
- committing credentials, local paths, caches, or traces;
- reporting skipped credential tests as passing.

## Next action

Follow [CONTRIBUTING.md](../../CONTRIBUTING.md) for patch/PR expectations and
[SECURITY.md](../../SECURITY.md) for sensitive findings.

