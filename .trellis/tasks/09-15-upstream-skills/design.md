# Design: upstream skills

> **Parent overrides** (`.trellis/tasks/09-15-tenon-next-capabilities/design.md` §9 wins over this file): X6 renamed ids stand; X13 top-level skills view; X14 measure hook dispatch latency before/after, add a stat-keyed payload digest cache in the bootstrap if p50 grows > 50 ms; X18 (the isolated real install in your step 14 may run with fixture-free sources but must not touch the real installed runtime or host global skill dirs).

Binding contracts come from `.trellis/tasks/09-15-tenon-next-capabilities/design.md`, mainly §3 "Upstream skills" and §7.
Anything this child needs that differs from the parent is listed in "Contract change requests". The parent file is not edited.

## 1. Current state

Every claim below was checked in the code on 2026-09-15.

### 1.1 How skills ship today

- There are 62 skill directories and all of them are tracked in git. Every one is registered as bundled in
  `templates/skill-sources.yaml:6-68` (schema v3, `tree-sha256-v1`).
- The strict parser only accepts `bundled` entries whose source is `tenon`
  (`packages/kernel/src/skills/source-registry.ts:341-347`). Unknown fields are rejected (`:225-249`).
- The verifier is `verifySkillProvenance` (`packages/automation/src/skills/skill-provenance.ts:111-233`). It requires set
  equality between registry entries and physical directories (`:181-199`) and hash equality (`:201-229`). It only counts
  directories (`:77-83`), so a non-directory file such as `skills/EXTERNAL-SKILLS.md` is ignored.
- `tools/verify-skills.sh:310-337` hands this verification to the bundled CLI through `internal-skill-provenance verify`.
- `tools/verify-skills.sh:283-308` separately requires every `external-skill:` marker to be declared in
  `skills/EXTERNAL-SKILLS.md`.
- `skills/EXTERNAL-SKILLS.md:9` says setup "must never download a third-party skill marketplace".
- `internal-skill-provenance sync` rewrites the registry. It fails when a physical directory is not declared
  (`packages/cli/src/commands/internal-skill-provenance.ts:250-281`).

### 1.2 Where hosts load skills from

- Claude Code loads skills from its install path. Codex loads them from
  `~/.codex/plugins/cache/tenon/tenon/<version>/skills`.
- Tenon learns that root only from the host's inventory: `parseHostPluginInventory`
  (`packages/cli/src/commands/plugin-host.ts:62-172`) reads `tenonRoot` from Codex `source.path` or Claude `installPath`.
- Hooks and the CLI run from Tenon's managed release payload. `runtime/tenon-bootstrap.mjs:923-953` exports
  `PLUGIN_ROOT`, `TENON_ACTIVE_RELEASE_ROOT`, `TENON_HOST_PLUGIN_ROOT` and `TENON_CODEX_PLUGIN_ROOT`.
- Codex skill evidence trusts a `skills/<id>/SKILL.md` under one of three roots
  (`packages/cli/src/codexSkillTrust.ts:222-247`): the selected cache root, the active release root, or the development
  root.
- Hook-side evidence looks up `<root>/skills/<id>/SKILL.md` (`hooks/skill-evidence.sh:149-153,237`).

### 1.3 How a release is published

1. Setup calls `cmdSetupHost`, whose `prepareCandidate` callback is at `packages/cli/src/commands/setupHost.ts:171-186`.
   It calls `installNativePluginCandidate` and then `verifyPackagedAssets`.
2. Update calls `runNativeUpdate`, whose `prepareCandidate` is at `packages/cli/src/commands/update-native.ts:164-317`:
   - The host-exact branch (`:213-251`) reuses the host root without changing it.
   - The mutation branch (`:253-316`) runs `nativeUpdatePlan` and then `verifyUpdatedRoot` (`:309`).
3. `publishManagedRelease` (`packages/cli/src/commands/release-coordinator.ts:39-67`) calls
   `transaction.activate(candidate.candidateRoot, …)` (`:222`), which reaches `stageAndActivateUnderLock`
   (`packages/cli/src/runtime/release-store.ts:230-342`). That function:
   - copies `PAYLOAD_ENTRIES`, which includes `skills` (`packages/cli/src/runtime/release-store-codecs.ts:22-36`),
     through `copyReleasePayload` (`packages/cli/src/runtime/release-payload.ts:84-96`);
   - runs `verifyReleasePayload`, which calls `verify-skills.sh` (`:276-308`);
   - hashes the payload;
   - re-inspects the candidate and refuses if the digest drifted (`release-store.ts:245-256`).
4. The host root is proven against the stable tag by `nativeHostMatchesStableTarget`
   (`packages/cli/src/commands/managed-host-observation.ts:113-132`). Part of that proof is
   `pluginPayloadMatchesMarketplace` (`:93-110`), which runs `git diff --no-index` for every payload entry, including
   `skills`, between the marketplace checkout and the plugin root. `install.sh:1026-1037` runs the same comparison.
   - If the marketplace checkout and the plugin root are the same directory, the check becomes "clean worktree" instead:
     `git ls-files --others --exclude-standard` (`packages/cli/src/commands/managed-host-state.ts:200-206`).
5. After activation, the host root digest must equal the active `payloadDigest`. This is checked in:
   - `setupHost.ts:209-214`
   - `update-native.ts:341-345`
   - `host-convergence-recovery.ts:75-78`
   - `doctor-product-identity.ts:245-247`
6. The bootstrap re-hashes the active payload on every CLI or hook dispatch (`runtime/tenon-bootstrap.mjs:251,1014`).
   Today's payload is 7.0 MB (`du` over `PAYLOAD_ENTRIES`).

### 1.4 Other skill-related code

- **Setup skill installer:** `cmdSetupSkills` (`packages/cli/src/commands/setupSkills.ts:137-195`) and `buildSkillsPlan`
  (`setupSkillsPlan.ts:119-266`) install `skills-cli`, `claude-plugin` and `npm` sources. Because the strict registry
  only allows `bundled`, they install nothing in production. Setup still calls the planner (`setup.ts:69`) and exposes
  it as the `setup skills` subcommand (`setup.ts:145-146`).
- **Network access and retries:**
  - All git network calls go through `SetupEnv.runCommand`.
  - Retry exists only in the private `runRemoteGit` (`packages/cli/src/commands/stable-release.ts:96-109`).
  - The clean-install acceptance already redirects GitHub to a local bare repository with
    `url.file://….insteadOf` (`tools/clean-codex-install-acceptance.mjs:577`).
- **Doctor:**
  - Check ids are add-only (`packages/cli/src/commands/doctor.ts:8-9`).
  - Skill rows: `quality:verify-skills` and `skills:workflow-phase` (`doctor.ts:302-303`); `skills:mandatory` and
    `skills:recommended` (`:317-326`, computed by `doctor-skills.ts:78-129`); `integration:codex-project-skills`
    (`:328-339`).
- **Server:**
  - `GET /api/skills/registry` (`packages/server/src/serverGetRoutes.ts:253-259`) returns `listAllSkillsDetailed`
    (`packages/server/src/skillsRegistry.ts:306-353`).
  - That function merges local skill directories, `EXTERNAL-SKILLS.md` sections (`:212-229`) and a hard-coded
    `BUILTIN_SKILLS = verify, run, code-review, security-review` (`:14`).
  - The plugin root comes from `repoRootForSkills()` (`serverGetRoutes.ts:110-112`), which is the active payload when the
    server runs from a release.
- **Dashboard:**
  - `VIEWS = ['progress','workbench']` (`packages/dashboard-app/src/shell/views.ts:6`); `TopBar.tsx:155-167` renders
    every view.
  - `App.tsx:24-28,327-344` lazy-loads and renders views. Nav labels are in `i18n/translations.ts:32` (zh) and `:1993`
    (en).
  - No page shows skill source, commit or license.
- **References to skills that will be removed:**
  - `skills/tenon-explore/SKILL.md:146,170,299` (`zoom-out`)
  - `skills/tenon-build/SKILL.md:184-185,193,220-222,404-405` (`shadcn-ui`, `tailwind-css-patterns`, `uiuxdesign-pro`,
    `react-best-practices`)
  - `templates/manifest.yaml:64` (`code-review`)
  - `packages/server/src/skillsRegistry.ts:14`
  - `templates/workflows/default.yaml` references none of the removed or renamed ids (counted by grep).
- **Upstream facts** (checked with `gh api` and `git ls-remote`):
  - All 12 repositories exist. Every default branch is `main` except `alchaincyf/huashu-design`, which uses `master`.
  - Where licenses come from:
    - Repository-root `LICENSE` with MIT text: obra, OpenSpec, ECC, mattpocock, vercel-labs/skills, hue, huashu,
      hallmark, taste.
    - Root `LICENSE.md` (MIT): shadcn-ui/ui.
    - Per-skill `LICENSE.txt` (Apache-2.0): anthropics/skills.
    - vercel-labs/agent-skills has no license file. `react-best-practices/SKILL.md` has frontmatter `license: MIT`;
      `web-design-guidelines` only has a root `README.md` section `## License` whose value is `MIT`.
  - Frontmatter names differ from local ids in two places: `skills/react-best-practices` is named
    `vercel-react-best-practices`, and `skills/taste-skill` is named `design-taste-frontend`. `skills/shadcn` is named
    `shadcn`.
  - huashu-design is 189 files and 33.2 MB. 32.6 MB of that is `assets/*.mp3`, which the skill references.
  - A probe of `git clone --depth=1 --filter=blob:none --no-checkout` plus `sparse-checkout set --no-cone /skills/shadcn/`
    on `shadcn-ui/ui` finished in 7.9 s and fetched 16 files. A full checkout of the huashu-design root did not finish
    within 290 s on this machine.

