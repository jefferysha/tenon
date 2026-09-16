# Implementation plan: upstream skills

- **Branch and worktree:** `feat/upstream-skills` (parent `implement.md`, wave 1).
- **Source of truth:** `design.md` in this directory. Section numbers below refer to it.
- **Generated files:** keep `packages/*/dist` out of the branch; the main session rebuilds after merge.
  - `templates/skill-sources.yaml` is regenerated once, in commit 11, so the branch passes `verify-skills`. On merge
    conflicts, run `npm run sync:skill-provenance` again rather than resolving by hand.

## 0. Before the first commit

- [ ] Read every file listed in `implement.jsonl`.
- [ ] Run `npm run build:packages && npm run bundle` locally. The bundled CLI is needed by `tools/verify-skills.sh` and is
      not committed.
- [ ] Record a baseline:
  - [ ] `bash tools/verify-skills.sh --quiet --root "$PWD"`
  - [ ] `npx vitest run packages/automation/src/skills packages/cli/src/commands/update.test.ts packages/cli/src/commands/setup.test.ts packages/cli/src/commands/doctor.test.ts`
  - [ ] Hook dispatch latency, needed for step 14:
    `for i in $(seq 20); do /usr/bin/time -p bash ~/.local/bin/tenon-hook session-start </dev/null; done` on an installed
    runtime. If no runtime is installed, use an isolated `TENON_RUNTIME_HOME` (see step 14).

## 1. `feat(kernel): parse upstream skill sources, lock and run report`

- **Create:**
  - `packages/kernel/src/skills/flow-yaml.ts`, extracting `stripComment`, `unquote` and `parseFlowBody` from
    `source-registry.ts:86-136`.
  - `packages/kernel/src/skills/upstream-sources.ts`
  - `packages/kernel/src/skills/upstream-sources.test.ts`, using a fixture copy of the §3.1 file.
- **Modify:**
  - `packages/kernel/src/skills/source-registry.ts`: import the helpers, and append `invalid-skill-sources` and
    `invalid-skill-lock` to `SKILL_PROVENANCE_ERROR_CATEGORIES` (`:49-59`).
  - `packages/kernel/src/skills/index.ts`: add exports.
- **Validate:**
  - `npx vitest run packages/kernel/src/skills`
  - `npm run build:packages`
  - `npm run check:architecture`. Kernel stays fs-free, and every file stays under 500 lines.

## 2. `refactor(cli): share remote git retry`

- **Create:** `packages/cli/src/commands/remote-git.ts`, `packages/cli/src/commands/remote-git.test.ts`.
- **Modify:** `packages/cli/src/commands/stable-release.ts`. Replace `:93-114` with an import; stable-proof budgets and
  behavior stay the same.
- **Validate:**
  - `npx vitest run packages/cli/src/commands/stable-release.test.ts packages/cli/src/commands/remote-git.test.ts`
  - The command sequence and timeouts asserted in `.trellis/spec/cli/frontend/host-install-and-inventory.md` §6 are
    unchanged.

## 3. `feat(cli): install upstream skills into a plugin root`

- **Create:**
  - `packages/cli/src/upstream-skills/fetch.ts`, `license.ts`, `install.ts`, `report.ts`
  - Tests: `license.test.ts`, `install.test.ts`, and `test-support.ts` (builds local bare repositories and sets the
    `GIT_CONFIG_COUNT` insteadOf env for the injected `runCommand`)
- **Not yet called** from any host flow.
- **Validate:**
  - `npx vitest run packages/cli/src/upstream-skills`
  - Every §14 install assertion (1)–(13) is present.
  - `grep -R "github.com" packages/cli/src/upstream-skills/*.test.ts` finds only insteadOf keys, never a real fetch.

## 4. `feat(automation,cli): verify and locate locked upstream skills`

- **Modify:**
  - `packages/automation/src/skills/skill-provenance.ts` (§6.4)
  - `packages/cli/src/skill-provenance-locator.ts` (§6.4)
  - `packages/cli/src/commands/internal-skill-provenance.ts`: `syncRegistry` excludes lock and source ids
