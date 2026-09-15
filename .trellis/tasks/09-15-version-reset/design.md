# Design: version reset to 0.1.x

> **Parent overrides** (`.trellis/tasks/09-15-tenon-next-capabilities/design.md` §9 wins over this file): Parent §10; X18. Nothing is deleted from GitHub in wave 1.

Binding: parent `design.md` (§8 Release) and `implement.md` (waves). Requirements: `prd.md` R1–R6.
All citations are against `main` at `2290233c` and GitHub state read on 2026-09-15.

## 1. Facts this design is built on

### 1.1 Where the version lives (the `release: prepare v1.1.5` commit `a0a7f0a4` touched exactly these 29 files)

| Kind | Files |
| --- | --- |
| Manifests | `package.json`, `docs-site/package.json`, `packages/{automation,channel,cli,dashboard-app,kernel,npm-bootstrap,server,tap}/package.json`, `.codex-plugin/plugin.json:3`, `.claude-plugin/plugin.json:4`, `.claude-plugin/marketplace.json:8` (`metadata.version`), `package-lock.json` (11 lines: root ×2, docs-site, 8 workspaces) |
| Code constants | `install.sh:10` `TENON_RELEASE_VERSION="1.1.5"`, `packages/cli/src/commands/plugin-host.ts:36`, `packages/server/src/hostTargetPlanProtocol.ts:38` and `packages/dashboard-app/src/api/hostTargetPlanDecoders.ts:213` (`HOST_PLAN_RELEASE_TAG = 'v1.1.5'`) |
| Generated | `packages/cli/dist/tenon.mjs`, `packages/server/dist/dashboard.mjs` |
| Docs | `README.md:70,76,82,85`, `README.en.md:84,90,93`, `docs/usage/{installation,quickstart}.md`, `docs/usage/zh-CN/{installation,quickstart}.md`, `packages/npm-bootstrap/README.md:16`, `docs/usage/release-notes.md`, `docs/usage/zh-CN/release-notes.md` |

Consistency is already enforced: `tools/product-identity.node-test.mjs:77-110` requires all 13 manifest versions and the four
code constants to be equal (run by `npm run check:identity`); `tools/check-docs.mjs:381-405` requires `install.sh` and the
seven install documents to carry `v<package.json version>/install.sh`; `release-candidate.yml:80-89` requires tag = root =
Codex = Claude manifest version. Tests derive the current version from `TENON_RELEASE_VERSION`
(`setup.test.ts:46`, `release-store.integration.test.ts:28`, `install-bootstrap.node-test.mjs:12-36`), so a bump needs no test edits.

### 1.2 Every version *ordering* decision

| Site | Rule today |
| --- | --- |
| `packages/cli/src/commands/stable-release.ts:57-66` `compareStableVersions` | plain numeric SemVer (`STABLE_VERSION` `:7`) |
| `update-native.ts:104,130-135` | cleanup-pending receipt version > latest stable → `拒绝隐式降级` |
| `update-native.ts:190-202` | host plugin or active runtime version > target → `拒绝从<label> <v> 降级到 <target>` |
| `host-plugin-convergence.ts:64-66`, `:112-115` | a new receipt supersedes an old one only when the new target is greater |
| `host-convergence-recovery.ts:105-106` | the host plugin counts as a newer candidate only when greater than the active runtime |
| `install.sh:739-753` `stable_version_is_less`, used at `:788-815` | a completed installer journal is adoptable only for a strictly lower target |
| `packages/kernel/src/state/ownership-version.ts:30,79,145` | `.pipeline-version` project sync guard/banner (see D8) |

No ordering exists in setup (`setupHost.ts:83-84`, `setup-managed-runtime.ts:58-61` install the packaged version), the release
store (`release-store.ts:250-267` equality only), the runtime bootstrap (`runtime/tenon-bootstrap.mjs:18,194-198` format only),
or `install.sh` on a machine without a journal (`install.sh:816-842` removes whatever plugin is installed).

### 1.3 Release pipeline and the N-1 gate

- Candidate: `release-candidate.yml:52-55` strict tag regex, `:71-79` existing tag must match, `:80-89` version consistency,
  `:129-133` N-1 bundle with hard-coded `TENON_N_MINUS_ONE_RELEASE="v1.0.1"`.
