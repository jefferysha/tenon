# Default workflow and Codex E2E (real hosts, official installs)

Raw evidence: `scratchpad/e2e-evidence/tenon-e2e-default*/`, `scratchpad/e2e-evidence/tenon-e2e-codex/`
(stream-json / `codex exec --json` transcripts and summaries), `.playwright-mcp/d1-*.png`.
Seed project: `task-board` (Node 22 ESM, `npm test` = `node --test`), planted bug in `upcoming()`.

## Runs on v1.1.0 (blocked, found the defects)

| Run | Host | What happened | Root cause | Fixed in |
| --- | --- | --- | --- | --- |
| D1 first turn | Claude Code | Change `filter-by-priority` created by routing; all three `tenon document record` calls failed `current StepVisit lacks exact host confirmation`; the agent refused to forge evidence | Claude Code reports `tenon:openspec-propose`; the Skill receipt rejected `:` | v1.1.1 |
| X1 first turn | Codex `exec` | `tenon init` failed `withLock: current process start identity is unavailable` | workspace-write sandbox denies `/bin/ps` (proven with `codex sandbox`) | v1.1.1 |

## D1 · feature `filter-by-priority`, default workflow, backend track (Claude Code, v1.1.1)

| Step | Skills (history) | Outputs | Gate |
| --- | --- | --- | --- |
| open | `tenon:tenon-open`, `tenon:openspec-propose` (receipt sealed on v1.1.1) | proposal / openspec-design / tasks recorded | none → `open-complete` |
| explore | `tenon-explore`, `openspec-explore`, `brainstorming`, `grill-with-docs`, `improve-codebase-architecture` (the DAG gate refused `improve-codebase-architecture` until brainstorming and grill were done) | `docs/superpowers/specs/filter-by-priority-design.md` (superpower-design), `docs/adr/filter-by-priority.md` (adr), field `design_doc`; document status PASS | two interaction pauses (brainstorming, grill-with-docs), each cleared by 「确认继续…」; review `explore-complete` approved in the **Dashboard** review console (history `via=dashboard`, channel companion written) |
| spec | `tenon-spec`, `openspec-propose`, `writing-plans` | delta spec `openspec/changes/filter-by-priority/specs/task-priority-filter/spec.md`, plan `docs/superpowers/plans/filter-by-priority.md` (superpower-plan + plan), field `plan`; document status PASS | agent verified the Dashboard approval in state before `explore-complete`; review `spec-complete` approved in the **terminal** |
| build | `tenon-build`, `test-driven-development`, `writing-plans` | `build_mode=direct`, `isolation=in-place`, `direct_override=true`; T1/T3/T6 seen failing before `filterByPriority` was implemented with `Object.hasOwn`; 7 new tests, README line; `tasks` re-recorded by `tenon-build`; `pre_verify_review_result=pass` | none → `build-complete` (`build_sha=build:v1:workspace:…`) |
| verify | `tenon-verify`, `verification-before-completion`, `e2e-testing`, reviewer agents `tenon:tenon-reviewer` ×2, a real `codex exec` review lane on the diff (first attempt hung on stdin and timed out; the retry exited 0 after running the tests itself), `finishing-a-development-branch` | `review-attempt begin` on the build token, `agent_review_result=pass`, `codex_review_result=pass`, `branch_status=handled`, `docs/superpowers/reports/filter-by-priority-verify.md`; independent `npm test` 10/10 | review `verify-pass` approved in the **Dashboard** (card `review` → `ready`, rail open…build done / verify current, verify skill nodes done, verification-report recorded) |
| ship | `tenon-ship`, `openspec-apply-change`, `finishing-a-development-branch` | main spec `openspec/specs/task-priority-filter/spec.md` (`openspec validate --strict` exit 0), `applied-spec.md`; local branch `feature/filter-by-priority`, commit `d9b0e28` (13 files); field `branch` | **stopped honestly**: `tenon check` fails `pr_url` required (null) and the unticked "open PR" task. The sandbox has no remote and the agent did not fabricate a PR URL — the backend Ship exit worked as designed |

D1 result: every review gate exercised with both channels (explore and verify in the Dashboard, spec in
the terminal), all declared skills invoked in DAG order, documents recorded in `openspec/` and `docs/`,
`verify_result=pass`; Ship stops only on the real PR requirement.

Dashboard before approval: card `review`, stage rail open done / explore current, all five explore
skill nodes `done`, outputs superpower-design and adr `recorded`, design_doc `set`.