- **Tests:**
  - `packages/automation/src/skills/skill-provenance.test.ts`: fixtures only here; the real-repository block changes in
    commit 11.
  - `packages/cli/src/skill-provenance-locator.test.ts`
  - `packages/cli/src/commands/internal-skill-provenance.test.ts`
- **Validate:**
  - `npx vitest run packages/automation/src/skills packages/cli/src/skill-provenance-locator.test.ts packages/cli/src/commands/internal-skill-provenance.test.ts`
  - `npm run bundle && bash tools/verify-skills.sh --quiet --root "$PWD"`. The repository has no `sources.yaml` yet, so
    this must still pass.

## 5. `feat(cli): fetch upstream skills into a development checkout`

- **Create:**
  - `packages/cli/src/commands/internal-skill-upstream.ts`
  - `packages/cli/src/commands/internal-skill-upstream.test.ts`
- **Modify:**
  - `packages/cli/src/program.ts`: hidden `internal-skill-upstream <mode>` with `--root` and `--json`, placed next to
    `:356-363`.
  - `package.json`: add the `skills:fetch` script.
  - `.gitignore`: add the §6.3 block.
- **Validate:**
  - `npx vitest run packages/cli/src/commands/internal-skill-upstream.test.ts`
  - `git check-ignore -v skills/brainstorming/SKILL.md` prints the new rule.
  - `git check-ignore skills/tenon/SKILL.md` exits 1.

## 6. `feat(cli): run upstream skill install in setup and update` (risky)

- **Create:** `packages/cli/src/commands/upstream-skill-step.ts` (`runUpstreamSkillInstall`).
- **Modify:**
  - `packages/cli/src/commands/setupHost.ts:171-186` (§6.1)
  - `packages/cli/src/commands/update-native.ts`: host-exact branch around `:213-251`, mutation branch around
    `:305-309` (§6.2)
  - `packages/cli/src/commands/managed-host-observation.ts:93-110`: `payloadComparisonEntries` (§6.3)
  - `install.sh:1026-1037`: tracked `skills/` children
- **Tests:**
  - `packages/cli/src/commands/update.test.ts` (§14 update rows 1–4)
  - `packages/cli/src/commands/setup.test.ts`: call order, and always re-verifying assets
- **Validate:**
  - `npx vitest run packages/cli/src/commands/update.test.ts packages/cli/src/commands/setup.test.ts packages/cli/src/commands/stable-release.test.ts`
  - `bash -n install.sh`
  - `node --test tools/install-bootstrap.node-test.mjs`
- **Rollback point A.** Revert this commit alone to restore today's host flows. The code from commits 1–5 is inert
  without it.

## 7. `refactor(cli)!: remove the setup skills installer`

- **Delete:**
  - `packages/cli/src/commands/setupSkillsPlan.ts`
  - The planner and executor in `packages/cli/src/commands/setupSkills.ts`. Delete the whole file if
    `git grep -n "setupSkills.js"` shows no other import after the edit.
- **Modify:** `packages/cli/src/commands/setup.ts`:
  - Remove `cmdSetupSkills` at `:69`; `finishSetup` goes straight to the runtime section.
  - Remove the `skills` case at `:145-146` and the related exports at `:163-164`.
  - The error text lists `runtime` only.
- **Tests:** in `packages/cli/src/commands/setup.test.ts`, delete the planner tests (`~2990-3140`) and add the
  `未知 setup 子命令` assertion.
- **Validate:**
  - `npx vitest run packages/cli/src/commands/setup.test.ts`
  - `npm run build:packages`
  - `git grep -n "buildSkillsPlan\|cmdSetupSkills\|setup skills"`: only docs changed in commit 13 may still match.

## 8. `feat(cli): report upstream skills in doctor`