## 2. Architecture and boundaries

```text
skills/sources.yaml (tracked, in tag tree)          templates/skill-sources.yaml (tracked, Tenon-owned bundled only)
        │                                                        │
        ▼                                                        ▼
kernel skills/upstream-sources.ts  ── pure parse/serialize/view ──  kernel skills/source-registry.ts (unchanged schema)
        │
        ▼
cli upstream-skills/  (git fetch, license, stage, apply, lock, run report)   ◄── SetupEnv.runCommand('git', …)
        │  called inside the managed transaction, after the host wrote its plugin root, before candidate verification
        ▼
<host plugin root>/skills/<upstream-id>/…  +  <host plugin root>/skills/skills.lock.json
        │  existing copyReleasePayload copies `skills` (PAYLOAD_ENTRIES) → payload digest covers upstream bytes
        ▼
<dataRoot>/releases/sha256-…/payload/skills/…       (active release; Codex trust root; server repoRootForSkills)
        │
        ├─ automation verifySkillProvenance: bundled registry ∪ lock  (verify-skills.sh, setup/update/doctor/release)
        ├─ cli skill-provenance-locator: locate lock ids with tree hash check (AFK bundle assembly)
        ├─ cli doctor: skills:upstream + `--skills` table
        └─ server GET /api/skills/sources → dashboard view `skills` (技能)
<stateRoot>/skills/last-update.json  (last run outcomes and failure reasons; outside the payload digest)
```

### 2.1 Who owns what

| Layer | Owns | Does not own |
| --- | --- | --- |
| kernel | Pure parsers and codecs for `sources.yaml`, `skills.lock.json` and `last-update.json`; the view builder | Any fs, git or network access |
| cli `upstream-skills/` | Git transport, license detection, staging, per-skill atomic apply, lock write, run report | Host CLI mutations, activation |
| cli host flows | Deciding when to run the install (setup and update `prepareCandidate`); the stable proof entry list | Fetch internals |
| automation | Provenance verification of registry plus lock against physical directories | Fetching |
| server | Read-only `GET /api/skills/sources` | Fetching, network |
| dashboard | Showing the view | Everything else. It never calls models or the network beyond its own server |

### 2.2 Rules

1. **Only the repositories in `sources.yaml` are fetched.** Every URL is built as `https://github.com/<repo>.git` from a
   validated `owner/name`. `sources.yaml` is part of the tag tree, so the stable proof also covers the list of sources
   (§6.3).
2. **Only two things are written in the host plugin root:** `skills/<id>/` for ids in `sources.yaml`, and
   `skills/skills.lock.json`. This makes Tenon a second writer of the host plugin root alongside the host CLI; see
   contract change request 3.
3. **Upstream content is never pinned.** Every run resolves the default-branch HEAD.
4. **Every skill is atomic.** A skill directory is always either the complete new content, the complete previous
   content, or absent. It is never partly written.
5. **Nothing is written when nothing changed.** If every skill's content hash is unchanged, the lock bytes stay the same,
   the payload digest does not change, and update reports `current`.
6. **The Dashboard and doctor use no network.** They read the lock and the last run report only.

## 3. Data model and file formats

### 3.1 `skills/sources.yaml` (checked in, hand-edited)

The format is the same narrow flow YAML used by `templates/skill-sources.yaml`, keyed by id:

```yaml
# skills/sources.yaml — upstream skills installed into the Tenon plugin root on every setup and update.
version: 1
skills:
  brainstorming: { repo: obra/superpowers, path: skills/brainstorming, ref: default-branch, license_expected: MIT }
  writing-plans: { repo: obra/superpowers, path: skills/writing-plans, ref: default-branch, license_expected: MIT }
  test-driven-development: { repo: obra/superpowers, path: skills/test-driven-development, ref: default-branch, license_expected: MIT }
  subagent-driven-development: { repo: obra/superpowers, path: skills/subagent-driven-development, ref: default-branch, license_expected: MIT }
  dispatching-parallel-agents: { repo: obra/superpowers, path: skills/dispatching-parallel-agents, ref: default-branch, license_expected: MIT }
  verification-before-completion: { repo: obra/superpowers, path: skills/verification-before-completion, ref: default-branch, license_expected: MIT }
  finishing-a-development-branch: { repo: obra/superpowers, path: skills/finishing-a-development-branch, ref: default-branch, license_expected: MIT }
  openspec-propose: { repo: Fission-AI/OpenSpec, path: skills/openspec-propose, ref: default-branch, license_expected: MIT }
  openspec-explore: { repo: Fission-AI/OpenSpec, path: skills/openspec-explore, ref: default-branch, license_expected: MIT }
  openspec-apply-change: { repo: Fission-AI/OpenSpec, path: skills/openspec-apply-change, ref: default-branch, license_expected: MIT }
  openspec-archive-change: { repo: Fission-AI/OpenSpec, path: skills/openspec-archive-change, ref: default-branch, license_expected: MIT }
  browser-qa: { repo: affaan-m/ECC, path: skills/browser-qa, ref: default-branch, license_expected: MIT }
  code-tour: { repo: affaan-m/ECC, path: skills/code-tour, ref: default-branch, license_expected: MIT }
  deep-research: { repo: affaan-m/ECC, path: skills/deep-research, ref: default-branch, license_expected: MIT }
  deployment-patterns: { repo: affaan-m/ECC, path: skills/deployment-patterns, ref: default-branch, license_expected: MIT }
  docker-patterns: { repo: affaan-m/ECC, path: skills/docker-patterns, ref: default-branch, license_expected: MIT }
  e2e-testing: { repo: affaan-m/ECC, path: skills/e2e-testing, ref: default-branch, license_expected: MIT }
  frontend-patterns: { repo: affaan-m/ECC, path: skills/frontend-patterns, ref: default-branch, license_expected: MIT }
  github-ops: { repo: affaan-m/ECC, path: skills/github-ops, ref: default-branch, license_expected: MIT }
  market-research: { repo: affaan-m/ECC, path: skills/market-research, ref: default-branch, license_expected: MIT }
  nestjs-patterns: { repo: affaan-m/ECC, path: skills/nestjs-patterns, ref: default-branch, license_expected: MIT }
  postgres-patterns: { repo: affaan-m/ECC, path: skills/postgres-patterns, ref: default-branch, license_expected: MIT }
  python-patterns: { repo: affaan-m/ECC, path: skills/python-patterns, ref: default-branch, license_expected: MIT }
  python-testing: { repo: affaan-m/ECC, path: skills/python-testing, ref: default-branch, license_expected: MIT }
  react-patterns: { repo: affaan-m/ECC, path: skills/react-patterns, ref: default-branch, license_expected: MIT }
  search-first: { repo: affaan-m/ECC, path: skills/search-first, ref: default-branch, license_expected: MIT }
  security-review: { repo: affaan-m/ECC, path: skills/security-review, ref: default-branch, license_expected: MIT }
  grill-with-docs: { repo: mattpocock/skills, path: skills/engineering/grill-with-docs, ref: default-branch, license_expected: MIT }
  improve-codebase-architecture: { repo: mattpocock/skills, path: skills/engineering/improve-codebase-architecture, ref: default-branch, license_expected: MIT }
  prototype: { repo: mattpocock/skills, path: skills/engineering/prototype, ref: default-branch, license_expected: MIT }
  to-spec: { repo: mattpocock/skills, path: skills/engineering/to-spec, ref: default-branch, license_expected: MIT }
  to-tickets: { repo: mattpocock/skills, path: skills/engineering/to-tickets, ref: default-branch, license_expected: MIT }
  triage: { repo: mattpocock/skills, path: skills/engineering/triage, ref: default-branch, license_expected: MIT }
  handoff: { repo: mattpocock/skills, path: skills/productivity/handoff, ref: default-branch, license_expected: MIT }
  skill-creator: { repo: anthropics/skills, path: skills/skill-creator, ref: default-branch, license_expected: Apache-2.0 }
  frontend-design: { repo: anthropics/skills, path: skills/frontend-design, ref: default-branch, license_expected: Apache-2.0 }
  web-artifacts-builder: { repo: anthropics/skills, path: skills/web-artifacts-builder, ref: default-branch, license_expected: Apache-2.0 }
  vercel-react-best-practices: { repo: vercel-labs/agent-skills, path: skills/react-best-practices, ref: default-branch, license_expected: MIT }
  web-design-guidelines: { repo: vercel-labs/agent-skills, path: skills/web-design-guidelines, ref: default-branch, license_expected: MIT }
  find-skills: { repo: vercel-labs/skills, path: skills/find-skills, ref: default-branch, license_expected: MIT }
  shadcn: { repo: shadcn-ui/ui, path: skills/shadcn, ref: default-branch, license_expected: MIT }
  huashu-design: { repo: alchaincyf/huashu-design, path: ., ref: default-branch, license_expected: MIT }
  hue: { repo: dominikmartn/hue, path: ., ref: default-branch, license_expected: MIT }
  hallmark: { repo: Nutlope/hallmark, path: skills/hallmark, ref: default-branch, license_expected: MIT }
  design-taste-frontend: { repo: Leonxlnx/taste-skill, path: skills/taste-skill, ref: default-branch, license_expected: MIT }
```