## D2 · bugfix `fix-upcoming-no-due-last`, default workflow, free track (Claude Code, v1.1.1)

| Step | Skills (history) | Outputs | Gate |
| --- | --- | --- | --- |
| open | `tenon:tenon-open`, `tenon:openspec-propose` with `NativeSkillReadBinding` rows (receipts sealed) | proposal / openspec-design / tasks recorded; root cause diagnosed (`due ?? ''`, no tie returning 0) | none → `open-complete` |
| explore | `tenon-explore`, `brainstorming` | `docs/superpowers/specs/fix-upcoming-no-due-last-design.md`, `docs/adr/fix-upcoming-no-due-last.md` (recorded outside the Change: v1.1.1 repository-scoped documents), open documents re-recorded with producer `tenon-explore` (v1.1.1 digest refresh); bug reproduced on Node 24 | brainstorming pause cleared by 「确认继续，按推荐方案 A…」; review `explore-complete` approved in the terminal |
| spec | `tenon-spec`, `openspec-propose`, `writing-plans` | delta spec `specs/upcoming-order/spec.md` (4 requirements, 7 scenarios), plan `docs/superpowers/plans/fix-upcoming-no-due-last.md`; document status PASS | review `spec-complete` approved in the terminal |
| build | `tenon-build`, `test-driven-development`, `writing-plans` (the DAG gate refused `writing-plans` until `test-driven-development` ran) | `build_mode=direct`, `isolation=in-place`, `direct_override=true`; two regression tests written first and seen failing, then `src/board.js` fix (+9/−1) and 4 new tests (+43); `pre_verify_review_result=pass` | none → `build-complete` (build revision captured by the transition) |
| verify | `tenon-verify`, `verification-before-completion`, independent read-only reviewer agent `tenon:tenon-reviewer` | `docs/superpowers/reports/fix-upcoming-no-due-last-verify.md` (field `verification_report`), `branch_status=handled`; independent `npm test` 7/7 | review `verify-pass` approved in the terminal |
| ship | `tenon-ship`, `openspec-apply-change`, `finishing-a-development-branch` | delta applied to the main spec `openspec/specs/upcoming-order/spec.md`, `applied-spec.md`; local branch `fix/upcoming-no-due-last` with commit `63387e4` (fix, tests, spec, design, ADR, plan, report); nothing pushed (no remote), `main` untouched | none → `ship-complete` |
| archive | `tenon-archive` | Change moved to `openspec/changes/archive/2026-09-14-fix-upcoming-no-due-last/` (commit `f0d97b8`), tasks all ticked | `archived` |

Final canonical state (archived Change): `archived=true`, `archived_at=2026-09-14T23:12:30Z`,
`phase=archive`, `phase_status=done`, `verify_result=pass`, `build_sha=build:v1:workspace:…`.
Transitions in order: `open-complete` → `explore-complete` → `spec-complete` → `build-complete` →
`verify-pass` → `ship-complete` → `archived`; each review step has a `review:acknowledge via=terminal`
row before its transition. Document ledger: proposal, openspec-design, tasks, superpower-design, adr,
delta-spec, superpower-plan, plan, verification-report, applied-spec. `tenon list` is empty afterwards.

## X1 · feature `add-rename-task`, default workflow, backend track (Codex, v1.1.1)

