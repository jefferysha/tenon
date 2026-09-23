# Host Install and Inventory

Contracts between Tenon's installer / doctor and the two native hosts (Claude Code, Codex). All three were
found by installing the published release and running real tasks, not by unit tests.

## Scenario: Stable release proof survives a dropped GitHub connection

### 1. Scope / Trigger

- `install.sh` → `tenon setup` proves the published tag before activating a runtime.
- Trigger: on a slow proxy the proof failed once with `spawnSync /usr/bin/git ETIMEDOUT` and once with
  `LibreSSL SSL_connect: SSL_ERROR_SYSCALL`, aborting the whole Codex install although the network recovered.

### 2. Signatures

```ts
// packages/cli/src/commands/stable-release.ts
resolveStableTagTarget(env: SetupEnv, version: string): StableReleaseTarget
resolveStableReleaseTarget(env: SetupEnv, http?: StableReleaseHttp): Promise<StableReleaseTarget>
// remote calls, each through runRemoteGit(env, args)
git ls-remote https://github.com/jefferysha/tenon.git refs/tags/v<ver> refs/tags/v<ver>^{}
git -C <proofRoot> fetch --no-tags --depth=1 https://github.com/jefferysha/tenon.git refs/tags/v<ver>
```

### 3. Contracts

- Each remote call: timeout `STABLE_RELEASE_GIT_REMOTE_TIMEOUT_MS = 60_000`, at most
  `STABLE_RELEASE_REMOTE_ATTEMPTS = 3` attempts, pause `500 ms × attempt` between attempts.
- Retry only when the exit is non-zero and stderr matches the transport pattern (case-insensitive, `/iu`):
  `ETIMEDOUT | timed out | SSL_ERROR | SSL_connect | unable to access | Could not resolve host |
  Connection (reset|refused|timed out) | Failed to connect | early EOF | RPC failed | remote end hung up`.
- After a successful attempt the result is validated exactly as before: advertised refs parsed, fetched object is a
  commit, commit equals the advertised peeled commit. Local calls (`init`, `rev-parse`, `cat-file`) keep
  `10_000` ms and never retry.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Transient failure, then success | Target resolved; one extra call per failed attempt |
| Transient failure on all 3 attempts | Throw `stable Release tag proof failed after 3 attempts: <stderr>` (or `object proof`) |
| Non-transient failure (`couldn't find remote ref`, ambiguous refs) | Throw on the first attempt, no retry |
| Fetched object is not a commit / differs from advertised | Throw (`does not resolve to a commit object` / `does not match its advertised peeled commit`) |

### 5. Good / Base / Bad Cases

- Good: one TLS reset during the fetch → retried → install completes.
- Base: healthy network → exactly `ls-remote, init, fetch, rev-parse, cat-file`.
- Bad: retrying a missing tag — hides a real release error and delays the failure.

### 6. Tests Required

- `commands/stable-release.test.ts`: a transient fetch failure then success resolves the commit with command
  sequence `ls-remote, init, fetch, fetch, rev-parse, cat-file`; a persistent `ETIMEDOUT` on `ls-remote` throws
  `after 3 attempts` with 3 calls; `couldn't find remote ref` on fetch throws with a single fetch; the success path
  keeps the 60 000 / 10 000 ms budgets.

### 7. Wrong vs Correct

#### Wrong

```ts
const fetched = env.runCommand('git', fetchArgs, { timeoutMs: STABLE_RELEASE_GIT_REMOTE_TIMEOUT_MS })
if (fetched.code !== 0) throw new Error(`stable Release object proof failed: ${fetched.stderr}`)
```

#### Correct

```ts
const fetched = runRemoteGit(env, fetchArgs)
if (fetched.result.code !== 0) throw remoteFailure('stable Release object proof', fetched)
```

## Scenario: Claude plugin manifest must not declare the standard hooks file

### 1. Scope / Trigger

- Claude Code 2.1 loads `hooks/hooks.json` automatically. A manifest that also references it fails the whole plugin:
  `Hook load failed: Duplicate hooks file detected: ./hooks/hooks.json resolves to already-loaded file …` — no skills,
  no hooks (v1.1.0 in Claude Code 2.1.270).

### 2. Signatures

- `.claude-plugin/plugin.json`: `{ name, description, version, author, license, keywords, skills: "./skills/" }`.
- `.codex-plugin/plugin.json`: keeps `"hooks": "./hooks/hooks.json"` (Codex requires it).