There are 45 entries across 12 repositories: the 51 existing rewrites minus the 6 deleted skills, with 2 renamed.

**Parser rules** (strict; every violation raises `invalid-skill-sources`):

| Field | Rule |
| --- | --- |
| Top level | `version: 1` and `skills:` only, each exactly once |
| id (map key) | Matches `^[a-z0-9][a-z0-9-]{0,63}$`. Unique. Must not equal a token in `templates/skill-sources.yaml`; this collision check runs in the verifier and the installer, not in the pure parser |
| `repo` | Matches `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$`. Must not end in `.git` |
| `path` | Either `.` or a POSIX relative path made of `[A-Za-z0-9._-]` segments. No empty, `.` or `..` segment, no leading `/`, no trailing `/` |
| `ref` | Exactly `default-branch` |
| `license_expected` | `MIT` or `Apache-2.0` |
| Other fields | Rejected |

### 3.2 `skills/skills.lock.json` (not in git; written into the plugin root; part of the payload)

```json
{
  "version": 1,
  "updated_at": "2026-09-15T08:00:00.000Z",
  "skills": [
    {
      "id": "hue",
      "repo": "dominikmartn/hue",
      "path": ".",
      "commit": "a910e31cd24b45b9455c0c3502150413aa5a3b32",
      "tree_sha256": "sha256:<64 lowercase hex>",
      "license": "MIT",
      "fetched_at": "2026-09-15T08:00:00.000Z",
      "previous_commit": null
    }
  ]
}
```

- **Serialization:** entries sorted by `id`, `JSON.stringify(value, null, 2) + '\n'`, keys in the order shown.
- **What is listed:** only skills whose content is currently present. A skill that failed and has no previous version is
  absent.
- **`tree_sha256`:** `sha256:` + `buildCanonicalManifest(id, dir).treeSha256`
  (`packages/automation/src/skills/snapshot-manifest.ts:253`). This is the same algorithm as the bundled registry, so
  there is still only one hash algorithm.
- **`commit`:** the default-branch HEAD at the time this content was fetched.
  - When a later run finds the same `tree_sha256`, the previous entry is kept byte-for-byte, including the old `commit`.
    This is what keeps rule 5 (idempotence) true.
- **`fetched_at` and `previous_commit`:** set only when content changes. `previous_commit` is the commit of the replaced
  content, or `null` on first install.
- **`updated_at`:** the time of the last run that changed at least one entry, or that added or removed one.
- **"Changed since last update":** `fetched_at === updated_at`.
- **Parser checks** (violations raise `invalid-skill-lock`):
  - `version === 1`; ISO-8601 UTC timestamps; `commit` matches `^[0-9a-f]{40}$`; `license` is in the allow-list.
  - `previous_commit` is `null` or 40 hex characters. No duplicate ids.
  - When `sources` is given, every entry's `id`, `repo` and `path` equal that source's values.

### 3.3 `<stateRoot>/skills/last-update.json` (Tenon machine state, outside the payload)

```json
{
  "version": 1,
  "at": "2026-09-15T08:00:00.000Z",
  "host": "codex",
  "results": [
    { "id": "hue", "outcome": "unchanged" },
    { "id": "huashu-design", "outcome": "kept", "reason": "unreachable", "detail": "git clone … timed out after 2 attempts" },
    { "id": "web-design-guidelines", "outcome": "missing", "reason": "license-missing" }
  ]
}
```

- `stateRoot` is `resolveRuntimePaths({ homeDir, env }).stateRoot`, which is the kernel `resolveProductPaths` result
  (`packages/cli/src/runtime/paths.ts:11-12`). The server reads the same root through `resolveServerPaths`
  (`packages/server/src/paths.ts:4-16`).
- The file is written atomically (tmp file plus rename) after every install run, whether or not activation later
  succeeds.
- `outcome` is one of:
  - `updated`: new content.
  - `unchanged`: the hash is the same.
  - `kept`: failed, and the previous content is in place.
  - `missing`: failed, and there is no previous content.
- `reason` is present only for `kept` and `missing`.

### 3.4 TypeScript signatures

`packages/kernel/src/skills/flow-yaml.ts` (new). These helpers are extracted from `source-registry.ts:86-136`, which
keeps working unchanged:

```ts
export function stripFlowComment(line: string): string
export function unquoteFlowValue(value: string): string
export function parseFlowBody(body: string, onError: (message: string) => Error): Map<string, string>
```

`packages/kernel/src/skills/upstream-sources.ts` (new; re-exported from `packages/kernel/src/skills/index.ts`):

```ts
export type UpstreamSkillLicense = 'MIT' | 'Apache-2.0'
export const UPSTREAM_SKILL_LICENSES: readonly UpstreamSkillLicense[]
export interface UpstreamSkillSource {
  readonly id: string; readonly repo: string; readonly path: string
  readonly ref: 'default-branch'; readonly licenseExpected: UpstreamSkillLicense
}
export interface UpstreamSkillSources { readonly version: 1; readonly skills: readonly UpstreamSkillSource[] }
export type UpstreamSkillErrorCategory = 'invalid-skill-sources' | 'invalid-skill-lock'
export class UpstreamSkillError extends Error { constructor(readonly category: UpstreamSkillErrorCategory, message: string) }
export function parseUpstreamSkillSources(text: string): UpstreamSkillSources

export interface UpstreamSkillLockEntry {
  readonly id: string; readonly repo: string; readonly path: string; readonly commit: string
  readonly treeSha256: `sha256:${string}`; readonly license: UpstreamSkillLicense
  readonly fetchedAt: string; readonly previousCommit: string | null
}
export interface UpstreamSkillLock { readonly version: 1; readonly updatedAt: string; readonly skills: readonly UpstreamSkillLockEntry[] }
export function parseUpstreamSkillLock(text: string, sources?: UpstreamSkillSources): UpstreamSkillLock
export function serializeUpstreamSkillLock(lock: UpstreamSkillLock): string

export type UpstreamSkillFailureReason =
  | 'unreachable' | 'removed' | 'renamed' | 'invalid-content' | 'too-large' | 'license-missing' | 'license-mismatch'
export interface UpstreamSkillRunResult {
  readonly id: string; readonly outcome: 'updated' | 'unchanged' | 'kept' | 'missing'
  readonly reason?: UpstreamSkillFailureReason; readonly detail?: string
}
export interface UpstreamSkillRunReport { readonly version: 1; readonly at: string; readonly host: 'codex' | 'claude' | 'dev'; readonly results: readonly UpstreamSkillRunResult[] }
export function parseUpstreamSkillRunReport(text: string): UpstreamSkillRunReport   // throws invalid-skill-lock
export function serializeUpstreamSkillRunReport(report: UpstreamSkillRunReport): string

export type UpstreamSkillRowStatus = 'changed' | 'unchanged' | 'failed' | 'bundled'
export interface UpstreamSkillViewRow {
  readonly id: string; readonly origin: 'tenon' | 'upstream'; readonly status: UpstreamSkillRowStatus
  readonly repo?: string; readonly path?: string; readonly commit?: string; readonly previousCommit?: string | null
  readonly license?: UpstreamSkillLicense; readonly fetchedAt?: string
  readonly reason?: UpstreamSkillFailureReason; readonly detail?: string
  readonly sourceUrl?: string   // https://github.com/<repo>/tree/<commit>/<path>
  readonly commitUrl?: string   // https://github.com/<repo>/commit/<commit>
  readonly compareUrl?: string  // https://github.com/<repo>/compare/<previous>...<commit>, only when previousCommit !== null
}
export interface UpstreamSkillView { readonly updatedAt: string | null; readonly lastRunAt: string | null; readonly rows: readonly UpstreamSkillViewRow[] }
export function buildUpstreamSkillView(input: {
  readonly bundledIds: readonly string[]; readonly sources: UpstreamSkillSources | null
  readonly lock: UpstreamSkillLock | null; readonly lastRun: UpstreamSkillRunReport | null
}): UpstreamSkillView
```

**How `buildUpstreamSkillView` works:**

1. Rows are the bundled ids (`origin: 'tenon'`, `status: 'bundled'`), then the source ids in `sources.yaml` order.
2. A source row's status is `failed` if either:
   - the id is not in the lock; or
   - `lastRun.at >= lock.updatedAt` and `lastRun` has `kept` or `missing` for that id.
   In both cases `reason` and `detail` come from `lastRun`.
3. Otherwise the status is `changed` if `fetchedAt === lock.updatedAt`, and `unchanged` if not.
4. Lock ids that are not in `sources` are ignored; the verifier reports them.

**Shared category list.** `packages/kernel/src/skills/source-registry.ts:49-59` appends `'invalid-skill-sources'` and
`'invalid-skill-lock'` to `SKILL_PROVENANCE_ERROR_CATEGORIES`. The automation verifier and the CLI JSON output share
this list.

`packages/cli/src/commands/remote-git.ts` (new). The retry logic is moved here from `stable-release.ts:93-114`, which then
imports it without changing behavior:

```ts
export const TRANSIENT_REMOTE_FAILURE: RegExp
export interface RemoteGitOptions { readonly timeoutMs?: number /* 60_000 */; readonly attempts?: number /* 3 */ }
export function runRemoteGit(env: Pick<SetupEnv, 'runCommand'>, args: readonly string[], options?: RemoteGitOptions):
  { readonly result: ReturnType<SetupEnv['runCommand']>; readonly attempts: number }
```

`packages/cli/src/upstream-skills/` (new directory, every file under 300 lines):

```ts
// fetch.ts
export interface UpstreamCheckout { readonly repo: string; readonly commit: string; readonly dir: string }
export function resolveDefaultBranchHead(env: Pick<SetupEnv, 'runCommand'>, repo: string):
  { readonly ok: true; readonly commit: string } | { readonly ok: false; readonly detail: string }
export function checkoutUpstreamPaths(env: Pick<SetupEnv, 'runCommand'>, repo: string, paths: readonly string[], workDir: string):
  { readonly ok: true; readonly checkout: UpstreamCheckout } | { readonly ok: false; readonly detail: string }
export function treeEntryModes(env: Pick<SetupEnv, 'runCommand'>, checkoutDir: string, path: string):
  readonly { readonly mode: string; readonly path: string }[]
// license.ts
export interface LicenseEvidence { readonly license: UpstreamSkillLicense; readonly source: 'skill-file' | 'frontmatter' | 'repo-file' | 'readme'; readonly file?: string }
export function detectUpstreamLicense(checkoutDir: string, skillPath: string):
  LicenseEvidence | { readonly license: 'unrecognized'; readonly file: string } | null
// install.ts
export interface UpstreamSkillLimits { readonly skillBytes: number /* 64 MiB */; readonly totalBytes: number /* 256 MiB */; readonly deadlineMs: number /* 20 min */ }
export interface UpstreamSkillInstallInput {
  readonly env: Pick<SetupEnv, 'runCommand'>
  readonly pluginRoot: string            // host plugin root, or a development checkout
  readonly previousRoot: string | null   // active managed release payload root when activeValid
  readonly host: 'codex' | 'claude' | 'dev'
  readonly workRoot: string              // clone scratch: <dataRoot>/.staging (RuntimePaths.stagingRoot)
  readonly now: () => string
  readonly log: (line: string) => void
  readonly limits?: Partial<UpstreamSkillLimits>
}
export interface UpstreamSkillInstallResult { readonly report: UpstreamSkillRunReport; readonly lockWritten: boolean }
export async function installUpstreamSkills(input: UpstreamSkillInstallInput): Promise<UpstreamSkillInstallResult>
// report.ts
export function renderUpstreamSkillReport(report: UpstreamSkillRunReport): readonly string[]
export async function writeUpstreamSkillRunReport(stateRoot: string, report: UpstreamSkillRunReport): Promise<void>
export function readUpstreamSkillRunReport(stateRoot: string): UpstreamSkillRunReport | null   // missing or invalid → null
```

## 4. Install algorithm (`installUpstreamSkills`)

1. **Read the inputs.**
   - `<pluginRoot>/skills/sources.yaml` is parsed strictly. If it is missing, the function returns an empty report and
     writes nothing; this keeps pre-switch commits and adapter hosts unaffected.
   - An invalid file throws `UpstreamSkillError('invalid-skill-sources')`.
   - `<pluginRoot>/templates/skill-sources.yaml` is parsed with `parseSkillProvenanceRegistry` to get the bundled ids.
     A source id that equals a bundled id throws `invalid-skill-sources`.
2. **Read the previous state.** If `previousRoot` is given, parse `<previousRoot>/skills/skills.lock.json`. If it is
   missing or invalid, treat it as having no previous state and log `[skills] 旧锁文件无效，全部重新获取`.
3. **Remove crash leftovers.** Delete any `<pluginRoot>/.tenon-skills-staging-*`, then create
   `<pluginRoot>/.tenon-skills-staging-<uuid>/`. This directory is not a payload entry and is gitignored.
4. **Process each repository in `sources.yaml` order.** Stop starting new repositories once `deadlineMs` has elapsed;
   remaining ones fail with `unreachable` and detail `deadline`.
   1. **Resolve HEAD.** `runRemoteGit(env, ['ls-remote', '--symref', url, 'HEAD'])` with the default 60 s and 3 attempts.
      On failure, every skill in the repository fails with `unreachable`.
   2. **Reuse without cloning** when all of these hold for a skill:
      - a previous lock entry exists with the same `repo`, `path` and `commit === HEAD`;
      - the directory `<previousRoot>/skills/<id>` hashes to that entry's `tree_sha256`;
      - the directory is not already byte-identical in `<pluginRoot>`.
      Then copy it into staging. The outcome is `unchanged`.
   3. **Clone once per repository for the remaining skills** into `<workRoot>/upstream-<uuid>/<n>`:
      1. `git clone --quiet --depth=1 --filter=blob:none --no-checkout --single-branch <url> <dir>`
         (`runRemoteGit`, 300 s, 2 attempts)
      2. `git -C <dir> sparse-checkout set --no-cone /<path>/ /LICENSE* /LICENCE* /COPYING* /README*`
         (use `/*` when `path` is `.`)
      3. `git -C <dir> checkout --quiet` (`runRemoteGit`, 300 s, 2 attempts; this step downloads the blobs)
      4. `git -C <dir> rev-parse HEAD` gives `commit`.
   4. **Validate each skill** (the first failing rule wins):
      1. The path is missing at HEAD → `removed`.
      2. `git ls-tree -r --full-tree HEAD -- <path>` (or the root) contains mode `120000` (symlink) or `160000`
         (submodule) → `invalid-content`.
      3. `<path>/SKILL.md` is missing, or its frontmatter `name` is missing → `invalid-content`.
      4. Frontmatter `name !== id` → `renamed`, with detail `upstream name <name>`.
      5. The sum of regular file bytes, excluding `.git/`, is larger than `skillBytes`, or the running total is larger
         than `totalBytes` → `too-large`.
      6. `detectUpstreamLicense` returns null → `license-missing`. A result that is `unrecognized` or does not equal
         `licenseExpected` → `license-mismatch`, with detail `expected MIT, found <x>`.
   5. **Stage.** Copy the skill into `<staging>/<id>/`:
      - Regular files and directories only. `.git/` is excluded, and for root skills `.github/` is excluded too.
      - File mode is `0o755` if any execute bit is set, otherwise `0o644`. Directories are `0o755`.
      - When the license came from `repo-file` and no license file exists inside the skill, copy that root file into
        `<staging>/<id>/` under its original basename.
   6. **Hash.** `tree_sha256 = sha256:${(await buildCanonicalManifest(id, <staging>/<id>)).treeSha256}`.
      - If the hash equals the previous entry's, the outcome is `unchanged` and the previous entry is carried over.
      - Otherwise the outcome is `updated` with a new entry: `fetchedAt = now()`,
        `previousCommit = previous?.commit ?? null`.
5. **Handle failures.** For each skill that failed:
   - If a previous entry exists and `<previousRoot>/skills/<id>` still verifies against it, stage that copy (or keep the
     identical `<pluginRoot>` copy). The outcome is `kept` and the previous entry is carried over.
   - Otherwise the outcome is `missing`, with no entry.
6. **Apply, one skill at a time.** For every staged id:
   1. Rename `<pluginRoot>/skills/<id>` to `<staging>/.old-<id>` if it exists.
   2. Rename `<staging>/<id>` to `<pluginRoot>/skills/<id>`.
   Then delete `<pluginRoot>/skills/<dir>` for every directory that is neither a bundled id nor in the new lock.
7. **Write the lock** as `{ version: 1, updatedAt, skills }`:
   - `updatedAt` is `now()` if any entry was added, removed or changed; otherwise it is the previous `updatedAt`.
   - Serialize it. If the bytes equal the existing `<pluginRoot>/skills/skills.lock.json`, leave the file alone
     (`lockWritten = false`). Otherwise write `skills.lock.json.tmp-<uuid>` and rename it into place.
   - If the lock has no entries and no previous lock exists, do not create the file.
8. **Clean up.** Remove `<staging>` and `<workRoot>/upstream-<uuid>`. Return the report; the caller writes
   `last-update.json` and prints the report lines.

**License detection** (`detectUpstreamLicense`), first match wins:

1. **`skill-file`:** `<path>/{LICENSE,LICENSE.md,LICENSE.txt,LICENCE,COPYING}`, classified by text.
2. **`frontmatter`:** `SKILL.md` frontmatter `license:` whose value is exactly `MIT` or `Apache-2.0`.
3. **`repo-file`:** the same filenames at the repository root.
4. **`readme`:** the root `README*`. Find the first heading matching `^#{1,3}\s*Licen[cs]e\s*$`; its first non-empty
   line must be exactly `MIT` or `Apache-2.0`.

Text classification rules:

- **MIT:** contains `Permission is hereby granted, free of charge`.
- **Apache-2.0:** contains `Apache License` and `Version 2.0`.
- **Anything else:** `unrecognized`.

**Crash semantics.** If the process dies during step 6, some directories are new while the lock is old. The verifier then
reports `content-hash-mismatch`, candidate verification fails, and the active release is untouched. The next setup or
update run repairs the root.

## 5. CLI surface