- **Create:** `packages/cli/src/commands/doctor-upstream-skills.ts`.
- **Modify:**
  - `packages/cli/src/commands/doctor.ts`: tail check after `:328-339`; `--skills` output
  - `packages/cli/src/commands/doctor-skills.ts:78-129`: lock ids count as bundled
  - `packages/cli/src/deps.ts`: `upstreamSkillView` probe
  - `packages/cli/src/commands/doctor-probes.ts`: production probe
  - `packages/cli/src/program.ts:196-200`: `--skills`
- **Tests:** `packages/cli/src/commands/doctor.test.ts` (§7.1 matrix, `--json --skills`, mandatory merge).
- **Validate:**
  - `npx vitest run packages/cli/src/commands/doctor.test.ts`
  - The doctor check-id order is unchanged except for the appended row.

## 9. `feat(server): serve skill sources view`

- **Create:**
  - `packages/server/src/skillSourcesView.ts`
  - `packages/server/src/skillSourcesView.test.ts`
- **Modify:**
  - `packages/server/src/serverGetRoutes.ts`: route next to `:253`
  - `packages/server/src/skillsRegistry.ts`: delete `:14` and `:212-229`, simplify `source`
  - `packages/server/src/skillsRegistry.test.ts`
  - `packages/server/src/server.test.ts`: route case
- **Validate:**
  - `npx vitest run packages/server/src/skillSourcesView.test.ts packages/server/src/skillsRegistry.test.ts packages/server/src/server.test.ts`

## 10. `feat(dashboard): skills view`

- **Create:**
  - `packages/dashboard-app/src/api/skillSourcesClient.ts` and `.test.ts`
  - `packages/dashboard-app/src/skills/SkillsView.tsx` and `.test.tsx`
- **Modify:**
  - `packages/dashboard-app/src/shell/views.ts`
  - `packages/dashboard-app/src/App.tsx`
  - `packages/dashboard-app/src/i18n/translations.ts`: zh `nav` at `:32` plus a `skills` block; en `nav` at `:1993`
    plus a `skills` block
- **Validate:**
  - `npm run typecheck:web`
  - `npx vitest run --config packages/dashboard-app/vitest.config.ts packages/dashboard-app/src/skills packages/dashboard-app/src/api/skillSourcesClient.test.ts packages/dashboard-app/src/i18n`
  - `npm run check:design-scale`
- **Browser check.** Run `npm run build:web`, serve the dashboard from the dev server with a fixture lock, and open
  `?view=skills` at 1280 px and 900 px widths. Confirm that no cell wraps and that there are no sentences.

## 11. `feat(skills)!: install third-party skills from upstream` (risky, content switch)

- **Create:** `skills/sources.yaml`, exactly as in §3.1.
- **Delete:** the 51 directories listed in §10 and `skills/EXTERNAL-SKILLS.md`.
  - Use `git rm -r` for each listed directory. `git status` must then show only `skills/tenon*`, `skills/simple-task`,
    `skills/learn-record` and `skills/sources.yaml` remaining under `skills/`.
- **Modify:**
  - `templates/manifest.yaml:64`: drop `code-review`
  - `skills/tenon-explore/SKILL.md:146,170,299` and `skills/tenon-build/SKILL.md:184-185,193,220-222,404-405`: removals
    and renames from §10
  - `tools/verify-skills.sh`: delete §4 (`:283-308`) and header lines 8-9
  - `tools/test-hooks.sh:1823,1832`: use `skills/tenon`; remove the sandbox `external-skill` expectations in `660-709`
  - `packages/cli/src/skillSources.test.ts:131-189`: move third-party id assertions to the kernel `sources.yaml` test
  - `packages/automation/src/skills/skill-provenance.test.ts:115-136`: new real-repository counts and the no-rewrite
    assertion
  - `templates/skill-sources.yaml`: regenerate with `npm run sync:skill-provenance`, which leaves 11 entries