| Step | Evidence | Result |
| --- | --- | --- |
| open | `tenon init` succeeded inside the sandbox; `CodexSkillRead` + `CodexSkillReadBinding` rows; proposal / openspec-design / tasks recorded; `tenon check` pass | pass (first `document record` fails until the producer SKILL.md is read again; the agent recovers) |
| explore (v1.1.1) | all five explore skills read; transition `open-complete`; design doc + ADR written; `design_doc` registered; open documents re-recorded | **blocked**: every `document record --producer brainstorming` requires re-reading `brainstorming`, which placed a new interaction marker, so the retry was locked again after each approval |
| explore (v1.1.2) | 「确认继续」 wrote `InteractionConfirmed: brainstorming` (00:27:05); re-reads of `brainstorming` did not lock again and `superpower-design` was recorded; `grill-with-docs` then asked once and 「确认继续」 wrote `InteractionConfirmed: grill-with-docs` (00:28:44); the agent then assumed the gate still held and stopped without retrying (no command ran), fixed in v1.1.3 by announcing a released lock; on an explicit retry: `adr` recorded (producer `brainstorming`), `tenon document read all`, `tenon check` pass | document status PASS (proposal, openspec-design, tasks, superpower-design, adr); review `explore-complete` requested and approved in the terminal (`via=terminal`, 00:32:43) |
| spec (v1.1.2) | `explore-complete` transition; `CodexSkillRead` of `tenon-spec`, `openspec-propose`, `writing-plans`; `tenon document scaffold … delta-spec --capability task-renaming`; delta-spec, superpower-plan and plan recorded, superpower-design re-recorded by `tenon-spec`, `plan` artifact registered; one `tenon check` failed on missing coverage and passed after the agent completed it | document status PASS (8 kinds); review `spec-complete` requested and approved in the terminal |
| build (v1.1.2) | `CodexSkillRead` of `tenon-build`, `test-driven-development`, `writing-plans`; `build_mode=direct`, `isolation=in-place`, `direct_override=true`; red run (`npm test --test-name-pattern=renameTask` exit 1) then `renameTask` implemented; `tasks` recorded by `tenon-build` after the usual first-record re-read; the first `build-complete` was refused until `writing-plans` had been read (declared step skills enforced at transition) | `pre_verify_review_result=pass` → `build-complete` (`build_sha=build:v1:workspace:…`) |
| verify (v1.1.2) | `CodexSkillRead` of `tenon-verify`, `verification-before-completion`; handoff bundle, `review-attempt begin` on the build token; standards, spec and E2E lanes PASS; independent `npm test` 6/6. **Codex CLI lane degraded**: `codex` exists but cannot start its app-server inside Codex's own workspace-write sandbox (`Operation not permitted`); per `skills/tenon-verify/SKILL.md` (third lane "缺失优雅降级", line 348 "codex 缺失跳过时同样置 pass 并在报告注明第三轨降级") the agent set `codex_review_result=pass` and recorded the degradation in `docs/superpowers/reports/2026-09-15-add-rename-task-verify.md` | `agent_review_result=pass`, `codex_review_result=pass` (degraded, see report), `branch_status=handled`; review `verify-pass` approved in the terminal after reading the report |

| ship (v1.1.2) | `verify-pass` transition; `CodexSkillRead` of `tenon-ship`, `openspec-apply-change`, `finishing-a-development-branch`; main spec `openspec/specs/task-renaming/spec.md`, `applied-spec.md` recorded, delivery tasks ticked, document read PASS; independent `npm test` 6/6 | **stopped honestly**: `tenon check` fails only `pr_url` required (null). No remote, and Codex's workspace-write sandbox denied `.git/index.lock`, so no local commit either; no fabricated PR URL |

X1 result: a real Codex task governed through open → explore → spec → build → verify → ship on the
official install, every review gate approved in the terminal, declared skills enforced at invocation and at
transition, documents recorded in `openspec/` and `docs/`, `verify_result=pass`; Ship stops only on the real
PR requirement.

Known limitation (not changed): `codex_review_result` does not distinguish a real Codex review from the
documented degraded skip; the distinction lives only in the verification report. Changing it would alter the
field contract, the verify guard, the Dashboard and docs, so it is left as a product decision.

Approval phrase finding: 「确认以上 Explore 决策并继续写入产物」 (suggested by the agent itself) did not match
the approval vocabulary and was ignored silently; 「确认继续」 cleared the marker, which proves Codex runs the
UserPromptSubmit hook on `codex exec resume`.

Fixed in v1.1.2 (`5dfba8fc`): an approval writes `InteractionConfirmed: <skill>`; the interactive-skill
gate does not lock a skill already confirmed since entering the step; the gate names 「确认继续」 and an
unrecognized reply while a marker is pending tells the agent it was not taken as approval.

## Official v1.1.2 install for Codex (network)

| Attempt | Result | Detail |
| --- | --- | --- |
| 1 | `install.sh --codex` exit 1 | `stable Release object proof failed: spawnSync /usr/bin/git ETIMEDOUT` (shallow tag fetch exceeded 60 s); managed runtime left unchanged |
| 2 | exit 1 | `git ls-remote` answered in 1 s, then the object fetch failed `LibreSSL SSL_connect: SSL_ERROR_SYSCALL`; runtime unchanged |
| 3 | exit 0 (154 s) | three probe fetches through the local proxy `127.0.0.1:7897` succeeded in 6–9 s each; active runtime `host=codex v1.1.2 valid`, Codex plugin 1.1.2 enabled |