| Command | Change |
| --- | --- |
| `tenon setup --codex\|--claude [-y]` | Runs `installUpstreamSkills` inside `prepareCandidate` (§6.1). Prints `[skills] …` progress and report lines. Exits 0 when activation succeeds, even if some skills failed (failures are printed and shown by doctor). Exits 1 on `invalid-skill-sources` (no activation) |
| `tenon update --codex\|--claude` | Same, in both `prepareCandidate` branches (§6.2). Reports `current` only when the lock did not change and the host and runtime are otherwise exact |
| `tenon setup skills` | **Removed**, together with the planner. `setup.ts:145-146` loses the `skills` case; the error text lists `runtime` only |
| `tenon doctor [--json] [--skills]` | New tail check `skills:upstream`. `--skills` prints the table from §7.2 after the checks. `--json --skills` adds `skills: UpstreamSkillView` next to `checks` and `summary` |
| `tenon internal-skill-upstream fetch --root <path> [--json]` | **New, hidden.** Installs upstream skills into a development checkout with `host: 'dev'` and `previousRoot: <root>`, and writes `last-update.json`. Exit codes: 0 when nothing is `missing`, 1 when anything is `missing`, 2 for bad invocation or `invalid-skill-sources` |
| `npm run skills:fetch` | **New:** `npm run build:skill-provenance && node packages/cli/dist/tenon.mjs internal-skill-upstream fetch --root "$PWD"` |

Report line format (CLI output only):

```text
[skills] 获取 obra/superpowers …
[skills] 更新 brainstorming a910e31
[skills] 失败 web-design-guidelines license-missing（未安装）
[skills] 失败 huashu-design unreachable（保留 1c2d3e4）
[skills] 45 个上游技能：更新 3，无变化 40，保留 1，缺失 1
```

## 6. Host flow changes

### 6.1 Setup (`packages/cli/src/commands/setupHost.ts:171-186`)

```ts
const candidate = await installNativePluginCandidate(deps, lifecycleEnv, host, transaction)
if (candidate === null) throw new Error('宿主插件未能解析为可发布候选')
await runUpstreamSkillInstall(deps, lifecycleEnv, installer, runtimeScope, host, candidate.root)   // new
const assetCode = verifyPackagedAssets(deps, lifecycleEnv, candidate.root, false)                    // always re-verify
```

`runUpstreamSkillInstall` lives in the new file `packages/cli/src/commands/upstream-skill-step.ts`. It:

1. Gets `previousRoot` from `installer.inspect(scope)`: `join(releasesRoot, active.releaseId, 'payload')` when
   `activeValid`. `update-native.ts:195` already calls `installer.inspect` inside the transaction, so this is an
   established pattern.
2. Calls `installUpstreamSkills` with `workRoot = resolveRuntimePaths(...).stagingRoot`.
3. Writes `last-update.json` and prints the report lines.
4. Rethrows `UpstreamSkillError`. The coordinator then reports `unchanged` and the active runtime stays as it was.

The `candidate.verified` shortcut (`native-plugin-candidate.ts:109-112`) is no longer used for asset verification,
because the root may have changed after it was verified.

### 6.2 Update (`packages/cli/src/commands/update-native.ts`)

- **Host-exact branch.** Call `runUpstreamSkillInstall(…, beforeInventory.tenonRoot)` right after `hostExact` is computed
  (`:213-215`), before `verifyUpdatedRoot`.
  - If the lock did not change, `candidateIdentity.payloadDigest === active.payloadDigest` still holds and the existing
    `current` path returns `无需更新`.
  - If the lock changed, the digests differ. `runtimeExact` is false, the branch returns
    `{ candidateRoot, evidence }` (`:250`), and activation publishes a new release under the same stable target.
- **Mutation branch.** Call it after `observeNativeStableTarget` (`:305-307`) and before `verifyUpdatedRoot` (`:309`).
- **Daily refresh.** The opt-in auto-update (`hooks/auto-update.sh`, every 24 h) runs `tenon update --<host>` and
  therefore refreshes skills daily. No change is needed there.

### 6.3 Stable proof: payload comparison (`managed-host-observation.ts:93-110`, `install.sh:1026-1037`)

```ts
function payloadComparisonEntries(env: SetupEnv, marketplaceRoot: string): readonly string[] | null {
  const listed = env.runCommand('git', ['-C', marketplaceRoot, 'ls-tree', '--name-only', 'HEAD', 'skills/'])
  if (listed.code !== 0) return null
  const tracked = listed.stdout.split(/\r?\n/).filter((line) => line !== '')   // skills/tenon, skills/sources.yaml, …
  return [...PAYLOAD_ENTRIES.filter((entry) => entry !== 'skills'), ...tracked]
}
```

- `pluginPayloadMatchesMarketplace` compares these entries and returns `false` when the list is `null`.
- Extra `skills/*` children in the plugin root are not proven here. `verify-skills.sh` proves them: every child must be
  a bundled token or a lock entry with a matching hash. That script runs in every `verifyAssets` callback of
  `revalidateNativeStableCandidate` (`native-candidate-revalidation.ts:69`).
- `install.sh` replaces the literal `"skills"` in its loop with
  `$(run_git -C "$MARKETPLACE_ROOT" ls-tree --name-only HEAD skills/)`.
- For the case where the marketplace root is the plugin root, `.gitignore` gains the rules below, so fetched content
  stays out of `ls-files --others --exclude-standard`:

```gitignore
# Upstream skills are fetched into the plugin root by tenon setup/update (skills/sources.yaml); not tracked.
/skills/*
!/skills/tenon/
!/skills/sources.yaml
# Tenon-owned skills removed by 09-15-data-driven-runner; delete these lines with them.
!/skills/tenon-open/
!/skills/tenon-explore/
!/skills/tenon-spec/
!/skills/tenon-build/
!/skills/tenon-verify/
!/skills/tenon-ship/
!/skills/tenon-archive/
!/skills/simple-task/
!/skills/learn-record/
!/skills/tenon-researcher/
/.tenon-skills-staging-*/
```

### 6.4 Verifier, locator and sync

- **`verifySkillProvenance`** (`skill-provenance.ts:111-233`):
  1. If `<root>/skills/sources.yaml` exists, parse it; a parse error is an `invalid-skill-sources` finding.
  2. If `<root>/skills/skills.lock.json` exists, parse it against the sources; errors are `invalid-skill-lock`. A lock
     without `sources.yaml` is also `invalid-skill-lock`.
  3. A source id that collides with a registry token is `invalid-skill-sources`.
  4. The declared set becomes registry ids ∪ lock ids:
     - a lock entry without its directory → `missing-distributed-skill`;
     - a directory in neither the registry nor the lock → `unregistered-distributed-skill`;
     - a directory whose hash differs from its lock entry → `content-hash-mismatch`.
  5. A source checkout with no lock requires no upstream directory, which is how CI checks the repository root.
- **`createProvenanceAwareBundledLocator`** (`packages/cli/src/skill-provenance-locator.ts:147-238`): an id that is not a
  registry token but is in the lock is located at `skills/<id>`, and its lock `tree_sha256` is checked with the same
  hash call. A lock read or parse error raises `SkillProvenanceLocatorError('invalid-skill-lock')`.
- **`syncRegistry`** (`internal-skill-provenance.ts:250-281`): excludes lock ids, and ids listed in `sources.yaml`, from
  the physical set. This lets a development checkout that ran `skills:fetch` sync the Tenon-owned registry.
- **`tools/verify-skills.sh`:**
  - Section 4 (`:283-308`) and its header lines 8-9 are deleted, together with `skills/EXTERNAL-SKILLS.md`.
  - Section 5 is unchanged; it delegates to the extended verifier.
  - The OK line keeps its format.

## 7. Doctor

### 7.1 Check `skills:upstream`

This check is appended after `integration:codex-project-skills` in `packages/cli/src/commands/doctor.ts:328-339`.
Its logic lives in the new file `packages/cli/src/commands/doctor-upstream-skills.ts`.

| Condition | Status | Detail (CLI) | Hint |
| --- | --- | --- | --- |
| `sources.yaml` missing (source checkout before the switch) | green | `无上游技能来源清单` | — |
| `sources.yaml` or lock invalid | red | `上游技能清单无效：<message>` | `运行 tenon update --<host> 重新获取；bash <root>/tools/verify-skills.sh 查看 category` |
| ≥1 source id not in lock | red | `缺 <n> 个上游技能：<id>(<reason>)、…` | `运行 tenon update --<host>；缺许可证或许可证不符的技能不会安装` |
| Last run `kept` ≥1 | yellow | `<n> 个上游技能获取失败，保留旧版本：<id>(<reason>)、…` | `网络恢复后运行 tenon update --<host>` |
| Otherwise | green | `<n> 个上游技能已安装，自上次更新变化 <m> 个` | — |

**Probes.** `DoctorProbes` in `packages/cli/src/deps.ts:67-130` gains
`upstreamSkillView?: () => UpstreamSkillView | { error: string }`. The production implementation reads
`p.pluginRoot/skills/{sources.yaml,skills.lock.json}`, `templates/skill-sources.yaml` and
`readUpstreamSkillRunReport(stateRoot)`.

**`checkSkills` merge.** `checkSkills` (`doctor-skills.ts:78-129`) treats lock ids as `tool: bundled` when it builds
`byToken`, so `skills:mandatory` does not report upstream skills as missing.