- **Validate:**
  - `npm run build:packages && npm run bundle`
  - `bash tools/verify-skills.sh --quiet --root "$PWD"`
  - `npx vitest run packages/kernel/src/skills packages/automation/src/skills packages/cli/src/skillSources.test.ts`
  - `bash tools/test-hooks.sh`
  - `npm run check:default-skill-matrix`
  - `git grep -nE "zoom-out|uiuxdesign-pro|tailwind-css-patterns|(^|[^-])react-best-practices|shadcn-ui" -- templates skills packages/*/src tools hooks ':!*.test.ts'`
    must match nothing. Test fixtures described in design §10 are allowed.
  - `npm run skills:fetch`. This is the only live-network step, and it is manual, not CI. Then:
    - `bash tools/verify-skills.sh --quiet --root "$PWD"` passes with the lock present.
    - `node packages/cli/dist/tenon.mjs doctor --skills` shows 45 upstream rows plus 11 Tenon rows.
    - `git status --porcelain` is clean apart from tracked edits, because the fetched directories are ignored.
- **Rollback point B.** Revert this commit to restore the bundled rewrites. Commits 1–10 then run as no-ops because
  there is no `sources.yaml`.

## 12. `test(release): upstream skills in clean install acceptance`

- **Modify:**
  - `tools/clean-codex-install-acceptance.mjs`:
    - `LOCAL_RELEASE_ENTRIES` copies `skills` from `git ls-files skills` (`:533-570`).
    - Build a bare fixture repository for one source.
    - Rewrite the fixture's `skills/sources.yaml` to that single entry.
    - Set `url.file://<fixture>.insteadOf` in the isolated `HOME` gitconfig, next to `:577`.
    - Assert that the host root contains `skills/<id>` and `skills/skills.lock.json`, and that Codex discovers
      `tenon:<id>`, next to `:136-140`.
  - `tools/clean-codex-install-acceptance.node-test.mjs`: pure helper assertions.
- **Validate:**
  - `npm run check:npx-package`
  - `npm run test:clean-install`, which needs the Codex CLI. If it is not available locally, the result comes from the
    CI `test:clean-install` step in `ci.yml:107-108`.

## 13. `docs: upstream skill sources`

- **Modify:**
  - `README.md:290-305`
  - `CONTRIBUTING.md:140-158`
  - `docs/CONTRACT.md:445-470`
  - `docs/DIST-RELEASE.md:30-55`
- **Update the spec** `.trellis/spec/cli/frontend/host-install-and-inventory.md`. Add the scenario "Upstream skills in
  the host plugin root", in the 7-section format, covering signatures, the payload comparison entries, the error matrix
  and the tests. Add it to the index row in `.trellis/spec/cli/frontend/index.md`.
- **Validate:** `npm run check:docs && npm run check:comments && npm run check:identity`.

## 14. Verification before handing to the main session (no commit)

- [ ] **Shared gates** (parent `implement.md`):
  - `npm run build`
  - `npm run check:architecture && npm run check:comments && npm run check:identity`
  - `npm test && npm run test:web && bash tools/test-hooks.sh && bash tools/verify-skills.sh`
- [ ] **Clean local build state.** `npm run check:dashboard-dist-freshness` and `git diff --exit-code -- packages/*/dist`
      are run locally only; dist is not committed.
- [ ] **Real isolated install (Codex)**, with live GitHub access:
  1. Set up an isolated `HOME` and `TENON_RUNTIME_HOME`.
  2. Create a local release tag from the branch using the clean-install local mode, but keep the real
     `skills/sources.yaml` (no fixture rewrite).
  3. Run `tenon setup --codex -y`.
  4. Record the total fetch time and each repository's time from the `[skills]` log.
  5. Check that `~/.codex/plugins/cache/tenon/tenon/<v>/skills/hue/SKILL.md` matches upstream byte-for-byte:
     `git show <commit>:SKILL.md | cmp`.
  6. Check `doctor --skills`, and that `tenon update --codex` reports `无需更新` on its second run.
