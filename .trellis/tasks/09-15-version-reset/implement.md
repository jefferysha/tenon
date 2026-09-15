# Implementation plan: version reset to 0.1.x

Design: `design.md` (sections referenced as §). Branch `feat/version-reset` in its own worktree for wave 1. Wave 5 runs on `main` in the main session.
No commit changes a version field before W5-1 (CR1).

## Wave 1 — code (small verifiable commits)

### W1-1 `feat(cli): rank the retired 1.x release line below 0.x`

- [ ] `packages/cli/src/commands/stable-release.ts`:
  - add `RETIRED_RELEASE_VERSION` and `isRetiredReleaseVersion`;
  - rename `compareStableVersions` → `compareReleaseOrder` with rank-then-numeric order (§3.1). Keep `parseVersion` errors.
- [ ] Switch call sites: `update-native.ts:19,104,197`, `host-plugin-convergence.ts:17,65,114`, `host-convergence-recovery.ts:18,106`.
- [ ] `update-native.ts:190-202`: when `isRetiredReleaseVersion(version) && !isRetiredReleaseVersion(target.version)`, print
  `[update] ${label} ${version} 属于已退役的 1.x 版本线；迁移到 ${target.version}`.
- [ ] Tests (§8 items 1–4): `stable-release.test.ts` (replace `:89-93`), `update.test.ts` (a, b, c), `setup.test.ts` (next to `:1281`),
  plus the `hostConvergenceHasNewerStableCandidate` order-gate test.
- Validate:
  ```bash
  npx tsc -b packages/kernel packages/cli
  npx vitest run packages/cli/src/commands/stable-release.test.ts packages/cli/src/commands/update.test.ts packages/cli/src/commands/setup.test.ts
  git grep -n 'compareStableVersions' -- packages ':!**/dist/**'   # expect empty
  ```

### W1-2 `fix(install): adopt installer journals by the same release order`

- [ ] `install.sh:739-753` `stable_version_is_less`: add the retired rank. The regex literal is byte-identical to `stable-release.ts`.
- [ ] `tools/install-bootstrap.node-test.mjs`: shell comparator test over the §3.2 table (§8 item 5).
- Validate:
  ```bash
  node --test tools/install-bootstrap.node-test.mjs
  bash -n install.sh
  ```

### W1-3 `ci(release): N-1 fixture schema 3 with a one-time documented skip`

- [ ] `tools/fixtures/n-minus-one-release.json`: `schemaVersion: 3`, `status: "pinned"`, same v1.0.1 data. It stays pinned until W5-1.
- [ ] `tools/prepare-n-minus-one-release.sh`: §5.2 rules. `none` → exit 78. Pinned + non-retired current → not retired and latest tag check.
- [ ] `tools/test-bundle.sh` N-1 block (`:186-266`): §5.3. Label default from the fixture tag, not `v1.0.1` (`:240`). Skip line `[HONEST SKIP]`.
- [ ] `.github/workflows/ci.yml:186-195`, `.github/workflows/release-candidate.yml:129-133`: accept exit 78; label from the fixture; remove `v1.0.1`.
- [ ] `tools/check-release-workflows.node-test.mjs`: the N-1 step assertions and the executable prepare-script fixtures (§8 item 6).
- Validate:
  ```bash
  npm run check:release-workflows
  out="$(mktemp -d)/n1"; bash tools/prepare-n-minus-one-release.sh "$out"   # pinned v1.0.1 still ready (needs local tag v1.0.1)
  npm run build && bash tools/test-bundle.sh
  ```

### W1-4 `ci(release): mark new Releases Latest and reject retired version numbers`

- [ ] `.github/workflows/release.yml:204-208`: add `--latest` to `gh release create`.
- [ ] `.github/workflows/release-candidate.yml` identity step, after `:52-55`:
  `[[ "${RELEASE_TAG#v}" =~ ^1\.(0\.[0-9]|1\.[0-5])$ ]] && { echo "tag $RELEASE_TAG uses a retired 1.x version number" >&2; exit 1; }`.