### 7.2 `tenon doctor --skills` table

```text
技能                          来源                                   提交      许可证      更新                 状态
brainstorming                 obra/superpowers:skills/brainstorming  a910e31   MIT         2026-09-15 08:00     变化
huashu-design                 alchaincyf/huashu-design:.             1c2d3e4   MIT         2026-09-01 10:12     失败 unreachable
```

- It is built from `buildUpstreamSkillView`.
- Rows are plain padded columns with no wrapping; long values are truncated with `…`.
- `program.ts:196-200` gains `.option('--skills', …)`.

## 8. Server

- **Route:** `GET /api/skills/sources`, added to `handleGet` next to `/api/skills/registry`
  (`packages/server/src/serverGetRoutes.ts:253`).
  - **200:** `UpstreamSkillView` (§3.4).
  - **500:** `{ ok: false, error }` when `sources.yaml` or the lock is present but invalid. The error text is the parser
    message.
- **Implementation:** the new file `packages/server/src/skillSourcesView.ts` exports
  `readSkillSourcesView(repoRoot: string, stateRoot: string): UpstreamSkillView`. It reads the same files as the doctor
  probe and uses `repoRootForSkills()` and `paths.stateRoot`.
- **`skillsRegistry.ts` cleanup:**
  - Delete `BUILTIN_SKILLS` (`:14`) and `externalSkillSections` (`:212-229`). The `source` decision becomes
    `locals.has(name) ? 'local-plugin' : 'user'`. The union type stays, so the Dashboard decoder does not change.
  - Upstream skills are physical directories under the payload's `skills/`, so `localSkillDirs` already lists them as
    `local-plugin` and installed.

## 9. Dashboard

| File | Change |
| --- | --- |
| `src/shell/views.ts` | `VIEWS = ['progress', 'workbench', 'skills'] as const`; update the comment |
| `src/shell/TopBar.tsx` | No code change (it maps `VIEWS`) |
| `src/App.tsx` | `const SkillsView = lazy(...)`; render `{view === 'skills' && <SkillsView />}` next to `:327-344` |
| `src/api/skillSourcesClient.ts` (new) | `fetchSkillSources(): Promise<UpstreamSkillViewDto>` plus a strict decoder `decodeSkillSources(value: unknown): UpstreamSkillViewDto \| null`. Uses the same token and fetch helper as `governanceClient.ts:209-218` |
| `src/skills/SkillsView.tsx` (new) | The page (below) |
| `src/i18n/translations.ts` | Adds `nav.skills` and a `skills.*` block in zh and en |

**`SkillsView` layout:**

- **Toolbar:** a segmented filter `全部 n` / `变化 n` / `失败 n` and the text `更新 <updatedAt>`.
- **Table:** one table with sticky header columns 技能 · 来源 · 提交 · 许可证 · 更新 · 状态.
  - Every cell is `whitespace-nowrap truncate`; `title` carries the full value.
  - **来源:** `owner/repo` linking to `sourceUrl`. For Tenon rows it shows `tenon`.
  - **提交:** short sha linking to `commitUrl`. For `changed` rows with `previousCommit` it shows `prev7→curr7` linking to
    `compareUrl`. Tenon rows show `—`.
  - **状态:** exactly one word. `变化` (amber), `无变化` (neutral), `失败` (red; its `title` is the localized reason plus
    detail, which counts as error text), and `—` for Tenon rows.
- **Load failure:** one red error line with the server message.
- **Empty `rows`:** the table only.
- There are no explanatory sentences.

**zh keys:**

- `nav.skills`: 技能
- `skills.filter_all`: 全部
- `skills.filter_changed`: 变化
- `skills.filter_failed`: 失败
- `skills.updated`: 更新
- `skills.col_skill`: 技能
- `skills.col_source`: 来源
- `skills.col_commit`: 提交
- `skills.col_license`: 许可证
- `skills.col_updated`: 更新
- `skills.col_status`: 状态
- `skills.status_changed`: 变化
- `skills.status_unchanged`: 无变化
- `skills.status_failed`: 失败
- `skills.reason_unreachable`: 无法访问
- `skills.reason_removed`: 上游已删除
- `skills.reason_renamed`: 上游已改名
- `skills.reason_invalid-content`: 内容无效
- `skills.reason_too-large`: 超过大小限制
- `skills.reason_license-missing`: 缺少许可证
- `skills.reason_license-mismatch`: 许可证不符
- `skills.load_error`: 技能来源读取失败

**en keys:** mirror the zh keys. `translations.ts` has a completeness test that enforces this.

## 10. Removals, renames and reference cleanup

- **Delete these 51 directories under `skills/`:**
  - openspec-propose, openspec-explore, openspec-apply-change, openspec-archive-change
  - brainstorming, writing-plans, test-driven-development, subagent-driven-development, dispatching-parallel-agents,
    verification-before-completion, finishing-a-development-branch
  - grill-with-docs, improve-codebase-architecture, prototype, handoff, to-spec, to-tickets, triage
  - frontend-design, web-design-guidelines, design-taste-frontend
  - browser-qa, e2e-testing, search-first, hallmark, react-patterns, deep-research, market-research
  - zoom-out, find-skills, huashu-design, hue, shadcn-ui, tailwind-css-patterns, web-artifacts-builder, uiuxdesign-pro,
    react-best-practices
  - frontend-patterns, nestjs-patterns, postgres-patterns, python-patterns, python-testing, docker-patterns,
    deployment-patterns
  - verify, run, security-review, code-review, code-tour, github-ops, skill-creator
- **Also delete** `skills/EXTERNAL-SKILLS.md`, `packages/cli/src/commands/setupSkillsPlan.ts`, the planner part of
  `packages/cli/src/commands/setupSkills.ts` (delete the file if nothing else is exported from it), and the planner tests
  in `setup.test.ts:~2990-3140`.
- **Regenerate** `templates/skill-sources.yaml` with `npm run sync:skill-provenance`. It keeps the 11 Tenon-owned entries
  until data-driven-runner removes 10 of them.
- **No upstream source:** `zoom-out`, `verify`, `run`, `uiuxdesign-pro`, `tailwind-css-patterns` and `code-review` get no
  `sources.yaml` entry. Remove their references:
  - `templates/manifest.yaml:64`: `standards: [security-review, web-design-guidelines, design-taste-frontend]`
  - `skills/tenon-explore/SKILL.md:146,170,299`: delete the `zoom-out` lines
  - `skills/tenon-build/SKILL.md:185,193,221`: delete the `tailwind-css-patterns` and `uiuxdesign-pro` lines
  - `skills/tenon-build/SKILL.md:404`: becomes `- bundled-skill: shadcn / web-artifacts-builder · 条件或可选`
  - `packages/server/src/skillsRegistry.ts:14`
- **Renames:**
  - `react-best-practices` → `vercel-react-best-practices` (`skills/tenon-build/SKILL.md:220,405`)
  - `shadcn-ui` → `shadcn` (`skills/tenon-build/SKILL.md:184,222,404`)
  - `templates/workflows/default.yaml` and `packages/kernel/src/workflow/default-workflow.generated.ts` reference neither
    old name, so there is nothing to regenerate.
- **Tenon-customized OpenSpec skills:** the local `openspec-propose` and `openspec-apply-change` carry Tenon procedure
  (`tenon init`, `document scaffold/record`, the applied-spec receipt). They are replaced by upstream content.
  data-driven-runner (R4) moves that procedure into `skills/tenon`, reading the deleted text from git history
  (`git show 2290233c:skills/openspec-propose/SKILL.md`, `git show 2290233c:skills/openspec-apply-change/SKILL.md`).
- **Tests and fixtures that use deleted names:**
  - `tools/test-hooks.sh:1823,1832` read `$ROOT/skills/openspec-propose/SKILL.md`. That file will not exist in a CI
    source checkout, and `hooks/skill-evidence.sh:237` requires it to be readable. Switch both reads to
    `skills/tenon/SKILL.md` and id `tenon`.
  - `packages/cli/src/skillSources.test.ts:131-189` makes real-registry assertions about third-party ids; move them to
    the `sources.yaml` test.
  - `packages/automation/src/skills/skill-provenance.test.ts:115-136` expects 62 skills; the new expectation is registry
    count equals tracked directory count, and there is no tracked lock.
  - `packages/server/src/skillsRegistry.test.ts:16-26` covers `EXTERNAL-SKILLS`; delete those cases.
  - Fixture strings inside the alias and runner tests (`skillBundleAssembly.test.ts:287-321`,
    `skillsRegistry.test.ts:245-276`) describe generic external registries, not product references. They stay.
- **Docs:** update the policy text in `README.md:290-305`, `CONTRIBUTING.md:140-158`, `docs/CONTRACT.md:445-470` (§7 and
  §8) and `docs/DIST-RELEASE.md:30-55` to describe `sources.yaml`, the lock, the fetch step, `npm run skills:fetch` and
  the license rule. Historical research documents under `docs/research/` stay.

## 11. Compatibility and migration