- Writer creates the annotated tag (`release-writer.yml:209-225`) and dispatches public acceptance (`:253-270`).
- `release.yml:204-208` runs `gh release create --verify-tag --generate-notes` without `--latest`. `gh` 2.96.0 help: default is
  "automatic based on date and version", so a new `v0.1.0` would not reliably displace `v1.1.5` as Latest.
- Public acceptance installs the tag, then runs `tenon update --codex` and fails if the release changes
  (`tools/clean-codex-install-acceptance.mjs:1072-1086`). `tenon update` resolves `releases/latest` (`stable-release.ts:9,170-176`).
  So public acceptance of v0.1.0 passes only if v0.1.0 is Latest.
- N-1: `tools/fixtures/n-minus-one-release.json` pins `v1.0.1` commit `8f716852…`. `tools/prepare-n-minus-one-release.sh:43-47`
  requires the tag to exist; `ci.yml:186-198` and `tools/test-bundle.sh:186-266` fail when the payload cannot be prepared
  (default label `v1.0.1` at `:240`). The frozen reader `tools/fixtures/n-minus-one-canonical-reader.mjs` has no tag dependency.
- Main spec `openspec/specs/plugin-distribution/spec.md:863-874` requires the exact public N-1 and forbids a silent skip.

### 1.4 GitHub state (read-only, 2026-09-15)

- 16 releases `v1.0.0`–`v1.1.5`, Latest `v1.1.5`; 16 remote tags; local tags `v1.0.0 v1.0.1 v1.0.7 v1.0.8 v1.0.9`.
- `immutable: false` on releases, rulesets `[]`, immutable releases disabled → deletion is permitted.
- Peeled commits of `v1.0.7`–`v1.1.5` are ancestors of `origin/main`. **`v1.0.0`–`v1.0.6` are not** (`v1.0.2`–`v1.0.6` objects are
  not even present locally). Deleting those tags can make that code unreachable on GitHub → backup is mandatory (§6.3).
- Release assets: `tenon-legacy-bridge-<ver>.tar.gz` (+ `SHA256SUMS` on later releases).

### 1.5 Code that cannot change

A 1.x machine runs 1.x code for `tenon update`, the daily auto-update (`hooks/auto-update.sh:63` → `tenon update --<host> --yes --auto`)
and doctor. v1.1.5's `update-native.ts:190-202` is identical to `main` today: it rejects `0.1.0` as a downgrade with zero mutation.
After the 1.x tags are deleted, 1.x doctor's release-identity probe (`doctor-product-identity.ts:239`) fails. The only code we control on
such a machine is the `v0.1.0` `install.sh` and the packaged 0.1.0 CLI it runs (`install.sh:1048-1054`). The repo already did this once,
for v1.0.1 → v1.0.2 (`docs/usage/installation.md:45-51`, `openspec/specs/open-source-documentation-experience/spec.md:805-816`).

## 2. Boundaries

In scope:
- One release-order rule (TS + `install.sh`), used by every site in §1.2 except the kernel project guard.
- A one-time migration notice when a retired version is replaced.
- The N-1 fixture schema and a skip that is valid only once, for `v0.1.0`.
- Release workflow checks: `--latest` on create, and rejecting retired version numbers.
- The version bump to 0.1.0, docs, release notes and specs.
- The ordered publish-then-delete runbook.

Out of scope and unchanged:
- The kernel `.pipeline-version` guard (D8).
- `release-legacy-setup-retirement.ts:75` (`'1.0.1'` is a historical WAL shape, not a current version).
- Historical release-note entries (prd Out of Scope).
- Recovery of a managed release journal frozen on a 1.x target after tag deletion (fails closed as today).
- Dashboard, hooks and runtime bootstrap.
- Any compatibility proof for Changes created by 1.x (D12).

## 3. Version rules

### 3.1 Signatures

```ts
// packages/cli/src/commands/stable-release.ts
/** Stable versions published before the 2026-09-15 reset (v1.0.0–v1.0.9, v1.1.0–v1.1.5); never reused. */
export const RETIRED_RELEASE_VERSION = /^1\.(?:0\.[0-9]|1\.[0-5])$/
export function isRetiredReleaseVersion(version: string): boolean   // parses first; throws on non-stable SemVer
/** Install order: every retired version ranks below every other stable version; same rank compares numerically. */
export function compareReleaseOrder(left: string, right: string): number   // -1 | 0 | 1; throws like parseVersion
```

