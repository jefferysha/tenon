# Contributing to Tenon

Thank you for improving Tenon. Contributions are welcome when they keep
the workflow, evidence, distribution, and documentation surfaces aligned.

By participating, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

1. Search existing
   [Issues](https://github.com/jefferysha/tenon/issues) and current
   repository work.
2. Use an Issue for non-sensitive bugs or a proposal when a change affects
   public behavior, contracts, state, security, distribution, or multiple
   packages.
3. Report vulnerabilities privately through [SECURITY.md](SECURITY.md), never
   in a public Issue.
4. Read `AGENTS.md`, `.agent-rules/COMMON.md`, and the relevant frontend/backend
   rule before modifying code.

Small documentation corrections and narrowly scoped tests can proceed directly
as a focused patch.

## Development setup

Requirements:

- Node.js 22 or later
- npm
- Git
- Docker only for sandcastle/AFK integration work
- real host credentials only for explicitly selected credentialed tests

```bash
git clone https://github.com/jefferysha/tenon.git
cd tenon
npm ci
npm run build
```

The root workspace package is private. Do not document a global npm install as
the contributor or user installation path.

## Repository boundaries

- `packages/kernel` owns domain state, Workflows, Tracks, guards, evidence,
  persistence, and loop policy.
- `packages/cli` owns command parsing and runtime assembly.
- `packages/server` owns the loopback HTTP/SSE boundary.
- `packages/dashboard-app` owns the React SPA.
- `packages/automation` owns AFK admission, queue, runner, and lifecycle.
- `packages/channel` is the advanced/compatibility event bus, not canonical
  Workflow state.
- `packages/tap` owns sensitive local traffic diagnostics.
- `hooks`, `adapters`, `templates`, and `skills` are distributed product
  surfaces and must remain synchronized with contracts/tests.
- Tracked `dist` and generated workflow files must be rebuilt, not hand-edited.

See [contributor development](docs/usage/contributor-development.md) for the
module and verification map.

## Design and implementation expectations

- Keep changes minimal and within the owning package.
- Preserve CLI/YAML/JSON/JSONL/hook/adapter compatibility unless an approved
  change explicitly migrates it.
- Do not bypass review, Skill, document, guard, lock, CAS, or atomic-publish
  behavior to make a test pass.
- Keep Dashboard writes loopback/Host/token/root protected.
- Treat shell input, filesystem paths, Docker, Git, TLS, and deserialized data
  as untrusted boundaries.
- Never commit credentials, tokens, private keys, real user data, raw Tap
  traces, machine-specific caches, or local absolute paths.
- Update public docs and contracts when behavior changes.
- Do not claim tests, hosts, releases, versions, SLAs, or hosted services that
  are not verified.

## Tests

Run focused checks while developing, then the affected full gates.

Core:

```bash
npm test
npm run test:web
npm run typecheck:web
npm run build
```

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

Run `npm run check:docs` when that script exists in the branch. Dashboard
behavior requires focused tests, the full web checks, and real-browser
acceptance against the exact built local release.

Some real-host integration cases require credentials. If they are skipped,
report the skips honestly; do not count them as passes.

The repository does not currently define a general lint or format npm script.
Do not claim one ran.

## Patch and pull request checklist

- [ ] The problem and intended outcome are clear.
- [ ] The change stays within the correct package/domain boundary.
- [ ] New behavior has failure-path tests.
- [ ] Generated/tracked distribution assets are fresh.
- [ ] Relevant contracts and usage docs are updated.
- [ ] Security, migration, and rollback implications are described.
- [ ] Commands actually run and their results are recorded.
- [ ] Credential-gated or otherwise unrun checks are disclosed.
- [ ] `git diff --check` passes.
- [ ] No secrets or sensitive diagnostics are present.

Keep pull requests reviewable. Separate unrelated refactors from functional
changes. A PR description should explain why the change exists, what public
behavior moved, how it was verified, and how to recover if it fails.

## Adding public extension surfaces

### Workflow or Track

Validate the graph/policy, protect built-in identities, test effective-plan
projection, and document the document-contract behavior.

### Skill

`templates/skill-sources.yaml` is the only tracked provenance source for
Tenon-owned Skills. It uses schema v3 (`tree-sha256-v1`) with a bundled
`source_ref`, canonical `sha256:` content hash, and immutable coordinate. After
editing Skill bytes, run the explicit authoring sync and inspect its diff:

```bash
npm run sync:skill-provenance
bash tools/verify-skills.sh --quiet --root "$PWD"
```

Third-party Skills are not edited in this repository: add or change a row in
`skills/sources.yaml` (`{ repo, path, ref: default-branch, license_expected }`,
MIT or Apache-2.0 only) and fetch it into the checkout. The fetched directories
and `skills/skills.lock.json` are gitignored, and the verifier proves them
against that lock:

```bash
npm run skills:fetch
bash tools/verify-skills.sh --quiet --root "$PWD"
```

The packaged `internal-skill-provenance verify|sync --root <path>` command is
the shared implementation. `verify` is read-only and must pass before
install/release activation; `sync` atomically writes only the canonical
registry. Do not create or restore `skills-lock.json`; it is a rejected legacy
provenance source. Generic external/custom Skill metadata may remain a
compatibility projection, but it is not bundled release provenance.

### Host adapter

Add the capability row to `adapters/registry.yaml`, state degraded capabilities
honestly, add conformance tests, and run `bash tools/test-adapters.sh`.

### CLI or API behavior

Keep parsing/DTO validation at the boundary, domain rules in the owning package,
machine-readable output stable, and documentation/help synchronized.

## Community and support

Use [SUPPORT.md](SUPPORT.md) for questions and non-sensitive defects. Maintainers
may close reports that omit a reproducible case, include secrets, or combine
unrelated changes.