- **A machine on 1.1.5, with 62 bundled skills in its active payload and no lock, runs `tenon update`:**
  1. The host reinstalls the new version. The new cache holds only the Tenon-owned directories plus `sources.yaml`.
  2. `previousRoot` has no lock, so every skill is fetched.
  3. Skills that fail become `missing`. Tenon does not fall back to the old rewrites.
  4. Activation publishes the new release. Rollback to 1.1.5 still works, because stored releases are verified with their
     own `tools/verify-skills.sh` and CLI (`release-store.ts:394-410`).
- **The host replaces the cache by itself** (for example, Claude marketplace auto-update without Tenon):
  - The cache then has no upstream directories or lock, and its digest differs from the active runtime.
  - The existing doctor identity check reports the digest mismatch, and `skills:upstream` stays green or red based on the
    active payload.
  - Hosts load only the Tenon-owned skills until `tenon update --<host>` runs.
- **Development root** (`codexSkillTrust.ts:192-220`): run `npm run skills:fetch` once. Otherwise
  `skills:workflow-phase` goes red with a hint.
- **Adapter (non-native) hosts:** `sources.yaml` is present, but there is no fetch in setup. Their plugin root is a
  checkout, so users run `npm run skills:fetch` (hint in doctor). This is not part of this child's acceptance.