`compareStableVersions` is renamed to `compareReleaseOrder` (no alias), so no caller can keep pure-SemVer ordering by accident.
Call sites: `update-native.ts:19,104,197`, `host-plugin-convergence.ts:17,65,114`, `host-convergence-recovery.ts:18,106`.

```bash
# install.sh — same rule, inline node, used only for journal adoption (install.sh:788-789)
stable_version_is_less() {   # exit 0 iff release order of $1 < $2; exit 1 otherwise or on invalid input
  run_node -e '… const retired = /^1\.(?:0\.[0-9]|1\.[0-5])$/u; rank = retired.test(v) ? 0 : 1; compare rank, then parts …' "$1" "$2"
}
```

### 3.2 Truth table (the same cases go into the TS test and the shell test)

| left | right | `compareReleaseOrder` | Why |
| --- | --- | --- | --- |
| 0.1.0 | 1.1.5 | 1 | retired ranks lower (migration) |
| 1.0.0 | 0.0.1 | -1 | any retired < any 0.x |
| 1.1.5 | 1.0.9 | 1 | inside the retired line: numeric |
| 0.1.1 | 0.1.0 | 1 | 0.x numeric |
| 0.2.0 | 0.1.9 | 1 | R4 |
| 0.1.0 | 0.1.0 | 0 | |
| 1.2.0 | 0.9.9 | 1 | not retired: numeric (future majors) |
| 2.0.0 | 1.2.3 | 1 | keeps `update.test.ts:655-709` meaning |
| 1.0.10 / 1.1.6 | — | not retired | the set is exactly the 16 published numbers |

"Migration happens once" follows from the order: 1.x → 0.x is an upgrade, and 0.x → 1.x is a downgrade and is rejected. The candidate
workflow rejects retired numbers, so no retired number can be published again (D3).

### 3.3 Behavior per entry point

| Entry | Installed | Target | Result |
| --- | --- | --- | --- |
| `install.sh` v0.1.0, no journal | 1.1.5 plugin + marketplace | 0.1.0 | unchanged flow: remove, register `v0.1.0`, verify, packaged `tenon setup` (`install.sh:816-1054`) |
| `install.sh` v0.1.0, journal `plugin-installed` target 1.1.5 matching host | 1.1.5 | 0.1.0 | adopt (`1.1.5` < `0.1.0`), then as above |
| `install.sh` v0.1.0, journal target 0.1.1 | 0.1.1 | 0.1.0 | `not an adoptable completed prior stable target` (`install.sh:812-815`) |
| `install.sh` v0.1.0, no journal | 0.1.1 | 0.1.0 | explicit versioned install proceeds (D4) |
| 0.x `tenon update` | host or runtime 1.1.5 | latest 0.1.0 | proceeds; prints `[update] <label> 1.1.5 属于已退役的 1.x 版本线；迁移到 0.1.0` |
| 0.x `tenon update` | 0.1.1 | latest 0.1.0 | `拒绝从宿主 plugin 0.1.1 降级到 0.1.0`, exit 1, zero mutation |
| 0.x `tenon update` | 0.1.0 | latest 0.1.1 | normal update |
| 1.x `tenon update` / auto-update | 1.1.5 | latest 0.1.0 | 1.x code: `拒绝从宿主 plugin 1.1.5 降级到 0.1.0`, zero mutation (D1) |

## 4. Data flow

### 4.1 Install (the migration path)

```
curl …/v0.1.0/install.sh | bash -s -- --<host>
  install.sh (0.1.0 bytes) ─ proves Release v0.1.0 via API (:403-421) and tag object (:423-466)
    ├─ journal? ─ yes → read_installer_journal → same target | adopt lower (stable_version_is_less, retired rule) | refuse
    │           └ no  → snapshot plugin + marketplace (1.1.5 allowed)
    ├─ remove 1.1.5 plugin → remove marketplace → add marketplace @v0.1.0 → add plugin (:822-895)
    ├─ verify version == 0.1.0, manifests, clean checkout, verify-skills (:897-1038)
    └─ node <root>/packages/cli/dist/tenon.mjs setup --<host> --yes   (0.1.0 CLI)
         └─ publishManagedRelease: stage 0.1.0 runtime, previousRelease = 1.1.5 runtime, launcher → 0.1.0, Dashboard 0.1.0
            convergence receipts compare with compareReleaseOrder (0.1.0 supersedes 1.x receipts)
```

### 4.2 Update