- [ ] `tools/check-release-workflows.node-test.mjs`: `--latest` present; retired guard present; regex literal identical in three files.
- Validate: `npm run check:release-workflows`.

### W1-5 `docs(spec): record release order and N-1 skip contracts`

- [ ] `.trellis/spec/cli/frontend/host-install-and-inventory.md`: new scenario "Retired 1.x release line ranks below 0.x" in the 7-section format
  (signatures §3.1, contracts §3.3, error matrix §7, tests §8, wrong `compareStableVersions` vs correct `compareReleaseOrder`).
  Add a row to `.trellis/spec/cli/frontend/index.md`.
- [ ] `docs/DIST-RELEASE.md:146-150`: fixture `status` `none`/`pinned`, exit 78, latest-tag rule, `--latest`.
- [ ] `openspec/specs/plugin-distribution/spec.md:863-874`: keep the SHALL; add the requirement text and a scenario "v0.1.0 has no earlier 0.x release"
  (explicit, reported skip only when the fixture names the candidate version; every later candidate SHALL pin the latest non-retired stable release).
- Validate:
  ```bash
  npm run check:openspec
  npm run check:docs
  ```

### Wave 1 exit gate (main session after merge; parent shared gates)

```bash
npm run build
npm run check:architecture && npm run check:comments && npm run check:identity
npm test && npm run test:web && bash tools/test-hooks.sh && bash tools/verify-skills.sh
npm run check:release-workflows && npm run check:npx-package && bash tools/test-bundle.sh
```

## Wave 5 — release (main session, after waves 2–4 are merged and green)

### W5-1 `release: prepare v0.1.0` (one commit)

- [ ] Versions:
  ```bash
  npm pkg set version=0.1.0                                            # root package.json
  npm pkg set version=0.1.0 --workspaces                               # docs-site + 8 packages
  npm install --package-lock-only --ignore-scripts                     # lock: 11 version lines
  ```
  Then edit by hand:
  - `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` `metadata.version`;
  - `install.sh:10`, `packages/cli/src/commands/plugin-host.ts:36`;
  - `packages/server/src/hostTargetPlanProtocol.ts:38`, `packages/dashboard-app/src/api/hostTargetPlanDecoders.ts:213` (`v0.1.0`).
- [ ] Links: every `v1.1.5` in `README.md`, `README.en.md`, `docs/usage/{installation,quickstart}.md`, `docs/usage/zh-CN/{installation,quickstart}.md`,
  `packages/npm-bootstrap/README.md` → `v0.1.0`.
- [ ] Migration text: replace the v1.0.1 bridge paragraph in `docs/usage/installation.md:45-51`, `docs/usage/zh-CN/installation.md:55-58`,
  `docs/usage/updates-recovery-and-uninstall.md:16-20`, `docs/usage/zh-CN/updates-recovery-and-uninstall.md:21-23`:
  "a 1.x installation runs the v0.1.0 one-liner once per host; `tenon update` on 1.x reports a downgrade and changes nothing; afterwards use
  `tenon update --<host>`."
- [ ] `openspec/specs/open-source-documentation-experience/spec.md:805-816`: migration boundary requirement → 1.x → v0.1.0 (SHALL wording kept).
- [ ] Release notes `docs/usage/release-notes.md` + `docs/usage/zh-CN/release-notes.md`: the v0.1.0 entry (CR3). Sections:
  - version reset (numbering restarts at 0.1.0; 1.x Releases and tags removed; retired numbers never reused);
  - upgrade from 1.x (one-liner per host);
  - N-1 compatibility gate skipped for this release, with v0.1.1 using v0.1.0 as baseline;
  - Changes created by 1.x are not verified (D12);
  - the children's changes.
  Historical entries untouched.