- **Loading scope:** upstream skills load everywhere the Tenon plugin is enabled, exactly as the bundled rewrites do
  today. Upstream descriptions are more assertive (for example superpowers' "You MUST use this before any creative
  work"). Tenon writes nothing into `~/.claude/skills`, `~/.agents/skills` or project skill directories. Invocation is
  still governed by the existing skill gate.
- **Parent-contract statement:** the parent says "Repository keeps only `skills/tenon/`". During waves 1–3 the 10 other
  Tenon-owned directories remain tracked (see `.gitignore` in §6.3). data-driven-runner deletes them and their allow
  lines.

## 12. Validation and error matrix

| Condition | Where detected | Result |
| --- | --- | --- |
| `sources.yaml` malformed, unknown field, bad repo or path, id collides with bundled token | installer, verifier | Setup/update exits 1. `managed runtime 校验/发布失败，当前已验证 runtime 保持不变` (`release-coordinator.ts:262-268`). `verify-skills` `[invalid-skill-sources]` |
| `ls-remote` fails after 3 transient attempts | installer | That repository's skills are `kept` or `missing`, reason `unreachable` |
| Clone or checkout exceeds 300 s twice | installer | `unreachable`, detail `timed out after 2 attempts` |
| Total deadline of 20 min reached | installer | Remaining repositories `unreachable`, detail `deadline` |
| Path missing at HEAD | installer | `removed` |
| `SKILL.md` or its name missing; symlink or submodule in tree | installer | `invalid-content` |
| Frontmatter name ≠ id | installer | `renamed`, detail `upstream name <name>` |
| Skill > 64 MiB or total > 256 MiB | installer | `too-large` |
| No license evidence | installer | `license-missing`, never installed |
| License ≠ `license_expected` or unrecognized text | installer | `license-mismatch`, never installed |
| Previous lock invalid | installer | Logged; full fetch |
| Crash between per-skill renames | verifier during candidate verification | `content-hash-mismatch`; activation refused; the rerun repairs |
| Lock entry without directory | verifier | `missing-distributed-skill` |
| Directory in neither registry nor lock | verifier | `unregistered-distributed-skill` |
| Directory bytes ≠ lock hash | verifier, locator | `content-hash-mismatch` |
| Lock without `sources.yaml`, or entry repo/path ≠ source | verifier | `invalid-skill-lock` |
| Tracked `skills/*` differs from marketplace tag | `pluginPayloadMatchesMarketplace`, `install.sh` | Proof fails, as today |
| Nothing changed upstream | update | Lock bytes unchanged → `current`, `无需更新` |
| `GET /api/skills/sources` with invalid lock | server | 500 `{ ok: false, error }`; the Dashboard shows the error line |
| `last-update.json` missing or invalid | doctor, server | Treated as no last run |

## 13. Security and supply chain

- **Accepted risk.** Upstream content is not pinned; the user decided "更新不需确认、只取清单内仓库、记录提交与哈希". Every
  run records `commit` and `tree_sha256`, and the lock's `previous_commit` plus `compareUrl` make each change auditable.
- **Source list integrity.** `skills/sources.yaml` is tracked. The stable proof compares it byte-for-byte against the
  release tag checkout (§6.3), so a local edit fails the proof. URLs are only ever `https://github.com/<validated>.git`;
  there is no URL field. Users' own git `insteadOf` config applies, just as it already does for the stable proof's git
  calls.
- **No execution of upstream code at install.** The installer runs `git clone`, `sparse-checkout`, `checkout`,
  `rev-parse` and `ls-tree` only. No hooks run, since clone never executes repository hooks. No package scripts run.
- **Content safety.**
  - Symlinks and submodules are rejected before copying.
  - Only regular files are copied. Modes are normalized to `0644`/`0755`, so setuid/setgid bits are dropped.
  - Size caps apply per skill and in total.
  - The canonical manifest hashing re-validates file types (`snapshot-manifest.ts:253`).
  - Paths come from git trees and are checked to stay inside the staging directory.
- **Licenses.** The allow-list is `MIT` and `Apache-2.0`. When the license came from a repository-root file, that file is
  copied into the skill for attribution. Anthropic skills keep their own `LICENSE.txt`.
- **Integrity after install.** The payload digest covers all upstream bytes. The bootstrap revalidates it on every
  dispatch (`tenon-bootstrap.mjs:251`), and the locator checks the per-skill hash before AFK bundling.
- **No telemetry and no token.** `npx skills` is not used; git transport needs no API rate limit or `GITHUB_TOKEN`.
- **Performance risk (reported to parent).** huashu-design adds about 33 MB of payload, most of it mp3. The bootstrap
  re-hashes the whole payload on every hook dispatch, so hashing grows from about 7 MB to about 45 MB per dispatch.
  §implement adds a measured check. See contract change request 5.

## 14. Tests required

No test touches the live network. Git tests use local bare repositories created in tmp directories and reached through
`GIT_CONFIG_COUNT/KEY/VALUE` `url.file://<fixture>/.insteadOf=https://github.com/` in the injected `runCommand` env.

| Test file | Assertions |
| --- | --- |
| `packages/kernel/src/skills/upstream-sources.test.ts` (new) | (1) The real `skills/sources.yaml` parses to 45 entries: it includes `vercel-react-best-practices`, `shadcn`, `design-taste-frontend` → `skills/taste-skill`, `huashu-design` path `.`; it excludes `zoom-out`, `verify`, `run`, `uiuxdesign-pro`, `tailwind-css-patterns`, `code-review`, `react-best-practices`, `shadcn-ui`. (2) Each invalid mutation (unknown field, `ref: main`, `path: ../x`, `repo: a/b/c`, duplicate id, `license_expected: GPL-3.0`) throws category `invalid-skill-sources`. (3) The lock round-trips: `serializeUpstreamSkillLock(parse(x)) === x` for a sorted fixture, and unsorted input serializes sorted. (4) A lock entry whose repo differs from its source throws `invalid-skill-lock`. (5) `buildUpstreamSkillView`: a missing lock entry gives `failed` with the reason from the last run; `fetchedAt === updatedAt` gives `changed` with `compareUrl` only when `previousCommit` is set; a last run older than the lock does not mark rows failed; bundled rows come first with `status: 'bundled'` |
| `packages/cli/src/commands/remote-git.test.ts` (new; the existing `stable-release.test.ts` must still pass unchanged) | A transient failure then success returns `attempts: 2`; `attempts: 2` stops after 2; a non-transient error does not retry |
| `packages/cli/src/upstream-skills/license.test.ts` (new) | skill `LICENSE.txt` Apache text → `Apache-2.0/skill-file`; frontmatter `license: MIT` → `frontmatter`; root `LICENSE.md` MIT → `repo-file`; README `## License\n\nMIT` → `readme`; frontmatter `Complete terms in LICENSE.txt` without a file → null; a GPL root file → `unrecognized` |
| `packages/cli/src/upstream-skills/install.test.ts` (new; local bare fixtures for 2 repos) | (1) First install writes `skills/<id>` byte-equal to the fixture path, plus a lock with 40-hex commit, `tree_sha256 === buildCanonicalManifest`, `previous_commit: null`, `fetched_at === updated_at`, and the root LICENSE copied. (2) A second run with no upstream change leaves the lock bytes and mtime unchanged, `lockWritten=false`, all `unchanged`, and when the commit equals HEAD makes no clone call (the spy `runCommand` sees no `clone`). (3) A new commit touching the skill gives `updated`, a new commit, `previous_commit` = old, new `updated_at`, and other skills keep their entries byte-equal. (4) A new commit touching only another path gives `unchanged` with the old commit kept. (5) One repository unreachable (bad insteadOf) gives that skill `kept` with the previous directory byte-identical and the other repository updated; with no previous it gives `missing`, no directory, no lock entry. (6) License missing gives `missing` with reason `license-missing` and no directory. (7) Frontmatter name mismatch gives `renamed`. (8) A symlink in the upstream tree gives `invalid-content`. (9) A `skillBytes` limit of 10 bytes gives `too-large`. (10) A stale directory not in sources or registry is removed. (11) A leftover `.tenon-skills-staging-old` is removed. (12) A source id equal to a bundled token throws `invalid-skill-sources` and leaves `pluginRoot` byte-identical. (13) A missing `sources.yaml` gives an empty report and no writes |
| `packages/automation/src/skills/skill-provenance.test.ts` (update) | The real repository is `ok`, registry count equals tracked directory count, and there is no tracked `skills/skills.lock.json`. New fixtures: a lock plus directory with a correct hash is `ok`; a tampered upstream file gives `content-hash-mismatch` for that id; a lock entry without a directory gives `missing-distributed-skill`; an extra directory gives `unregistered-distributed-skill`; a lock without sources gives `invalid-skill-lock`; a collision gives `invalid-skill-sources`. A repository test checks that no tracked `skills/*/SKILL.md` contains `description: First-party` for an id outside the registry and that no tracked directory id is in `sources.yaml` |
| `packages/cli/src/skill-provenance-locator.test.ts` (update) | A lock id is located with the correct hash; a tampered one gives `content-hash-mismatch`; an invalid lock gives `invalid-skill-lock` without falling back to lower tiers |
| `packages/cli/src/commands/internal-skill-provenance.test.ts` (update) | `sync` on a root with a lock plus upstream directories succeeds and writes only bundled entries |
| `packages/cli/src/commands/update.test.ts` (update) | (1) `pluginPayloadMatchesMarketplace` is true when the plugin root has extra `skills/<upstream>` plus the lock and the tracked children are equal; false when `skills/tenon/SKILL.md` differs; false when `ls-tree` fails. (2) Host-exact update with an unchanged lock reports `current` and makes no activation call. (3) Host-exact update where the install changes the lock activates a new release whose `payloadDigest` is not the old one and whose stable target is unchanged. (4) An install that throws `invalid-skill-sources` gives outcome `unchanged`, exit 1, the active selection untouched |
| `packages/cli/src/commands/setup.test.ts` (update) | The upstream install runs after `installNativePluginCandidate` and before `verifyPackagedAssets`, by call order; `verifyPackagedAssets` runs even when `candidate.verified`; `tenon setup skills` gives `未知 setup 子命令`; the planner tests are deleted |
| `packages/cli/src/commands/doctor.test.ts` (update) | `skills:upstream` statuses for each matrix row in §7.1, appended after `integration:codex-project-skills`; `--json --skills` contains `skills.rows`; `skills:mandatory` is green when mandatory ids exist only in the lock |
| `packages/cli/src/commands/internal-skill-upstream.test.ts` (new) | Exit 0, 1 and 2 semantics; `--json` prints the report |
| `packages/server/src/skillSourcesView.test.ts` (new) plus a route test in `server.test.ts` | 200 body matches `buildUpstreamSkillView`; invalid lock gives 500 with `ok:false`; source checkout (no lock) gives every source row `failed` with no reason |
| `packages/server/src/skillsRegistry.test.ts` (update) | The `EXTERNAL-SKILLS` and `builtin` cases are deleted; an upstream directory under the payload is `local-plugin` and installed |
| `packages/dashboard-app/src/api/skillSourcesClient.test.ts` (new) | The decoder rejects a bad status, missing rows or a non-string commit, and accepts the server fixture |
| `packages/dashboard-app/src/skills/SkillsView.test.tsx` (new) | Renders 6 headers; filter `失败` shows only failed rows; a changed row with a previous commit links to `compareUrl`; the status cell text is exactly one word; the failed row `title` contains the localized reason; no cell has a wrapping class (`whitespace-nowrap` present); load error shows `skills.load_error` |
| Dashboard nav test (existing `TopBar` or `views` test) | `nav-skills` exists and `?view=skills` deep-links |
| `tools/test-hooks.sh` (update) | Codex skill-read evidence uses `skills/tenon/SKILL.md`; the sandbox external-skill assertions are removed; the real-root `verify-skills` still passes |
| `tools/clean-codex-install-acceptance.mjs` plus `.node-test.mjs` (update) | Local mode builds a bare upstream fixture for one source entry and sets `url.file://…insteadOf` in the isolated `HOME` gitconfig. After install: the host root has `skills/<fixture-id>/SKILL.md` and `skills/skills.lock.json`, and Codex discovers `tenon:<fixture-id>`. The fixture release copies only `git ls-files skills` |

## 15. Decisions made during design

1. **Transport: git partial clone plus sparse checkout.** Not the GitHub REST API or tarballs (rate limits, whole-repo
   downloads) and not `npx skills` (a user decision). The shadcn probe took 7.9 s for 16 files. This reuses the retry
   pattern from the stable proof and the `runCommand` injection.
2. **Tenon writes into the host plugin root before candidate verification.** Hosts load skills only from there, and the
   existing `copyReleasePayload` then carries the same bytes into the managed payload. Candidate drift checks
   (`release-store.ts:245-256`) and the host-versus-active digest equality stay intact.
3. **The lock is `skills/skills.lock.json`, inside the `skills` payload entry.** Its bytes change only when content
   changes, so updates stay idempotent. `updated_at` and `previous_commit` give "changed since last update" without
   reading older releases.
4. **Failures are recorded in `<stateRoot>/skills/last-update.json`, not in the lock.** A transient failure therefore
   never produces a new release.
5. **The previous version comes from the active managed release payload** (digest-verified), not from host caches, which
   hosts delete on reinstall.
6. **Exit codes.** A failed skill does not fail setup or update after a valid activation: the release is consistent, the
   failure is printed, and doctor shows it red or yellow. An invalid `sources.yaml` does fail.
7. **Content is complete** (including huashu-design's mp3 assets). There are no per-source excludes. Caps are
   64 MiB per skill and 256 MiB total.
8. **License order:** skill file → frontmatter SPDX → repository-root file → root README license section. This is needed
   because `vercel-labs/agent-skills` has no license file (web-design-guidelines states MIT only in its README). The
   allow-list is MIT and Apache-2.0.
9. **Renamed ids use the upstream frontmatter name as the local id and directory name:** `vercel-react-best-practices`,
   `shadcn`. `design-taste-frontend` keeps its id because upstream's frontmatter name matches. A later upstream rename is
   reported as `renamed` and the previous content is kept.
10. **`tenon setup skills`, `setupSkillsPlan.ts`, `skills/EXTERNAL-SKILLS.md` and `verify-skills.sh` §4 are deleted,**
    along with the server's `BUILTIN_SKILLS` and EXTERNAL parsing. There is no compatibility layer.
11. **`templates/skill-sources.yaml` stays** with an unchanged v3 schema, for Tenon-owned bundled skills only. Upstream
    provenance lives in `sources.yaml` plus the lock. The verifier treats their union as the declared set.
12. **Dashboard:** a top-level view `skills` (nav 技能) and one new route, `GET /api/skills/sources`. It is not a tab of the
    Library page, so this wave-1 child does not depend on instruction-templates.
13. **Doctor:** one add-only check `skills:upstream`, plus a `--skills` table for per-skill source, commit, license and
    update time (PRD R7).
14. **Test seam:** git `url.<fixture>.insteadOf` in isolated config only. No production environment variable can
    redirect sources.
15. **The tree hash is Tenon's `tree-sha256-v1`,** not git tree ids, so there is one hash algorithm across the registry,
    the lock, the locator and snapshots.
16. **Development checkouts use the hidden `internal-skill-upstream fetch` via `npm run skills:fetch`.** Upstream
    directories are gitignored.
17. **GSAP skills are not added here.** design-resources appends 8 `greensock/gsap-skills` rows to `skills/sources.yaml`
    (MIT, `skills/gsap-*`).
18. **Tenon-customized OpenSpec skills are replaced by upstream now.** data-driven-runner restores the Tenon procedure in
    `skills/tenon` from git history.

## 16. Contract change requests (parent `design.md` §3 "Upstream skills", §7)

1. **Formats.**
   - `skills/sources.yaml` is flow YAML with `version: 1`, keyed by id: `{ repo, path, ref: default-branch,
     license_expected }`.
   - The lock lives at `skills/skills.lock.json` with a top-level `version` and `updated_at`, and a per-entry
     `previous_commit` in addition to the parent fields `{ id, repo, path, commit, tree_sha256, license, fetched_at }`.
   - `tree_sha256` uses Tenon `tree-sha256-v1` with a `sha256:` prefix.
2. **State file.** Add `stateRoot/skills/last-update.json` (last run outcomes) to §3 Global. It is state, not config.
3. **Wording of "fetched into the plugin payload's `skills/`".** Change it to "fetched into the host plugin root's
   `skills/` before candidate verification; the managed payload receives the same bytes". Tenon becomes a writer of
   `skills/<upstream-id>/`, `skills/skills.lock.json` and `.tenon-skills-staging-*` in the host plugin root, next to
   the host CLI. The stable proof compares tracked `skills/*` children instead of the whole `skills` entry.
4. **"Repository keeps only `skills/tenon/`"** holds only after data-driven-runner merges. Until then the 10 other
   Tenon-owned directories stay tracked through `.gitignore` allow lines.
5. **Performance.** Payload grows from about 7 MB to about 45 MB (huashu-design assets), and the bootstrap re-hashes
   the payload on every CLI or hook dispatch (`tenon-bootstrap.mjs:251,1014`). The parent should either accept the
   measured cost, or add a follow-up that caches the digest by file stat fingerprint in the bootstrap. That work is
   outside this child.
6. **§7 Skills view.** It is a top-level nav view `技能` (`?view=skills`), not part of the Library page.