```
~/.local/bin/tenon update --<host>  → active runtime CLI
  resolve releases/latest (stable-release.ts:170) → target
  cleanup-pending receipt? compareReleaseOrder(target, receiptVersion)          (update-native.ts:104)
  prepareCandidate: for host plugin + active runtime: compareReleaseOrder(v, target) > 0 → reject; retired → notice   (:190-202)
  native plan → host commands → verify → activate → Dashboard
```

The active runtime decides which code runs. On 1.x it is 1.x code (D1). On 0.x it is the rule above.

## 5. N-1 compatibility gate

### 5.1 Fixture schema 3 (`tools/fixtures/n-minus-one-release.json`)

```jsonc
// v0.1.0 only
{ "schemaVersion": 3, "status": "none", "release": "v0.1.0",
  "reason": "first release after the version reset; no earlier 0.x release exists" }
// every later release
{ "schemaVersion": 3, "status": "pinned", "tag": "v0.1.0", "pluginVersion": "0.1.0", "gitCommit": "<40 hex>",
  "cliEntry": "packages/cli/dist/tenon.mjs", "cliSha256": "<64 hex>", "payloadEntries": [ …unchanged closed set… ] }
```

### 5.2 `tools/prepare-n-minus-one-release.sh <out>` rules (single decision point)

| Condition | Exit | Output |
| --- | --- | --- |
| `schemaVersion != 3` or unknown `status` | 1 | `N-1 fixture 结构非法` |
| `none` and `release == "v" + package.json version` | **78** | `N-1 skipped: v0.1.0 <reason>` |
| `none` and release differs | 1 | `N-1 一次性跳过只适用于 <release>；当前 v<ver> 必须固定最近的正式版本` |
| `pinned`, current non-retired, pinned version retired | 1 | `N-1 基线不能是已退役版本 <tag>` |
| `pinned`, current non-retired, a greater non-retired stable tag below current exists in the checkout | 1 | `N-1 基线 <tag> 不是低于 v<ver> 的最近正式版本 <latest>` |
| `pinned`, current retired (waves 1–4 on `main`) | — | latest check not applied; legacy `v1.0.1` pin keeps working |
| `pinned`, tag missing or bound elsewhere, digest or manifest mismatch | 1 | existing messages (`:43-75`) |
| `pinned` valid | 0 | existing `N-1 release ready: …` |

Why 78 (EX_CONFIG): the step can tell "documented skip" apart from failure without parsing text.

### 5.3 Consumers

- `ci.yml:186-195` and `release-candidate.yml:129-133`: `if bash tools/prepare-n-minus-one-release.sh "$out"; then` export payload
  and a label built from the fixture; `else code=$?; [ "$code" -eq 78 ] || exit "$code"; fi`. The hard-coded `v1.0.1` label goes away.
- `tools/test-bundle.sh` N-1 block: fixture `status` `none` + explicit `TENON_N_MINUS_ONE_{CLI,PAYLOAD}` → `bad` (contradiction).
  `none` without env → run prepare; 78 → print `[HONEST SKIP] bundle: 真实 N-1 兼容：<reason>` (counts neither pass nor fail); any other
  exit → `bad`. Pinned keeps today's flow, with the label default taken from the fixture tag. The frozen reader check (`:186-192`) always runs.
- After v0.1.0, the v0.1.1 prep commit pins `v0.1.0`. From then on the latest-tag rule forces re-pinning at each release.

## 6. Release and deletion procedure (wave 5; commands in `implement.md` §W5)

### 6.1 Order (a later step never starts before the earlier one is verified)

1. Main session merges all children. Then `release: prepare v0.1.0` commit: every §1.1 position → 0.1.0, fixture `status: none`,
   docs, release notes, specs, dist rebuilt.
2. Push `main`; canonical CI green (N-1 step prints the skip).
3. Dispatch `release-candidate.yml` with `ref=<sha>`, `tag=v0.1.0` → writer → `release.yml` (creates Release **with `--latest`**) →
   public acceptance.
4. Verify: Release not draft or prerelease, `targetCommitish=main`, assets present, `releases/latest` = `v0.1.0`, tag peels to `<sha>`,
   acceptance run green.
5. Real hosts: a machine on v1.1.5 (Codex and Claude Code) runs the v0.1.0 one-liner. Doctor green, host inventory 0.1.0, Dashboard 0.1.0,
   `tenon update --<host>` is a no-op. Record 1.x `tenon update` output before migrating (expected refusal, D1). Fresh-machine install. Parent
   cross-child acceptance.