### 3. Contracts

- The Claude manifest has no `hooks` key. Additional hook files, if ever needed, must not be the standard file.
- `tools/verify-skills.sh` fails with `Claude plugin.json 声明了 hooks（…）` when the key is present.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Claude manifest declares `hooks` | `verify-skills` fails; in Claude Code the plugin fails to load |
| Codex manifest lacks `hooks` | Codex loads no Tenon hooks (keep the key there) |

### 5. Good / Base / Bad Cases

- Good: `claude plugin list --json` → Tenon `errors: []`, `claude plugin details tenon@tenon` → Hooks (4), Skills (70).
- Base: older Claude versions also auto-load the standard location, so omitting the key is backward compatible.
- Bad: copying the Codex manifest's `hooks` key into the Claude manifest.

### 6. Tests Required

- `tools/test-hooks.sh`: the sandbox manifest with `"hooks": "./hooks/hooks.json"` makes `verify-skills` report
  `Claude plugin.json 声明了 hooks`.

### 7. Wrong vs Correct

#### Wrong

```json
{ "name": "tenon", "skills": "./skills/", "hooks": "./hooks/hooks.json" }
```

#### Correct

```json
{ "name": "tenon", "skills": "./skills/" }
```

## Scenario: Upstream skills in the host plugin root

### 1. Scope / Trigger

- `tenon setup --<host>` and `tenon update --<host>` fetch every `skills/sources.yaml` entry into the
  host plugin root between the host writing that root and candidate verification.
- Trigger: the 51 bundled third-party skills were 13–24 line first-party rewrites (hue 14 lines vs 869
  upstream). Hosts load skills only from the plugin root, so the content has to arrive there before the
  payload is copied and digested.

### 2. Signatures

```ts
// packages/cli/src/upstream-skills/install.ts
installUpstreamSkills(input: UpstreamSkillInstallInput): Promise<UpstreamSkillInstallResult>
// packages/cli/src/commands/upstream-skill-step.ts — setup/update call site
runUpstreamSkillInstall(deps, env, installer, scope, host, pluginRoot): Promise<UpstreamSkillInstallResult>
// packages/automation/src/skills/upstream-skill-view.ts — doctor and GET /api/skills/sources
readUpstreamSkillView(pluginRoot: string, stateRoot: string): UpstreamSkillView
git ls-remote --symref <url> HEAD                                   # runRemoteGit: 60 s, 3 attempts
git clone --quiet --depth=1 --filter=blob:none --no-checkout --single-branch <url> <dir>  # 300 s, 2 attempts
git -C <dir> sparse-checkout set --no-cone /<path>/ /LICENSE* /LICENCE* /COPYING* /README*
git -C <dir> checkout --quiet                                       # downloads the blobs
```

### 3. Contracts

- Only `https://github.com/<owner>/<name>.git` built from a validated `sources.yaml` row is fetched;
  `sources.yaml` is tracked, so the stable-tag proof also covers the source list.
- Tenon writes exactly `skills/<id>/`, `skills/skills.lock.json` and `.tenon-skills-staging-*` in the
  host plugin root. Each skill is applied by rename: complete new content, complete previous content,
  or absent. Unchanged content leaves the lock bytes untouched, so the payload digest is stable and
  update still reports `无需更新`.
- Licenses: skill license file → SKILL.md `license:` → repository-root license file → root README
  license section; only MIT and Apache-2.0. A root license file is copied into the skill.
- Symlinks, submodules, a missing or renamed `SKILL.md` name, > 64 MiB per skill or > 256 MiB total are
  refused before staging. Failures keep the previous verified content (`kept`) or install nothing
  (`missing`) and are recorded in `<stateRoot>/skills/last-update.json`.
- `pluginPayloadMatchesMarketplace` compares `PAYLOAD_ENTRIES` minus `skills` plus the tracked
  `skills/*` children from `git ls-tree --name-only HEAD skills/`, and returns false when that listing
  fails. `install.sh` does the same and exits 1 when it cannot list them.
- `verifySkillProvenance` declares registry ids ∪ lock ids; the bootstrap re-proves the payload digest
  on every dispatch, with a stat-keyed cache in `stateRoot` so a 48 MB payload is hashed once.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Invalid `sources.yaml` (unknown field, `ref: main`, bundled-token collision) | setup/update exit 1, no activation, `[invalid-skill-sources]` |