- [ ] `tools/fixtures/n-minus-one-release.json` → `status: "none"`, `release: "v0.1.0"`, reason.
- [ ] `tools/install-bootstrap.node-test.mjs`: the two migration tests (§8 item 7).
- [ ] `npm run build` (regenerates `packages/cli/dist/tenon.mjs`, `packages/server/dist/dashboard.mjs`, dashboard dist).
- Validate:
  ```bash
  npm run check:identity && npm run check:docs && npm run check:openspec && npm run check:release-workflows
  npm run check:npx-package && npm run test:clean-install
  npm test && npm run test:web && bash tools/test-hooks.sh && bash tools/verify-skills.sh
  bash tools/test-bundle.sh | grep -F '[HONEST SKIP] bundle: 真实 N-1 兼容'
  npm run docs:sync && npm run docs:check && npm run docs:build
  # design §8 item 9 grep: expect empty
  ```

### W5-2 Publish v0.1.0 (ops, no commit)

```bash
REPO=jefferysha/tenon
git push origin main
SHA="$(git rev-parse origin/main)"
CI_ID="$(gh run list --repo "$REPO" --workflow ci.yml --branch main --event push --commit "$SHA" --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$CI_ID" --repo "$REPO" --exit-status
gh workflow run release-candidate.yml --repo "$REPO" --ref main -f ref="$SHA" -f tag=v0.1.0
CAND_ID="$(gh run list --repo "$REPO" --workflow release-candidate.yml --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$CAND_ID" --repo "$REPO" --exit-status
WRITER_ID="$(gh run list --repo "$REPO" --workflow release-writer.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$WRITER_ID" --repo "$REPO" --exit-status
gh run list --repo "$REPO" --workflow release-public-acceptance.yml --limit 3 --json databaseId,event,status,conclusion
gh run watch "<acceptance run id>" --repo "$REPO" --exit-status
```

Verify (all must hold):

```bash
gh release view v0.1.0 --repo "$REPO" --json tagName,isDraft,isPrerelease,targetCommitish,assets \
  --jq '{tagName,isDraft,isPrerelease,targetCommitish,assets:[.assets[].name]}'     # false,false,main, legacy-bridge + SHA256SUMS
gh api "repos/$REPO/releases/latest" --jq .tag_name                                   # v0.1.0
git ls-remote --tags origin 'refs/tags/v0.1.0^{}'                                    # "$SHA refs/tags/v0.1.0^{}"
```

If Latest is not `v0.1.0`, run `gh release edit v0.1.0 --repo "$REPO" --latest`, then
`gh workflow run release-public-acceptance.yml --repo "$REPO" --ref main -f tag=v0.1.0`.

### W5-3 Real host migration acceptance (ops)

- [ ] On a machine with v1.1.5 for both hosts:
  - record `codex plugin list --json`, `claude plugin list --json`, `tenon doctor`;
  - record `tenon update --codex` (expected: `拒绝从宿主 plugin 1.1.5 降级到 0.1.0`, no change).
- [ ] Run `/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.0/install.sh | /bin/bash -s -- --codex`, then the same with `--claude`.
- [ ] Expect:
  - `tenon doctor` green;
  - both inventories report `0.1.0`, and `tenon runtime status` shows active 0.1.0;
  - Dashboard `/api/health` serverVersion `0.1.0`;
  - `tenon update --codex` prints `已在宿主、managed runtime 与 Dashboard 精确生效；无需更新`;
  - a new host session loads Tenon skills and hooks.
- [ ] Fresh machine (or isolated HOME): the same one-liners succeed.
- [ ] Parent cross-child acceptance passes on v0.1.0.
- [ ] Deletion precondition: every acceptance machine shows a green `tenon doctor` and no pending managed journal in `tenon runtime status`.

### W5-4 Backup, then delete 1.x (ops, IRREVERSIBLE)