6. Precondition for deletion: steps 2–5 green; acceptance machines report no pending managed journal (`tenon doctor`, `tenon runtime status`).
7. Backup (§6.3). Then delete all 1.x Releases with their tags, then any remaining 1.x remote tags, then local tags.
8. Verify (§6.4). Re-run public acceptance for `v0.1.0` and the latest `main` CI run with no 1.x tags present.

### 6.2 Point of no return

Steps 1–6 are reversible:
- Before tag creation, revert the prepare commit.
- After release and before step 7, delete the `v0.1.0` release and tag, then `gh release edit v1.1.5 --latest`. Machines already on 0.1.0 reinstall
  v1.1.5 with its versioned installer (explicit install is allowed, D4).

Step 7 is irreversible. Tags can be re-pushed from the bundle, but Release objects, IDs, dates, notes and assets cannot be restored as the same
objects.

### 6.3 Backup before deletion

Store outside the repository:
- The release list JSON.
- The remote tag list.
- A `git bundle` of all `v1.*` tags, fetched first so `v1.0.2`–`v1.0.6` objects are local. Run `git bundle verify`.
- `gh release download` of each 1.x release plus its notes body.

This keeps off-`main` code (`v1.0.0`–`v1.0.6`) recoverable without keeping any 1.x ref on GitHub.

### 6.4 Verification of deletion (prd acceptance 2)

- `gh release list` shows only `v0.1.0` (Latest).
- `gh api repos/jefferysha/tenon/releases/latest --jq .tag_name` = `v0.1.0`.
- `git ls-remote --tags origin 'refs/tags/v1.*'` is empty, and `git tag -l 'v1.*'` is empty.
- `https://api.github.com/repos/jefferysha/tenon/releases/tags/v1.1.5` returns 404.
- `raw.githubusercontent.com/…/v1.1.5/install.sh` returns 404. The CDN can lag, and a cached 1.1.5 installer still fails closed at the Release API proof
  (`install.sh:403-407`).

## 7. Error matrix

| Condition | Result |
| --- | --- |
| 0.x update, host plugin or runtime retired, target 0.x | proceed + `属于已退役的 1.x 版本线` notice |
| 0.x update, installed 0.x > target | `拒绝从<label> <v> 降级到 <t>`, exit 1, zero mutation |
| 0.x update, installed non-retired 1.2+/2.x > 0.x target | same rejection |
| 0.x update, cleanup-pending receipt 1.x, target 0.x | `检测到旧 <v> cleanup-pending；继续发布更高 stable <t>` |
| 0.x update, cleanup-pending receipt 0.1.1, target 0.1.0 | `cleanup-pending runtime 0.1.1 高于 latest stable 0.1.0；拒绝隐式降级` |
| Unparsable version anywhere | existing `无法比较` / `无法参与稳定版本比较` (unchanged) |
| Convergence receipt 1.1.5, new target 0.1.0 | superseded; receipt 0.1.1 vs target 0.1.0 → `未被当前稳定版本超越；拒绝覆盖` |
| 1.x `tenon update` or auto-update after v0.1.0 is Latest | 1.x refusal, zero mutation; auto-update writes it to `auto-update-<host>.log` once per 24 h; docs name the one-liner |
| 1.x doctor after tag deletion | red (release identity probe fails); fix = one-liner |
| Pending managed journal frozen on 1.x after deletion | recovery re-proof `stable Release tag proof is missing`, fails closed (not handled; §6.1 step 6 precondition) |
| install.sh journal target retired and host matches | adopted |
| install.sh journal target greater (release order) | `not an adoptable completed prior stable target` |
| Candidate tag in retired set (e.g. `v1.0.3`) | candidate fails `tag v1.0.3 uses a retired 1.x version number` before any gate |
| N-1 rows | §5.2 |
| `v0.1.0` created but not Latest (older pipeline, manual create) | public acceptance fails on same-version update; fix `gh release edit v0.1.0 --latest`, re-dispatch acceptance |
| `gh release delete` fails mid-loop | re-run the loop; the list is recomputed from GitHub, already-deleted tags are absent |
| Remote tag left without a Release | removed by `git push origin --delete refs/tags/<tag>` step |

## 8. Tests required

Wave 1 (versions injected, independent of `TENON_RELEASE_VERSION`):