| `ls-remote` fails after 3 transient attempts | every skill of that repository `kept` or `missing`, reason `unreachable` |
| Upstream path missing / frontmatter name ≠ id | `removed` / `renamed`, previous content kept |
| No license evidence or license ≠ `license_expected` | `license-missing` / `license-mismatch`, never installed |
| Crash between per-skill renames | verifier reports `content-hash-mismatch`, activation refused, rerun repairs |
| Lock without `sources.yaml`, or entry repo/path ≠ source | `invalid-skill-lock` |
| Nothing changed upstream | lock bytes unchanged → `current` |

### 5. Good / Base / Bad Cases

- Good: one unreachable repository → `[skills] 失败 hue unreachable（保留 a910e31）`, every other skill
  updates, the active runtime stays valid, doctor `skills:upstream` yellow.
- Base: second update with no upstream change → no clone, `lockWritten=false`, `无需更新`.
- Bad: fetching into `~/.claude/skills` or a project skills directory; that is another session's state.

### 6. Tests Required

- `packages/cli/src/upstream-skills/install.test.ts`: local bare fixtures reached through
  `GIT_CONFIG_COUNT` `url.file://…insteadOf`; first install, idempotent second run without a clone,
  per-skill update, kept vs missing, license/rename/symlink/size refusals, stale directory removal.
- `packages/cli/src/commands/update.test.ts`: tracked-children payload proof (true / tampered
  `skills/tenon` / failed `ls-tree`), host-exact update with an unchanged and a changed lock, and
  `invalid-skill-sources` aborting before activation.
- `packages/cli/src/commands/setup.test.ts`: the fetch runs after `installNativePluginCandidate` and
  before `verifyPackagedAssets`, which now always re-verifies.
- `packages/cli/src/runtime/bootstrap.test.ts`: the digest cache is written and reused, a same-size
  content change with restored mtime is still refused, and a corrupt cache falls back to a full hash.
- `tools/clean-codex-install-acceptance.mjs --mode local`: one upstream fixture repository, the host
  root carrying `skills/<id>/SKILL.md` plus the lock, and Codex discovering `tenon:<id>`.

### 7. Wrong vs Correct

#### Wrong

```ts
const assetCode = candidate.verified ? 0 : verifyPackagedAssets(deps, env, candidate.root, false)
```

#### Correct

```ts
await runUpstreamSkillInstall(deps, lifecycleEnv, installer, runtimeScope, host, candidate.root)
// The upstream skill step can change a root that was verified earlier, so assets are always re-verified.
const assetCode = verifyPackagedAssets(deps, lifecycleEnv, candidate.root, false)
```

## Scenario: Doctor reports a host that failed to load Tenon

### 1. Scope / Trigger

- A plugin that fails to load stays `enabled` in the host inventory; only its `errors` array tells it apart. v1.1.0
  doctor was all green while Claude Code could not load Tenon.

### 2. Signatures

```ts
// packages/cli/src/commands/plugin-host.ts
parseHostPluginInventory(host: 'codex' | 'claude', stdout: string): ParsedHostPluginInventory | null
interface ParsedHostPluginInventory { enabledIds; enabledScopes; tenonRoot; tenonVersion; tenonRegistered; tenonLoadErrors: readonly string[] }
// packages/cli/src/deps.ts
HostPluginInventorySource = { kind: 'native'; host; enabledIds; tenonLoadErrors?: readonly string[] } | { kind: 'static' } | { kind: 'unavailable'; host; detail }
```

### 3. Contracts

- `tenonLoadErrors` collects the string entries of `errors` on the `tenon@tenon` entry only; other plugins' errors
  are ignored.
- Doctor check `integration:codex-project-skills` is red when `tenonLoadErrors` is non-empty:
  detail `<Claude|Codex> 报告 Tenon 插件加载失败：<errors joined by ；>`,
  hint `运行 tenon setup --<host> -y 安装当前正式版本并新开会话；…`.

### 4. Validation & Error Matrix

| Condition | Doctor |
| --- | --- |
| Inventory JSON malformed | red: inventory unavailable |
| Tenon not registered | red: no unique Tenon registration |
| Tenon registered with load errors | red: load failed, errors listed |
| Tenon registered, no errors | continue to skill-root checks |