The failures were transient network errors through the proxy, but one of them aborted the whole install.
Fix `f7375184`: the stable release proof retries `git ls-remote` and the shallow `git fetch` on transport
failures (timeout, TLS reset, unable to access, connection reset) up to three attempts with a short backoff;
a missing tag or ref still fails immediately and every result is validated as before.

Health after both v1.1.2 installs: Claude plugin 1.1.2 `errors=[]`, Codex plugin 1.1.2 enabled,
`tenon doctor` 20/21 green (only the AFK Claude credential is yellow), Dashboard version 1.1.2.

## Official v1.1.3 install (final delivery)

| Check | Result |
| --- | --- |
| `install.sh --claude` | exit 0 (112 s) |
| `install.sh --codex` | exit 0 (401 s), no manual retry |
| Claude plugin | 1.1.3, enabled, `errors=[]`; details: Skills (70), Hooks (4) |
| Codex plugin | `tenon@tenon installed, enabled 1.1.3` |
| `tenon doctor` | exit 0, 19/21 green; yellow `project:cwd` (the check ran in the non-pipeline seed directory) and AFK `CLAUDE_CODE_OAUTH_TOKEN` |
| Dashboard | `version 1.1.3` |
| Installed hooks smoke (`installed-hooks-smoke.sh` against runtime `host=codex version=1.1.3 commit=bf5cff4e valid=true`) | 7/7 ok: 「确认继续」 announces and clears the lock and writes `InteractionConfirmed: brainstorming`; a confirmed skill re-read places no marker; an unconfirmed interactive skill still asks; an unrecognized reply prints the unlock hint and keeps the marker |

The same smoke script run against v1.1.2 failed only the announcement check, so it discriminates the v1.1.3 fix.

## X2 · feature `remove-task`, default workflow, free track (Codex, v1.1.3 → v1.1.4)

Sandbox `tenon-e2e-codex-v113`, fresh copy of the seed; prompt 「用 free 轨道为任务看板实现 removeTask(board, id)：删除指定任务，任务不存在时抛错，并添加单元测试」.

| Step | Evidence | Result |
| --- | --- | --- |
| open (v1.1.3) | `tenon init remove-task --track free --workflow default`, session activate, `openspec-propose` read; first `document record proposal` failed `lacks exact host confirmation`; the agent spent four commands searching the bundled source, re-read the skill, then recorded proposal / tasks / openspec-design without further reads; `tenon check` pass | pass, paused for 「继续」 |
| explore (v1.1.3) | `open-complete`; explore skills read; `brainstorming` placed the interaction marker; the agent asked for 「确认继续，选 1/2/3」 (return value of `removeTask`) | reply 「确认继续，选 1」 unlocked the gate and **the agent continued in the same turn without another prompt** (v1.1.3 announcement verified in a real host): `design_doc` registered, documents recorded, `tenon check` pass, `tenon review request … explore-complete` |
| explore → spec (v1.1.3) | reply 「继续」: the UserPromptSubmit hook recorded `review:acknowledge via=terminal` even though the model call then failed (`Selected model is at capacity`); on retry the agent ran `tenon transition remove-task explore-complete`, read `tenon-spec`, scaffolded `delta-spec --capability task-removal` | transition 02:16:54; the retry turn failed again on provider capacity |

Defects found by X2 and fixed in v1.1.4 (`cb8bdfb8`):

1. The Codex transcript proof accepted only `const r = await tools.exec_command({...}); text(r);`. The first
   `openspec-propose` read was `text(await tools.exec_command({...}));` with the complete 4 611-byte skill in the
   output, so it produced no evidence (reproduced by running the built parser on transcript rows 47 and 107: the
   inline program decoded to `undefined`, the bound one to the `cat` command; the `max_output_tokens` value did not
   matter). The single-expression form is now accepted with the same anchoring.
2. `tenon-explore/SKILL.md` is 19 958 bytes (~4 990 tokens). The agent read it with `max_output_tokens` 2000 and
   1000 (outputs truncated, correctly rejected) before an 8000 budget produced the full file; each failure showed
   only `lacks exact host confirmation`. The error now says how to recover in each host, and the `tenon` skill states
   the output budget rule.

## v1.1.4 verification