1. `packages/cli/src/commands/stable-release.test.ts` (replace `:89-93`): §3.2 table through `compareReleaseOrder`. `isRetiredReleaseVersion`
   is true for all 16 numbers and false for `1.0.10, 1.1.6, 1.2.0, 0.1.0, 0.0.1`. `'1.1'`, `'v1.1.5'`, `'01.1.5'` throw `not complete stable SemVer`.
2. `packages/cli/src/commands/update.test.ts`:
   - a. `a retired 1.x host plugin and runtime migrate to 0.x instead of being rejected as downgrade`. Harness of `:1405-1451`, with inventory
     version `1.1.5`, `fakeRuntimeInstaller(false, null, releaseId, '1.1.5')`, resolver `{0.1.0, v0.1.0}`, candidate `0.1.0`.
     Assert: exit 0; one activation; exec includes `plugin marketplace add jefferysha/tenon --ref v0.1.0 --json`; out contains
     `宿主 plugin 1.1.5 属于已退役的 1.x 版本线；迁移到 0.1.0`; err has no `拒绝从`.
   - b. `a newer 0.x host plugin still rejects update to an older 0.x`. Inventory `0.1.1`, target `0.1.0`. Assert: exit 1; non-git exec is exactly
     `[['codex','plugin list --json']]`; activations `[]`; err contains `拒绝从宿主 plugin 0.1.1 降级到 0.1.0`.
   - c. `cleanup-pending for a retired 1.x runtime does not block the 0.x migration`. Copy of `:1405` with receipt and runtime `1.1.5`, target `0.1.0`.
     Assert: exit 0; one activation; out contains `检测到旧 1.1.5 cleanup-pending；继续发布更高 stable 0.1.0`.
   - `:655-709` stay unchanged and must still pass (2.0.0 vs 1.2.3).
3. `packages/cli/src/commands/setup.test.ts` next to `:1281`:
   - Legacy plugin absent, receipt `stableTarget 1.1.5`, new target `0.1.0` → `recordPendingHostPluginConflict` returns true and writes a
     `completed` receipt with target `0.1.0`.
   - Receipt `0.1.1` vs target `0.1.0` → false and err `未被当前稳定版本超越`.
4. `hostConvergenceHasNewerStableCandidate` (`host-convergence-recovery.ts:89-117`):
   - Runtime `0.1.0`, host `1.1.5` → false with no `git ls-remote` call.
   - Runtime `1.1.5`, host `0.1.0` → the call log shows `ls-remote … refs/tags/v0.1.0`, proving the order gate passed (the proof stub may fail).
5. `tools/install-bootstrap.node-test.mjs`: source `stable_version_is_less` from `install.sh` with a `run_node() { node "$@"; }` shim.
   For every §3.2 row assert exit 0 ⇔ `left < right`; invalid input exits 1.
6. `tools/check-release-workflows.node-test.mjs`:
   - The retired regex literal is identical in `stable-release.ts`, `install.sh` and `release-candidate.yml`.
   - The candidate identity step rejects a retired tag (executed with the existing `workflowRunScript` pattern and a git stub, or static match of
     the guard before `version mismatch`).
   - `release.yml` `gh release create` contains `--latest`.
   - `ci.yml` and `release-candidate.yml` N-1 steps accept exit `78` and contain no `v1.0.1`.
   - Executable fixtures for `prepare-n-minus-one-release.sh`: a temp ROOT with the copied script, `package.json`, fixture, and a git repo with tags and a
     payload commit. Cover all §5.2 rows and assert exit code + message.

Wave 5 (`release: prepare v0.1.0`):

7. `tools/install-bootstrap.node-test.mjs`:
   - `Codex bootstrap replaces an installed retired 1.1.5 plugin with the current release` (`initiallyInstalled`, `reportedVersion: '1.1.5'`).
     Assert: success; marketplace add `--ref v0.1.0`; setup args `['setup','--codex','--yes']`.
   - `… takes over a completed retired v1.1.5 plugin-installed WAL` (`preparePriorStableBridgeFixture(fixture, { targetVersion: '1.1.5' })`).
     Assert: success; journal removed.
8. Existing gates turn the bump into assertions: `check:identity` (all positions 0.1.0), `check:docs` (install URLs), `check:npx-package`,
   `test:clean-install`, and `test-bundle.sh` (prints `[HONEST SKIP]` and still passes the frozen reader).