```bash
REPO=jefferysha/tenon
ARCHIVE="$HOME/tenon-1x-archive-$(date +%Y%m%d)"; mkdir -p "$ARCHIVE"
gh release list --repo "$REPO" --limit 100 --json tagName,name,isLatest,publishedAt > "$ARCHIVE/releases.json"
git ls-remote --tags origin 'refs/tags/v1.*' > "$ARCHIVE/remote-tags.txt"
git fetch origin 'refs/tags/v1.*:refs/tags/v1.*'
git bundle create "$ARCHIVE/tenon-1x-tags.bundle" $(git tag -l 'v1.*')
git bundle verify "$ARCHIVE/tenon-1x-tags.bundle"
jq -r '.[].tagName | select(test("^v1\\.[01]\\.[0-9]+$"))' "$ARCHIVE/releases.json" | while IFS= read -r t; do
  mkdir -p "$ARCHIVE/$t"
  gh release view "$t" --repo "$REPO" --json body --jq .body > "$ARCHIVE/$t/notes.md"
  gh release download "$t" --repo "$REPO" --dir "$ARCHIVE/$t" || echo "no assets: $t" >> "$ARCHIVE/no-assets.txt"
done
```

Stop here unless the bundle verifies and every release directory exists. Then:

```bash
jq -r '.[].tagName | select(test("^v1\\.[01]\\.[0-9]+$"))' "$ARCHIVE/releases.json" | while IFS= read -r t; do
  gh release delete "$t" --repo "$REPO" --cleanup-tag --yes
done
git ls-remote --tags origin 'refs/tags/v1.*' | awk '$2 !~ /\^\{\}$/ {print $2}' | while IFS= read -r ref; do
  git push origin --delete "$ref"
done
git tag -l 'v1.*' | while IFS= read -r t; do git tag -d "$t"; done
```

### W5-5 Verify deletion (prd acceptance 1–2)

```bash
gh release list --repo "$REPO" --limit 100 --json tagName,isLatest --jq '.[] | [.tagName,.isLatest] | @tsv'   # only: v0.1.0 true
gh api "repos/$REPO/releases/latest" --jq .tag_name                                                           # v0.1.0
test -z "$(git ls-remote --tags origin 'refs/tags/v1.*')" && echo remote-clean
test -z "$(git tag -l 'v1.*')" && echo local-clean
curl -s -o /dev/null -w '%{http_code}\n' "https://api.github.com/repos/$REPO/releases/tags/v1.1.5"            # 404
curl -s -o /dev/null -w '%{http_code}\n' "https://raw.githubusercontent.com/$REPO/v1.1.5/install.sh"          # 404 (CDN may lag minutes)
gh workflow run release-public-acceptance.yml --repo "$REPO" --ref main -f tag=v0.1.0                         # must stay green
gh run rerun "$(gh run list --repo "$REPO" --workflow ci.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId')" --repo "$REPO"
```

### W5-6 Close-out at v0.1.1 (required for prd acceptance 4 before archiving this task)

- [ ] v0.1.1 prep commit pins the fixture to v0.1.0:
  - `gitCommit` = `git rev-parse 'v0.1.0^{commit}'`;
  - `cliSha256` = `git archive v0.1.0 -- packages/cli/dist/tenon.mjs | tar -xO | shasum -a 256`;
  - `status: "pinned"`, `tag`, `pluginVersion`; then `bash tools/prepare-n-minus-one-release.sh "$(mktemp -d)/n1"` exits 0.
- [ ] After v0.1.1 is published:
  - `tenon update --codex` on 0.1.0 → 0.1.1;
  - `v0.1.0/install.sh` over 0.1.1 installs 0.1.0 (explicit, D4);
  - then `tenon update --codex` returns to 0.1.1.

## Risky files and rollback points

| Item | Risk | Rollback |
| --- | --- | --- |
| `install.sh:739-753` | wrong order refuses or adopts journals incorrectly | `git revert` W1-2; shell test covers the table |
| `update-native.ts`, `host-plugin-convergence.ts`, `host-convergence-recovery.ts` | downgrade protection regression | `git revert` W1-1; `update.test.ts:655-709` must stay green |
| `prepare-n-minus-one-release.sh`, `test-bundle.sh`, `ci.yml`, `release-candidate.yml` | CI red or a skip that passes silently | `git revert` W1-3; the skip requires the fixture to name the candidate version |
| `release.yml --latest` | wrong Latest after re-running an older release | only on create; manual `gh release edit <tag> --latest` |
| W5-1 bump | README links point to a release that does not exist yet | keep push → release window short; `git revert` before W5-2 tag creation |
| W5-2 v0.1.0 published | broken release | before W5-4: `gh release delete v0.1.0 --cleanup-tag --yes`, `gh release edit v1.1.5 --latest`, fix forward |
| **W5-4 deletion** | **irreversible**: Release objects, IDs, dates, notes, assets; tag commits `v1.0.0`–`v1.0.6` are not on `main` | none on GitHub; partial restore only: `git push origin <tag>` from `$ARCHIVE/tenon-1x-tags.bundle`, re-create releases from `$ARCHIVE` (new IDs and dates) |