### 5. Good / Base / Bad Cases

- Good: v1.1.0 in Claude Code 2.1 → doctor red with the duplicate-hooks message.
- Base: `errors: []` → no new finding.
- Bad: treating `enabled: true` as healthy.

### 6. Tests Required

- `commands/update.test.ts`: `parseHostPluginInventory('claude', …)` keeps Tenon's errors and ignores another
  plugin's; an entry with `errors: []` yields `[]`.
- `commands/doctor.test.ts`: a native Claude inventory with `tenon@tenon` enabled and a load error → `code 1`,
  check red, detail contains `加载失败` and the error text, hint contains `tenon setup --claude`.

### 7. Wrong vs Correct

#### Wrong

```ts
if (!hostPluginIds.has(TENON_PLUGIN_IDENTITY)) return red(…)   // enabled ⇒ healthy
```

#### Correct

```ts
const loadErrors = inventory.tenonLoadErrors ?? []
if (loadErrors.length > 0) return red('integration:codex-project-skills', `… 报告 Tenon 插件加载失败：${loadErrors.join('；')}`, …)
```

## Scenario: Retired 1.x release line ranks below 0.x

### 1. Scope / Trigger

- Numbering restarted at 0.1.0 after v1.0.0–v1.1.5 were published. Plain SemVer ranks 0.1.0 below 1.1.5, so update,
  convergence receipts and installer journal adoption would refuse the migration as a downgrade.
- Trigger: any code that decides whether one Tenon release is newer than another, or which release is the N-1 baseline.

### 2. Signatures

```ts
// packages/cli/src/commands/stable-release.ts
export const RETIRED_RELEASE_VERSION = /^1\.(0\.[0-9]|1\.[0-5])$/
export function isRetiredReleaseVersion(version: string): boolean       // throws on non-stable SemVer
export function compareReleaseOrder(left: string, right: string): number // -1 | 0 | 1; throws on non-stable SemVer
```

```bash
stable_version_is_less "$older" "$current"          # install.sh: exit 0 iff release order older < current
bash tools/prepare-n-minus-one-release.sh <out>      # fixture schemaVersion 3, status none | pinned; exit 78 = documented skip
```

### 3. Contracts

- Order: a retired version (exactly the 16 published numbers) ranks below every other stable version; the same rank
  compares numerically. `1.0.10`, `1.1.6` and `1.2.0` are not retired.
- One literal: `^1\.(0\.[0-9]|1\.[0-5])$` appears byte-identical in `stable-release.ts`, `install.sh`,
  `release-candidate.yml` and `prepare-n-minus-one-release.sh` (`check:release-workflows` enforces it). Bash ERE has no
  `(?:`, so the group is capturing everywhere.
- Users: `update-native.ts` (cleanup-pending receipt vs latest, host plugin / active runtime vs target),
  `host-plugin-convergence.ts` (receipt supersession), `host-convergence-recovery.ts` (host ahead of runtime),
  `install.sh` journal adoption. The kernel `.pipeline-version` guard is not a release order and is unchanged.
- `tenon update` prints `[update] <label> <v> 属于已退役的 1.x 版本线；迁移到 <target>` for each replaced retired version.
- 1.x code on an installed machine cannot change: 1.x `tenon update` still refuses 0.x; the v0.1.0 one-line installer
  runs the packaged 0.x CLI and is the migration path.
- Release: the candidate rejects retired tags; `release.yml` creates Releases with `--latest`. N-1 fixture `none` exits 78
  only when `release == v<package.json version>`; once the current version is not retired, a pinned baseline must be the
  latest non-retired stable tag below it.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| 0.x update, host plugin or runtime 1.1.5, target 0.1.0 | proceeds with the retired-line notice |
| 0.x update, installed 0.1.1, target 0.1.0 | `拒绝从宿主 plugin 0.1.1 降级到 0.1.0`, exit 1, no mutation |
| cleanup-pending receipt 1.1.5, target 0.1.0 | `检测到旧 1.1.5 cleanup-pending；继续发布更高 stable 0.1.0` |
| Convergence receipt 0.1.1, target 0.1.0 | `未被当前稳定版本超越；拒绝覆盖` |
| install.sh journal target 1.1.5, installer 0.1.0 | adopted |
| Candidate tag `v1.0.3` | `tag v1.0.3 uses a retired 1.x version number` |
| N-1 `none`, release ≠ current | `N-1 一次性跳过只适用于 <release>；当前 v<ver> 必须固定最近的正式版本`, exit 1 |
| N-1 pinned retired baseline, current not retired | `N-1 基线不能是已退役版本 <tag>`, exit 1 |
| N-1 pinned older than the latest non-retired tag below current | `N-1 基线 <tag> 不是低于 v<ver> 的最近正式版本 <latest>`, exit 1 |