- [ ] **Simulate an unreachable upstream.** Set `git config --global url.https://invalid.example/.insteadOf
      https://github.com/dominikmartn/` in the isolated `HOME`, then run `tenon update --codex`. Expect
      `[skills] 失败 hue unreachable（保留 …）`, other skills and the active runtime unchanged, and doctor `skills:upstream`
      yellow.
- [ ] **Hook latency.** Repeat the step-0 measurement with the new payload. Record p50 before and after in the PR
      description. If p50 grows by more than 150 ms, report it on contract change request 5; do not add excludes.
- [ ] **Claude.** Repeat the isolated install with `--claude`. `claude plugin details tenon@tenon` lists the upstream
      skills, and `claude plugin list --json` shows Tenon with `errors: []`.
- [ ] **Deferred to wave 5.** The real default task in Claude Code and Codex (PRD acceptance 3) runs after
      data-driven-runner merges, because Tenon's OpenSpec procedure moves into `skills/tenon`.

## Risky files

| File | Risk | Mitigation |
| --- | --- | --- |
| `packages/cli/src/commands/managed-host-observation.ts` | The stable proof could accept a tampered tracked skill | Test: `skills/tenon/SKILL.md` differs → false; `ls-tree` failure → false |
| `install.sh` | The public installer rejects valid hosts, or accepts a bad one | `bash -n`; `install-bootstrap.node-test.mjs`; clean-install local mode |
| `packages/cli/src/commands/update-native.ts` | A no-op update republishes; a changed lock reports `current` | update tests 2 and 3 (§14) |
| `packages/cli/src/commands/setupHost.ts` | The skip-verification shortcut leaves a changed root unverified | Setup call-order test |
| `packages/automation/src/skills/skill-provenance.ts` | The verifier accepts extra directories, or rejects a valid payload | One fixture per category; real repository with and without a lock |
| `tools/verify-skills.sh` | Deleting §4 breaks the hook sandbox | `bash tools/test-hooks.sh` |
| `skills/` deletion | A forgotten reference makes a gate red at run time | The reference `git grep` in step 11; `check:default-skill-matrix`; doctor `skills:workflow-phase` against a fetched checkout |

Rollback points: **A** after commit 6 (host wiring) and **B** after commit 11 (content switch). Commits 1–5 are additive
and inert.

## Overlap with other child tasks and merge notes

| File(s) | Other child | Merge note |
| --- | --- | --- |
| `skills/tenon-explore/SKILL.md`, `skills/tenon-build/SKILL.md`, `skills/tenon-*`, `skills/simple-task`, `skills/learn-record`, `skills/tenon-researcher` | data-driven-runner | That child deletes these directories. The deletion wins over our line edits. It also deletes the 10 interim `!/skills/<id>/` lines in `.gitignore` |
| `templates/skill-sources.yaml` | data-driven-runner | Generated. After any merge run `npm run sync:skill-provenance`; never hand-merge |
| `packages/cli/src/commands/doctor-skills.ts`, `doctor.ts` | data-driven-runner (phase-skill checks `:132-177`), multi-user (possible identity row) | Our changes are the `checkSkills` merge (`:78-129`) and one appended runner. Keep both sides' appended checks in merge order |
| `templates/manifest.yaml` | review-agents (removes `review_skills` / review lanes), data-driven-runner | If `review_skills` is deleted, our `:64` edit disappears with it |
| `tools/verify-skills.sh`, `tools/test-hooks.sh`, `tools/test-bundle.sh` | data-driven-runner (tenon-ship §6 grep, tenon-build/verify greps) | We only touch §4, header lines 8-9, and hook tests `:660-709,1823,1832` |
| `skills/sources.yaml` | design-resources (8 `greensock/gsap-skills` rows) | Append-only rows. Re-run the kernel `sources.yaml` test and update its count assertion to 53 |
| `install.sh`, `tools/clean-codex-install-acceptance.mjs`, `README.md`, `docs/DIST-RELEASE.md` | version-reset | Version strings versus our `skills` loop and fixture code are disjoint hunks. Rebase the later branch and rerun `check:npx-package` |
| `packages/cli/src/program.ts` | multi-user, task-delete-archive, test-evidence, review-agents | Hot file. We add one hidden command and one doctor option |
| `packages/server/src/serverGetRoutes.ts` | review-agents, instruction-templates, design-resources, test-evidence, task-delete-archive | Hot. We add one `if (path === '/api/skills/sources')` block next to `/api/skills/registry` |
| `packages/dashboard-app/src/shell/views.ts`, `App.tsx`, `i18n/translations.ts` | instruction-templates and design-resources (Library/Projects views), multi-user (top bar), task-delete-archive, workflow-io-openspec | Hot. `VIEWS` order after merge: `progress, workbench`, then other children's views, then `skills` last. Merge `nav` keys in both zh and en |
| `.gitignore` | multi-user (`.tenon/users/*/local/`) | Disjoint blocks |