- CI push run 34920624741 on `a3351189`: verify and windows-native-trust success.
- Local mirror of the CI verify job (`rel114-gates.sh`, 28 gates): 27 pass including clean Codex install, docs site,
  hooks, adapters, bundle smoke and the oracle dual run. `npm test` failed 1 of 7 282 tests.
- Two load-induced test flakes, each passing on its own and in CI, fixed as test-only commits after the release
  commit (kept off `main` until the release chain finished, because the candidate requires the tagged commit to stay
  the main tip):
  - `kernel/src/loops/ledger-store.test.ts` asserted the lock handoff after a fixed 30 ms sleep; under full-suite
    load the outer callback had not yet acquired the physical lock (`expected [] to deeply equal ['outer-cb-return']`).
    The test now waits for the callback to return first (`6544bec3`); 5/5 runs pass, including three concurrent.
  - `server/src/workflowRuntime.browser.e2e.test.ts` (real Chromium, ~0.4 s alone) timed out at its 30 s whole-test
    budget in the next full run; budget raised to 90 s, every browser step keeps its 10 s bound (`62a0dc32`).
- Full `npm test` after both fixes: 448 files, 7 267 passed, 15 skipped, 0 failed.
- Release chain for `a3351189`: candidate 34922053099, writer 34923506556 (create-tag, release, dispatch), public
  acceptance 34923533592 (public-install-update) all success; `v1.1.4` published 2026-09-15T03:03:28Z, tag object
  `5ab17488` → commit `a3351189`.

| Official v1.1.4 install | Result |
| --- | --- |
| `install.sh --claude` | exit 0 (400 s) |
| `install.sh --codex` | exit 0 (239 s) |
| Claude plugin | 1.1.4, enabled, `errors=[]`; Skills (70), Hooks (4) |
| Codex plugin | `tenon@tenon installed, enabled 1.1.4` |
| `tenon doctor` | exit 0, 19/21 green; same two expected yellow checks (non-pipeline cwd, AFK Claude token) |
| Dashboard | `version 1.1.4` |
| Installed hooks smoke | 7/7 ok against runtime `host=codex version=1.1.4 commit=a3351189 valid=true` |

### X2 continued on v1.1.4 (new Codex session)

The first attempt failed three times on provider capacity (`Selected model is at capacity`); an automatic retry loop
(3 min backoff) got through on attempt 1 of the second loop.

| Step | Evidence | Result |
| --- | --- | --- |
| spec (v1.1.4, new session `01a0a31f`) | prompt 「Tenon 已升级到 v1.1.4。继续推进 remove-task…」; the agent read skills from the `1.1.4` cache, `tenon session activate` bound the new host session to the existing Change; `openspec-propose` read (bound form, 20000 budget) → `document record delta-spec` **succeeded on the first try**; `writing-plans` read → `document scaffold plan`, `artifact register plan`, `superpower-plan` recorded | the first `--producer tenon-spec` record failed because the agent had read `tenon-spec/SKILL.md` inside a `Promise.allSettled([...])` batch (not one anchored call, rejected by design); the v1.1.4 hint named the recovery and the agent immediately ran one standalone `text(await tools.exec_command({cmd:"cat …/tenon-spec/SKILL.md",max_output_tokens:12000}))`, **the newly accepted form**, and the record then succeeded; `document read all`, document status PASS (8 kinds), `tenon check` pass, `tenon review request … spec-complete` |

| spec → build (v1.1.4) | 「确认继续」 acknowledged `spec-complete`; `tenon-build`, `test-driven-development`, `writing-plans` read; `handoff --bundle --target build`; `build_mode=direct`, `isolation=in-place`; red `npm test` then green; first `--producer tenon-build` record failed because `tenon-build` had been read inside a `Promise.allSettled` batch, the hint led to one standalone read (24 000 budget, 7 274-token skill) and the record passed; `build-complete` | pass |
| verify (v1.1.4) | `tenon-verify`, `verification-before-completion` read; `review-attempt begin` on `build_sha`; `npm test` and `git diff --check` pass; official `openspec validate remove-task --strict` in an isolated copy **failed**: `task-removal/spec.md: ADDED "按 ID 删除任务并返回被删除任务" must contain SHALL or MUST` (the requirement said 「必须」); verification report recorded, `tenon review request … verify-fail` | the workflow caught a real spec defect; the agent offered 「修复 / 接受偏差」 |
| verify-fail loop (v1.1.4) | reply 「修复」 was **not recognized** by the review gate and nothing said so; the agent asked the user to reply 「确认修复并继续」, which the hook classifier does not recognize either (`pipeline_prompt_approval_intent` returns empty); after that explicit user reply the agent ran `tenon review acknowledge remove-task` itself as its first command (history `review:acknowledge via=terminal … verify-fail` 04:00:41, the documented terminal channel; the agent did the same after 「确认继续」 in the next two turns, where it was redundant); `tenon transition verify-fail` (→ build) then `requirements-changed` (→ spec, after re-reading the build skills); requirement rewritten with `MUST`; delta-spec and tasks re-recorded, `document read all`, `tenon check` pass, `spec-complete` requested again | send-back loop works end to end |