### 5. Good / Base / Bad Cases

- Good: a v1.1.5 host runs the v0.1.0 installer; journal adoption and receipts accept 0.1.0 as newer.
- Base: 0.1.0 → 0.1.1 and 2.0.0 vs 1.2.3 compare as plain SemVer.
- Bad: publishing a new `v1.0.x` or `v1.1.0`–`v1.1.5`; it would rank below every 0.x release.

### 6. Tests Required

- `commands/stable-release.test.ts`: the order table both ways; `isRetiredReleaseVersion` for the 16 numbers and the
  non-retired neighbours; invalid input throws `not complete stable SemVer`.
- `commands/update.test.ts`: retired host + runtime migrate to 0.1.0 with the notice; 0.1.1 → 0.1.0 is rejected with no
  mutation; a retired cleanup-pending receipt does not block the migration.
- `commands/setup.test.ts`: a 1.1.5 receipt is superseded by 0.1.0, a 0.1.1 receipt is not;
  `hostConvergenceHasNewerStableCandidate` only proves a tag when the host ranks above the runtime.
- `tools/install-bootstrap.node-test.mjs`: `stable_version_is_less` over the same table.
- `tools/check-release-workflows.node-test.mjs`: identical literal, candidate guard, `--latest`, exit 78 acceptance, and
  executable prepare-script fixtures for every N-1 row.

### 7. Wrong vs Correct

#### Wrong

```ts
if (compareStableVersions(version, target.version) > 0) throw new Error(`拒绝从${label} ${version} 降级到 ${target.version}`)
// 1.1.5 > 0.1.0 numerically: every 1.x machine is refused
```

#### Correct

```ts
if (compareReleaseOrder(version, target.version) > 0) throw new Error(`拒绝从${label} ${version} 降级到 ${target.version}`)
if (isRetiredReleaseVersion(version) && !isRetiredReleaseVersion(target.version)) deps.io.out(`[update] ${label} ${version} 属于已退役的 1.x 版本线；迁移到 ${target.version}`)
```

## Scenario: N-1 gate runs the previous release against current writes

### 1. Scope / Trigger