9. Acceptance commands (prd acceptance 5), expected empty:
   `git grep -nE '"version": "1\.[01]\.[0-9]+"|v1\.[01]\.[0-9]+/install\.sh|RELEASE_(VERSION|TAG) ?=.{0,3}v?1\.[01]\.' -- ':!docs/usage/release-notes.md' ':!docs/usage/zh-CN/release-notes.md' ':!docs/superpowers' ':!docs/adr' ':!openspec/changes/archive' ':!.trellis/tasks' ':!package-lock.json'`
   and `node -e` over `package-lock.json` root and workspace entries all equal to `0.1.0`.

Real (wave 5, not automatable here): §6.1 steps 4, 5 and 8. Prd acceptance 4 (0.1.0 → 0.1.1 update; v0.1.0 installer over 0.1.1) is verified at the
v0.1.1 release, before this task is archived.

## 9. Decisions made during design

- D1 **1.x machines migrate with the official v0.1.0 install command, once per host.** `tenon update`, auto-update and doctor on 1.x run immutable
  1.x code (§1.5) that rejects 0.1.0 with zero mutation. This satisfies prd acceptance 3 through "官方安装". R3's "更新不拒绝" is guaranteed for 0.x
  code (a partially migrated machine, or the packaged 0.1.0 CLI). Same pattern as the v1.0.1 → v1.0.2 bridge.
- D2 One order: retired set = exactly the 16 published numbers (regex in §3.1) ranked below everything else. Rename `compareStableVersions` →
  `compareReleaseOrder`. `install.sh` mirrors it; a test pins the regex literal across TS, shell and workflow.
- D3 Retired numbers are never published again: the candidate rejects them. Tenon's first real major after 0.x is ≥ 1.2.0 (or 2.0.0).
- D4 A versioned `install.sh` is an explicit choice and still installs its own version over a newer one (today's behavior). Only implicit
  `tenon update` refuses downgrade. This is the "按降级规则处理" in prd acceptance 4.
- D5 Wave 1 lands the order, notice, gate mechanism and workflow checks with the fixture still pinned to v1.0.1 and versions still 1.1.5. The bump
  (`release: prepare v0.1.0`) is the first step of wave 5, like every prior release-prep commit (`a0a7f0a4`). This keeps the public README install
  command valid and avoids churn in manifests, lock and dist while other children merge. See CR1.
- D6 N-1 skip = fixture `status: none` tied to `release: v0.1.0` and exit 78. Pinned baselines must be the latest non-retired stable tag below the
  current version once the current version is non-retired.
- D7 `release.yml` creates Releases with `--latest`; public acceptance depends on it (§1.3).
- D8 The kernel `.pipeline-version` guard (`ownership-version.ts:30-97`) is not changed. No current code writes that file (only reads:
  `sync.ts:71-83`, `update-project-report.ts:34-43` equality, uninstall delete). A project still carrying a 1.x value keeps the existing
  `--allow-downgrade` path.
- D9 Historical release-note entries stay verbatim, including their now-dead 1.x install commands. The v0.1.0 entry says the 1.x releases were
  removed and gives the migration command.
- D10 Deletion is preceded by a local bundle and asset backup (§6.3); no 1.x ref is kept on GitHub.
- D11 `update-native` prints one notice per replaced retired version, so migration is never silent (R3).
- D12 v0.1.0 does not prove it reads Changes created by 1.x (the N-1 skip is the prd decision). The v0.1.0 release notes say so. The main session
  confirms the wording against data-driven-runner's actual outcome at wave 5.

## 10. Contract change requests (parent files not edited)

- CR1 `implement.md` wave table: `version-reset` in wave 1 = order + notice + N-1 mechanism + workflow checks + specs/DIST-RELEASE text. The
  version-number bump, user docs, release notes and fixture `none` move to wave 5 step 1 (`release: prepare v0.1.0`). Children must not change
  version fields.
- CR2 `design.md` §8 Release: add
  - (a) 1.x machines migrate via the v0.1.0 one-liner, and `tenon update` from 1.x is not a migration path;
  - (b) Releases are created as Latest;
  - (c) retired numbers v1.0.0–v1.1.5 are never reused;
  - (d) backup, then deletion, then re-run public acceptance and `main` CI without 1.x tags.
- CR3 `implement.md` "Final acceptance": the v0.1.0 entry in `docs/usage/release-notes.md` (+ zh-CN) is written once by the main session from
  all children's changes. Children do not add release-note entries.