## Overlap files and merge notes

| File | Other children | Merge note |
| --- | --- | --- |
| `packages/cli/src/commands/update-native.ts` | upstream-skills (skill fetch during update), review-agents / instruction-templates (builtin writes on update) | this child changes only the compare import, `:104`, `:190-202`; keep their new steps, re-run `update.test.ts` |
| `install.sh` | upstream-skills, instruction-templates (install-time writes) | this child: `stable_version_is_less` (W1) and `:10` (W5) only |
| `tools/install-bootstrap.node-test.mjs` | upstream-skills | append-only tests |
| `tools/test-bundle.sh` | data-driven-runner (skills/workflow smoke) | this child: N-1 block `:186-266` only |
| `.github/workflows/release-candidate.yml`, `ci.yml` | upstream-skills (payload skills lock) | this child: identity step guard + N-1 step only |
| `.trellis/spec/cli/frontend/host-install-and-inventory.md`, `index.md` | upstream-skills | separate scenario section |
| `openspec/specs/plugin-distribution/spec.md` | upstream-skills (skill provenance requirements) | different requirement block |
| `docs/usage/installation.md`, `updates-recovery-and-uninstall.md` (+ zh-CN) | upstream-skills, instruction-templates | W5-1 paragraph replacement only |
| `docs/usage/release-notes.md` (+ zh-CN) | all | written once in W5-1 (CR3) |
| All `package.json`, `package-lock.json` | any child adding dependencies | version fields only in W5-1; regenerate lock after rebase with `npm install --package-lock-only --ignore-scripts` |
| `packages/cli/dist/tenon.mjs`, `packages/server/dist/dashboard.mjs`, dashboard dist | all | generated; never merged by hand, main session runs `npm run build` |

## Size

- Wave 1: ~150 LOC product (TS + shell + workflows), ~400 LOC tests, ~60 lines spec/docs.
- W5-1: 29 mechanical version positions, ~120 lines docs, 2 tests.
- Ops: W5-2..W5-5 are half a day including real-host acceptance.
- Overall: medium.

## Deviations

Wave 1 (`feat/version-reset`):

- Retired regex literal is `^1\.(0\.[0-9]|1\.[0-5])$` with a capturing group everywhere, not `(?:…)` in TypeScript and
  `install.sh` (design §3.1). Bash ERE has no `(?:`, so only the capturing form can be byte-identical across
  `stable-release.ts`, `install.sh`, `release-candidate.yml` and `tools/prepare-n-minus-one-release.sh`. `install.sh`
  uses it without the `u` flag. The prepare script is a fourth holder, covered by the same identity test.
- The candidate retired-tag guard is `if [[ … ]]; then … exit 1; fi` instead of `[[ … ]] && { … }`: same behavior, and it
  cannot turn a false match into the step's exit status.
- `prepare-n-minus-one-release.sh` also reports `N-1 fixture 结构非法` when a pinned fixture's `pluginVersion` is not stable
  SemVer or `tag` is not `v<pluginVersion>`, so the latest-tag comparison never parses garbage. The skip line goes to
  stdout; failures go to stderr.
- `update.test.ts` helpers gained explicit version parameters (`updateEnv(…, target)`, `requireVersionedHostRebind(…, target)`,
  `fakeDashboardStarter(…, startedServerVersion)`), because the existing harness hard-codes 1.2.3; defaults keep every
  existing test unchanged. The `hostConvergenceHasNewerStableCandidate` order-gate test lives in `setup.test.ts` next to the
  receipt tests (§8 item 4 names no file).