- An upgrade or rollback puts two release ages on one machine: the current process writes Change state and
  `skills/skills.lock.json`, and the other release (the candidate's verifier, an older active runtime after rollback)
  reads them. Two breaks went this way: a newer lock fetcher against an older verifier (`version '2' 不受支持（需要 1）`),
  and the v0.1.0 lock parser rejecting any added entry key because it checks exact keys.
- Trigger: any change to canonical Change state, the skill-lock codec, the fetcher or the verifier; any release.

### 2. Signatures

```jsonc
// tools/fixtures/n-minus-one-release.json — pinned to the published v0.1.0
{ "schemaVersion": 3, "status": "pinned", "tag": "v0.1.0", "pluginVersion": "0.1.0",
  "gitCommit": "7561efe06021c7c3d5216caa4ec7cb21ff1b50b3", "cliEntry": "packages/cli/dist/tenon.mjs",
  "cliSha256": "c40308e5096f38170151f17f4914beadd2cdc598fab0de5348a8f51e4a3e933f",
  "payloadEntries": [ /* v0.1.0 PAYLOAD_ENTRIES, 13 entries */ ] }
```

```bash
bash tools/prepare-n-minus-one-release.sh <out>     # git archive <gitCommit> -- payloadEntries; checks tag, digest, manifests
TENON_N_MINUS_ONE_PAYLOAD=<out>/payload bash tools/test-bundle.sh   # CI; without it test-bundle prepares into $TMP
tenon internal-skill-upstream fetch --root <root>    # the lock writer (both releases)
tenon internal-skill-provenance verify --root <root> # the lock verifier (both releases)
```

### 3. Contracts

- Section 5 of `test-bundle.sh` runs the CLI bytes pinned by `cliSha256`, never a machine cache. It checks:
  1. N-1 `init` + `status`; N-1 `set`; current `get` of it; current `set` after it (current reads N-1).
  2. N-1 `get phase` / `status --json` on `t8-smoke`, which the current CLI created and moved to `explore`; N-1
     `set` on it; current `get` of that value (N-1 reads current).
  3. Lock, current → N-1: current `fetch` into a copy of the N-1 payload's `templates` + `skills`; N-1 `verify` exits 0.
  4. Lock, N-1 → current: N-1 `fetch` into the current `templates` + tracked `skills/*`; current `verify` exits 0.
- Lock checks replace `skills/sources.yaml` with one fixture row (`n1-probe`, MIT). Upstream is a local git repo
  reached through `GIT_CONFIG_COUNT` `url.file://<hub>/.insteadOf=https://github.com/` with an isolated `HOME`,
  `GIT_CONFIG_NOSYSTEM=1`: no network, no real git config.
- Section 4 exports `TENON_RUNTIME_HOME=$TMP/.tenon-runtime-home` for every current and N-1 call.
- One identity (`TENON_USER`) for both CLIs; 0.x `init` has no `--user`. With two identities the owner guard refuses,
  which is ownership, not compatibility.
- The skill lock writer emits exactly the v1 eight entry keys; see `LOCK_ENTRY_KEYS_V1` in
  `packages/kernel/src/skills/upstream-sources.ts`. A new field needs a reader that has shipped as N-1 first.
- CI and the release candidate treat only prepare exit 78 as a skip, and 78 exists only for `status: none` naming
  the current version. After each stable release, re-pin the fixture to it before the next candidate; the prepare
  script fails when the pin is older than the latest non-retired tag below `package.json`'s version.
- Pinned equal to the current version (main before the version bump) is accepted: `latest` starts from the pin.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Current lock writer adds an entry key | `FAIL - bundle: 当前 writer 的 skills.lock.json 被 N-1 verifier（v0.1.0）接受`, detail `[invalid-skill-lock] … skills[0] 字段须为 id / repo / path / commit / tree_sha256 / license / fetched_at / previous_commit` |
| Current lock writer writes `version: 2` | same row, `version '2' 不受支持（需要 1）` |
| Current verifier stops accepting a v1 lock | `FAIL - bundle: N-1 writer（…）的 skills.lock.json 被当前 verifier 接受` |
| Current canonical state gains a key the N-1 reader rejects | `FAIL - bundle: N-1 CLI（…）读取当前 runtime 写入的 Change` |
| Fixture pinned but tag missing or moved | `FAIL - bundle: 固定公开 N-1 payload 可准备` / `N-1 tag 未绑定固定 commit` |
| Only `TENON_N_MINUS_ONE_CLI` set, not at `<payload>/<cliEntry>` | `FAIL - bundle: N-1 payload 可做 skill lock 验证根` |

### 5. Good / Base / Bad Cases

- Good: main at 0.1.0 or 0.1.1 with the v0.1.0 pin: 38 passed, including all eight N-1 rows.
- Base: v0.1.1 ships; the v0.1.2 candidate fails until the fixture is pinned to v0.1.1 with its commit and digest.
- Bad: switching back to `status: none` to get a release out; prepare exits 1 because `release` ≠ current.

### 6. Tests Required

- `bash tools/test-bundle.sh` (local, prepares the payload itself) and the CI form with `TENON_N_MINUS_ONE_PAYLOAD`.
- `tools/check-release-workflows.node-test.mjs`: the exit-78 acceptance in both workflows, the prepare-script
  fixtures, and a static check that `test-bundle.sh` keeps both lock orders, the N-1-reads-current rows and no
  `init --user`.
- Teeth, when changing this gate: make `serializeUpstreamSkillLock` emit one extra key, rebuild
  (`npx tsc -b packages/kernel && npm run bundle`), confirm row 3 goes red, then restore and rebuild.

### 7. Wrong vs Correct

#### Wrong

```bash
# Current reads N-1 only; a lock the old verifier rejects ships unnoticed.
node "$N_MINUS_CLI" init n1-created … && node "$BUNDLE" get n1-created scope
```

#### Correct

```bash
lock_write="$(lock_cli "$writer" internal-skill-upstream fetch --root "$lock_root")"
lock_read="$(lock_cli "$reader" internal-skill-provenance verify --root "$lock_root")"   # both orders
```