| build → verify again (v1.1.4) | 「确认继续」; `spec-complete` refused once until `writing-plans` was read (declared step skills enforced), then transition; `tasks` recorded by `tenon-build` on the first try; `npm test`, `git diff --check`; `build-complete`; verify: `review-attempt begin`, 7/7 tests, isolated `openspec validate --strict` and archive rehearsal **pass**; verification report recorded; `verify-pass` requested | pass |
| ship (v1.1.4) | 「确认继续」; `verify-pass` transition; `tenon-ship`, `openspec-apply-change`, `finishing-a-development-branch` read; `document scaffold applied-spec`, `openspec validate remove-task --strict`, applied-spec and tasks recorded, `tenon check` pass | pass (free track has no PR requirement); the agent asked for 「确认归档」 |
| archive (v1.1.4) | 「确认归档」 (three attempts because of provider capacity); `ship-complete`; `tenon-archive` read; tasks recorded; `tenon transition remove-task archived`; `openspec archive remove-task --skip-specs --yes` | **archived**: the agent's `tenon get remove-task archived` printed `true` before `openspec archive` moved the Change; checked afterwards: `openspec/changes/archive/2026-09-15-remove-task/.pipeline.yaml` has `archived: true`, `verify_result: pass`, `phase: archive`, history transition `archived` at 04:34:51Z, `tenon list --json` returns no active Change, main spec `openspec/specs/task-removal/spec.md` contains `MUST`; sandbox `npm test` 7/7; changes left uncommitted (workspace-write sandbox cannot write `.git`) |

X2 result: the first Codex task governed from `tenon init` to `archived: true`, across a Tenon upgrade (v1.1.3 → v1.1.4)
and a new host session, including a real verify-fail send-back loop.

Defects found here and fixed in v1.1.5:

1. Nothing before Verify tells the agent that OpenSpec strict validation needs the English `SHALL`/`MUST`: the zh-CN
   scaffold prompt said only 「使用中文编写需求与场景；保留 OpenSpec 机器操作词」, `tenon-spec` did not mention it, and
   the spec-stage `tenon check` does not run OpenSpec. The prompts (both locales) and `tenon-spec` now state the rule and
   the skill runs `openspec validate <change> --strict` before the spec review when the CLI is available.
2. The unrecognized-reply hint covered interaction and confirm markers only; a pending review stayed silent. It now
   covers `.pipeline-pending-review` (no mutation, no acknowledgement), and `tenon-verify` names 「确认继续」 at
   `verify-fail`.

## v1.1.5 release

- Commits `a3b4b4f7` (fix) and `a0a7f0a4` (release prep); CI push run 34927495007 success.
- Local mirror of the CI verify job (`rel115-gates.sh`): 28/28 pass, including the full `npm test` (448 files) and the oracle.
- Release chain: candidate 34929499474, writer 34930601856 (create-tag, release, dispatch), public acceptance
  34930633366 (public-install-update) all success; `v1.1.5` published 2026-09-15T04:54:22Z, tag object `5683855f` →
  commit `a0a7f0a4`.

| Official v1.1.5 install | Result |
| --- | --- |
| `install.sh --claude` | exit 0 (326 s) |
| `install.sh --codex` | exit 0 (449 s) |
| Claude plugin | 1.1.5, enabled, `errors=[]`; Skills (70), Hooks (4) |
| Codex plugin | `tenon@tenon installed, enabled 1.1.5` |
| `tenon doctor` | exit 0, 19/21 green; same two expected yellow checks |
| Dashboard | `version 1.1.5` |
| Installed hooks smoke (`SMOKE_V115=1`) | 13/13 ok against runtime `host=codex version=1.1.5 commit=a0a7f0a4 valid=true`: the seven earlier checks, plus a pending review marker with reply 「修复」 prints the unlock hint and keeps the marker, and both installed plugin caches (Codex and Claude) carry the `tenon-spec` SHALL/MUST rule and the `tenon-verify` 「确认继续」 guidance |