## Deviations

1. **Error categories landed in commit 4, not commit 1.** `SKILL_PROVENANCE_ERROR_CATEGORIES` gains
   `invalid-skill-sources` / `invalid-skill-lock` together with the verifier fixtures that cover them,
   because `skill-provenance.test.ts` asserts one failing fixture per declared category and commit 1
   would have left that assertion red.
2. **`skills:upstream` is appended at the very end of the doctor check list**, after `afk:*`, rather than
   directly after `integration:codex-project-skills`. "Tail check, order unchanged except for the
   appended row" is then literally true: every existing id keeps its position.
3. **The file reader lives in `@tenon/automation`** (`skills/upstream-skill-view.ts`,
   `readUpstreamSkillView` + `readUpstreamSkillRunReport`) instead of a server-only
   `packages/server/src/skillSourcesView.ts`. The server already depends on automation, so doctor and
   `GET /api/skills/sources` share one reader instead of two copies; its tests are
   `packages/automation/src/skills/upstream-skill-view.test.ts` plus the route case in `server.test.ts`.
4. **The three skill GET routes moved to `packages/server/src/serverGetSkillsRoutes.ts`.** Adding the
   sources route inline pushed `serverGetRoutes.ts` to 405 lines against the 400-line controller limit;
   the delegation call sits exactly where the routes were, so the DNS-rebinding Host guard still covers
   them.
5. **`internal-skill-upstream` is registered in `program-install.ts`**, not `program.ts`, for the same
   size limit (`program.ts` reached 402 lines with the hidden command plus `doctor --skills`).
6. **The `bundled-skills` host-target-plan step is kept.** It is a closed enum shared by the CLI, the
   server protocol and the Dashboard decoders with their fixtures; removing it is a cross-package change
   outside this child. `printPlanSkeleton` now describes that step as the upstream fetch.
7. **A development checkout only deletes upstream-managed skill directories.** `applyStaged` removes any
   directory that is neither bundled nor locked for `codex` / `claude`, but under `host: 'dev'` it removes
   only ids listed in `sources.yaml` or the previous lock, so `npm run skills:fetch` cannot delete
   unregistered work in progress.
8. **The clean-install fixture serves every `sources.yaml` row from its own local bare repository.** A
   single-entry rewrite (design step 12) removed the 20 mandatory upstream ids and made `doctor --json`
   exit 1 on `skills:mandatory`. The fixture now copies only `git ls-files skills`, keeps the real
   `sources.yaml`, adds `.gitignore` to `LOCAL_RELEASE_ENTRIES` (with one forced add for
   `.agents/plugins/marketplace.json`, the only ignored payload entry), and rewrites each declared
   repository URL exactly — a blanket `https://github.com/` rewrite would shadow the tenon marketplace.
9. **`tools/check-docs.mjs` `EXPECTED_VIEWS` and its self-test fixtures gained `skills`**, and both
   dashboard usage documents document the view; the checker pins the operational view set and order.
10. **Deferred:** the real isolated Codex / Claude installs of step 14 (parent X18 keeps real-host runs in
    wave 5) and the PRD acceptance task in both hosts (needs data-driven-runner's `skills/tenon`).