## D3 · feature `count-open-tasks`, default workflow, free track (Claude Code, v1.1.5)

Sandbox `tenon-e2e-claude-v115`, fresh copy of the seed; headless `claude -p` with stream-json evidence;
prompt 「用 free 轨道为任务看板实现 countOpen(board)：返回未完成任务数量，并添加单元测试」.

| Step | Evidence | Result |
| --- | --- | --- |
| open | Tenon plugin loaded (`Skill tenon:tenon`); `tenon init count-open-tasks --track free --workflow default`, session activate; `Skill tenon:tenon-open`, `Skill tenon:openspec-propose` with `NativeSkillReadBinding` rows (namespaced ids accepted); proposal / design / tasks written and recorded; the agent had first set `preset tweak` itself, noticed the skill leaves the preset to the user, set it back to `full` and asked | reply 「preset 用 full，立项范围没问题，继续」: tasks re-recorded, `open-complete` |
| explore | `Skill tenon:tenon-explore`, `document read all`, `Skill tenon:brainstorming` placed the interaction marker; the next Bash was blocked by `gate.sh` with the v1.1.2 wording; the agent refused to delete the marker, presented approaches A/B/C and four questions, and said a plain 「确认继续」 accepts the recommended answers | reply 「确认继续」 |
| explore (cont.) | marker released; `Skill tenon:tenon-explore`; `document scaffold superpower-design` and `adr`; design doc (rules, decisions D1–D4, coverage) and ADR written; proposal / design / tasks updated; documents recorded; `tenon review request … explore-complete` | pass, waiting for the explore review |
| spec | 「确认继续」; `Skill tenon:tenon-spec`, `document read all`; `document scaffold delta-spec --capability task-board-open-count` rendered **the v1.1.5 prompt** (「每条 requirement 正文须含英文 SHALL 或 MUST…」); `Skill tenon:openspec-propose`, `Skill tenon:writing-plans`; the agent checked `command -v openspec` (1.6.0), wrote 「系统 SHALL …」/「… MUST …」 with five scenarios, a TDD plan, and ran **`openspec validate count-open-tasks --strict` → `Change 'count-open-tasks' is valid`** before `artifact register plan`, recording delta-spec / superpower-plan / plan, and `tenon review request … spec-complete`; an independent strict validate in the sandbox also reports valid | pass — v1.1.5 spec fix verified in the real host |
| build (decision) | 「确认继续」 acknowledged `spec-complete`; `Skill tenon:tenon-build`, `document read all`; before touching code the agent asked for `build_mode` (direct / subagent-driven-development / parallel-team) and `isolation` (in-place / worktree), explaining that `full` preset records `direct_override=true` for direct | reply 「确认继续，都按推荐：direct + in-place」 |
| build | `Skill tenon:writing-plans` was **blocked by `gate.sh`** (「还需先完成 test-driven-development（本次进入该 step 之后）」: the step's skill waves are enforced), so the agent ran `Skill tenon:test-driven-development` first, then `writing-plans`; five tests written, `npm test` failed as planned (`countOpen` missing); `countOpen` implemented as `board.tasks.filter((task) => !task.done).length`, README API list updated; `npm test` 8/8, `git diff --check` clean; tasks ticked and recorded by `tenon-build` | pass; the agent waited for confirmation before `build-complete` |
| verify | 「确认继续」; `build-complete`; `Skill tenon:tenon-verify`, `Skill tenon:verification-before-completion`; `review-attempt begin` on the frozen `build_sha` (required lanes for the free track: `standards`, `spec`, `e2e`); workspace fingerprint before/after all lanes identical; standards lane by a read-only reviewer subagent (one low finding, no change); spec lane re-read every changed file against the spec and ran OpenSpec show / `validate --strict` / archive rehearsal in an isolated copy; e2e lane `npm test` 8/8 in an isolated copy plus a script over the five scenarios; verification report `docs/superpowers/reports/count-open-tasks-verify.md` recorded; `tenon review request … verify-pass` | pass; the Codex CLI lane is not a required lane on the free track and was not run (stated in the report) |
| ship | 「确认继续」 acknowledged `verify-pass`; `Skill tenon:tenon-ship`, `tenon:openspec-apply-change`, `tenon:finishing-a-development-branch`; `document scaffold applied-spec`; main spec `openspec/specs/task-board-open-count/spec.md` created, strict validate passes; applied-spec and tasks recorded; `tenon check` left only the commit/branch item; the agent listed the tracked diff (3 files, +45/−2), the 10 governance documents and ~80 Tenon state files, and asked how to commit (local commit on `main` / feature branch / none) and what to include | reply 「1a 2a」 (local commit on `main` with code + governance documents, state files not staged) |
| ship (cont.) | `git add` of the 3 code files and 10 governance documents; commit `6b34672 feat: add countOpen(board) to count open tasks` (13 files, +546/−2); `npm test` after the commit passes; `openspec validate --specs --strict` passes; tasks recorded by `tenon-ship`; ship check pass | pass, waiting for the archive confirmation |
| archive (pre-check) | 「确认继续」; `ship-complete`; `Skill tenon:tenon-archive`, `document read all`; pre-checks: phase archive, `verify_result=pass`, 10 documents recorded and read, no dependent Change, main spec digest matches the applied receipt; the agent explained the irreversible steps (`tenon transition … archived`, `openspec archive --skip-specs --yes`) and asked three questions: archive now, record learnings (written outside the repo, to `~/.claude/skills/learned/`), follow-up commit for the moved documents | reply 「1a，沉淀：无，3a」 (no learnings written to the user's global skills) |
| archive | tasks ticked and recorded by `tenon-archive`; `tenon transition count-open-tasks archived`; `openspec archive … --skip-specs --yes`; follow-up commit | **archived**, checked independently afterwards: `openspec/changes/archive/2026-09-15-count-open-tasks/.pipeline.yaml` has `archived: true`, `verify_result: pass`, `phase: archive`; history transition `archived` at 05:39:50Z; `tenon list --json` returns no active Change; commits `6b34672 feat: add countOpen(board) to count open tasks` and `113a8b0 chore: archive count-open-tasks change`; `openspec validate --specs --strict` 1 passed; `npm test` 8/8 |

D3 result: a real Claude Code task on the officially installed final release (v1.1.5), governed from `tenon init` to
`archived: true` through all seven default steps, with every review approved in the terminal, the brainstorming
interaction gate, skill-wave enforcement at build, the v1.1.5 delta-spec rule and strict OpenSpec validation before the
spec review, and two local commits.

v1.1.4 fixes verified in the real host: the single-expression read form counts as evidence, and the unconfirmed
producer error leads the agent to the correct recovery in one step (on v1.1.3 the same situation cost four source
searches). Batched reads remain rejected; this is recorded as a known limit.

## Final status

| Run | Host | Workflow / track | Furthest step | Outcome |
| --- | --- | --- | --- | --- |
| D1 `filter-by-priority` | Claude Code | default / backend | ship | `verify_result=pass`; Ship stops only on the required `pr_url` (sandbox has no remote); local commit `d9b0e28` on `feature/filter-by-priority` |
| D2 `fix-upcoming-no-due-last` | Claude Code | default / free | archived | `archived=true`, all seven transitions, main spec applied, commits `63387e4` + `f0d97b8` on `fix/upcoming-no-due-last` |
| X1 `add-rename-task` | Codex | default / backend | ship | `verify_result=pass`; Ship stops only on the required `pr_url`; Codex sandbox denied `.git/index.lock`, so no local commit |
| X2 `remove-task` | Codex (v1.1.3 → v1.1.4) | default / free | archived | `archived: true`, `verify_result: pass`, main spec `task-removal` applied, one real verify-fail send-back loop; uncommitted (sandbox cannot write `.git`) |
| D3 `count-open-tasks` | Claude Code (v1.1.5) | default / free | archived | `archived: true`, `verify_result: pass`, main spec `task-board-open-count` applied, commits `6b34672` + `113a8b0` |

Defects found by these runs and fixed: Claude Code skill receipt namespace (v1.1.1), Codex sandbox lock
identity (v1.1.1), repeated interaction lock on Codex producer re-reads and unnamed unlock reply (v1.1.2),
agent not retrying after an approval and installer aborting on one dropped GitHub connection (v1.1.3),
Codex `text(await exec)` skill reads not counted and an unexplained unconfirmed-producer error (v1.1.4),
the SHALL/MUST rule surfacing only at Verify and silent unrecognized replies for pending reviews (v1.1.5).
