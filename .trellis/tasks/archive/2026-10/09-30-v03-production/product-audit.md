# Tenon v0.2.0 product audit (2026-09-30)

Method: v02 PRDs checked against code at HEAD 9175f913 by three parallel read-only audits, plus commands I ran in a scratch project and an isolated Dashboard (no repo changes). "Measured" = I ran it; "estimate" = derived. Competitor facts come from summarized web fetches.

## 0. Verdict

Not yet production-ready. The core (state machine, N-1 compatible upgrades, ownership-scrubbed uninstall, case-level test parsing) is strong. Five things block the claim:

1. v0.2.0 shipped without the host acceptance its PRD required (no Claude Code or Codex record, no two-identity run, 16 1.x releases still live).
2. Test evidence resists accidents, not an agent that wants to pass: catalog `command`, known-failures and baselines are an unreviewed trust root.
3. Dashboard snapshot cost is linear at 40-70 ms per change in one monolithic payload: 37 s and 11 MB at 30 projects x 30 changes (measured).
4. The local write token is served to any caller, so an agent can in principle approve the human review gate (token scrape and authenticated POST measured; an actual review acknowledgement was not exercised).
5. Mandatory tests on a 7-phase default cost roughly 70-90 CLI calls per small change and force waivers on ordinary projects (measured plan sizes, sim project).

## 1. Unimplemented or partial

| Item | Status | Evidence |
|---|---|---|
| Acceptance R1/R2, test A10: Claude Code and Codex runs, two-identity collaboration | missing | `docs/acceptance/` holds only `2026-07-24-full-system.md` |
| R3 delete 1.x releases | missing | `gh release list`: 16 live. Text disagrees: `release-notes.md:837-838`, `zh-CN/release-notes.md:660` say "removed"; `README.md:330`, `README.en.md:299` say "Tenon 1.0 起" |
| R4 screenshots, R5 Trellis bookkeeping | missing | webp last changed 2026-09-13 (before overview/test/agent pages); all 8 `09-29-v02-*/task.json` say `planning`, 16 older tasks `in_progress`/`planning`, v02 dirs untracked |
| R7 `tenon` on PATH for `tenon test code-size --json` | missing | `default.yaml:142-147`; test env is a copy of `process.env` (`test-run.ts:146-153`); no doctor probe; bare PATH gives exit 127 which blocks Verify; CI uses a shell function (`ci.yml:238`) children cannot see |
| R8 host really loads `tenon-<name>` subagents | missing | only file-existence tests. Codex custom agents have no tool allowlist or `subagent_type`, yet `agents.md:96-97` and `SKILL.md:87` claim host enforcement; Claude Code may need a restart for the first file in a new `agents/` dir, so the first task silently falls back to general-purpose |
| Forms R4 skills page lists injected skills | missing, claimed shipped | `useSkillReferences.ts:16-35` reads only `step.skills`; claim at `release-notes.md:138` |
| Forms R6, Orchestration R1/R6 | partial | `TrackDialog.tsx:3,38` raw `Dialog`, untested; duplicate wave calculators `skillRuns.ts:98`, `skillWaves.ts:11-43`; the <300 ms budget is asserted only in jsdom against a ReactFlow double (`OrchestrationFlow.test.tsx:13,155`) |
| Test R4/R6 policy and coverage | partial | no default `flaky` cap or `scenarios: passing` (only pm spec has `required`, `default.yaml:286`); coverage computed only at scope `full` (`suite-exec.ts:207`). Tenon's own catalog declares none while frontend/backend Verify demand 80% (`default.yaml:611,846`): the repo cannot meet its own default without a waiver, and no `test-plan.yaml` exists under `openspec/changes`, so the dogfood acceptance is unevidenced |
| R7 benchmark baseline | inert | `git ls-files .tenon` = `.gitignore`, `catalog.yaml`. CI profile `linux-x64-epyc776364-node22-eb0c0701` is uploaded, never committed; the id embeds CPU model (`machine-profile.ts:56-66`) so another runner CPU yields `baseline-missing` |
| WebKit, Node matrix | missing | `ci.yml:92,101` Chromium only; WebKit needs `TENON_E2E_WEBKIT=1` (`test-system-playwright.integration.test.ts:21`); CI is Node 22 only while release notes claim 20/22/24 |
| known-failures / flaky "real files" | mostly closed | real-process tests exist (vitest, Playwright, bench). Fixture-only, hand-written: jest, go, pytest, cobertura, k6, lighthouse, hyperfine parsers (`TEST-REALITY.md:226`); `scope: known` inert (`compile-tests.ts:209`) |
| `(unknown)` case file | confusing | sentinel `covers.ts:73`, printed raw at `run-summary.ts:41,45`, `RunCasesSection.tsx:98`; every TAP suite hits it; known-failures need a literal `(unknown) › name` (`known-failures.ts:106`) |
| Dogfood e2e | partial | 6 specs, none for task status/next step; library spec only checks a copy button exists (`library.spec.ts:30`); 5 CI checks unregistered |
| Discover bug (new, measured) | bug | `discover-js.ts:64` limits unit globs to `src/**` when `src/` exists; my `test/sub.test.js` was "claimed by no suite" and the printed fix (`discover --write`) cannot fix it |
| Sync, cleanup, uninstall | partial | Codex block refreshed only with `--migrate` (`sync.ts:111-117`), not on `update`; `.codex-plugin/plugin.json` defaultPrompt stale; host agent files pruned on transition only (`transition.ts:227`), not `task delete/archive`; generated `.claude/agents/tenon-*.md` show untracked in `git status`; `uninstall.ts:88` skips opencode, pi, codex, tap configs |
| Agent validation | partial | skeleton with `<第一步>` placeholders passes `validate/add` (`agent-new.ts:43-70`, `agent-library.ts:129-155`); tool names checked for Claude only; read-only reviewers (`code-size.md`: Read/Grep/Glob) are told to write their report file |
| Older 09-12/13/15 tasks | implemented, records stale | 25 older and all 8 v02 tasks are `in_progress`/`planning` with unchecked boxes; the 3 09-12 TBD stubs are obsolete; `openLegacyLineageView` (`service.ts:428`) has no production caller; stale text in `TEST-REALITY.md:543-544`, `tools/oracle/run.sh:137-141`, `tools/test-adapters.sh:455`; the 09-15 parent's cross-child acceptance was never recorded; 11 leftover worktrees under `.claude/worktrees` sit in the untracked `.claude/` |
| Multi-user | partial | two clones rely on plain git merges: no `merge=union` for `.pipeline-history.jsonl` (`history.ts:12`), `owner take` ignores a behind clone; identity is self-reported by design (`09-15-multi-user/prd.md:33`) |
| Browser e2e for 09-15 UI | missing | no Playwright spec for top-bar user, owner facet/take-over, delete/archive, instruction files, resources (`e2e/dashboard`: connection, library, projects, wizard, workflow, workspace-tests) |

## 2. Production readiness

### 2.1 Platform, install, upgrade
- Windows is undeclared, not supported: `install.sh` and `hooks.json` are bash (`bash "${HOME}/.local/bin/tenon-hook"`), docs mention Windows only for data dirs (`installation.md:197`), the Windows CI job runs 2 test files (`ci.yml:8-30`), service teardown hard-codes `/bin/sh` and on win32 kills only the shell (`services.ts:106,166`). Declare POSIX+WSL and have `doctor` say so, or invest.
- Strong, no gap found: pinned installer with dry-run, atomic managed releases, `runtime repair --rollback`, ownership-manifest uninstall, N-1 gate (`ci.yml:205`), v1 records readable.
- Gaps: no signature or provenance attestation on release assets (no attest/cosign in `release*.yml`); every upgraded project needs a manual `tenon test discover --write` or new tasks block with `test-catalog-missing`; the 1.x cutover window ends 2026-10-31.

### 2.2 Scale and footprint (measured, darwin-arm64, Node 24, `tools/bench/snapshot.mjs`, cache invalidated per run)
| Fixture | Changes | Body | Rebuild p50 |
|---|---|---|---|
| 2 projects x 6 | 12 | 154 KB | 0.86 s |
| 10 x 20 | 200 | 2.5 MB | 9.4 s |
| 30 x 30 | 900 | 11.4 MB | 37 s |

Every non-GET drops the cache (`server.ts` createServer); a code comment already cites 34 roots on a real machine (`snapshotCache.ts`). CI benches only 2x6. `tenon status` is fine (150 ms). Test side: about 5 git subprocesses per change with a 20 s timeout can make a large repo permanently `files-diff-unavailable`; the untracked list is silently capped at 20,000 (`changed-files.ts:88`); the record chain is re-hashed on every read and records are never pruned.
Repo footprint: each change is 22 files / 124 KB committed (a 39 KB frozen workflow plan, 7 frozen agent copies). Each `tenon test run` adds a tracked JSON under `.tenon/users/<slug>/tests/` (only `local/` is ignored); `test-results/` is not ignored.

### 2.3 Security
- Measured on an isolated Dashboard: `GET /` returns the write token to any caller (`serverTransport.ts` `serveIndexWithToken`), `GET /api/snapshot` is 200 unauthenticated, and a POST with the scraped token passes auth (400 on an empty body, not 401). The token defends against browsers and DNS rebinding (`serverSupport.ts:63`, `serverPostRoutes.ts:173-179`), not against another local user or the agent. `security-model.md` puts same-UID out of scope, but the review gate exists to constrain the agent, and the counter is a string pre-filter (`gate.sh` top: token filename, or loopback host plus `/api/` in the raw input) that a script file or split URL should evade (inferred, not run).
- Test-evidence trust root: `gate.sh` allowed `python3 -c`, `node -e`, `curl -o`, `tar -x`, `git checkout HEAD~3 -- baselines`, `git apply`, variable paths, script files and `xargs sh -c` writes into protected paths (13 probes); `echo > catalog.yaml` is allowed by design (`test-hooks.sh:2567`); Write to `.pipeline/workflows/default.yaml` and `.pipeline.yaml` passes. A suite `command: cat fake.xml > test-results/x.xml` yields a valid record; a catalog digest change only causes staleness (`evaluate-suite.ts:56`). `tenon test known add` is a self-service whitelist accepting file-only refs (`test-known.ts:22-47`). The fingerprint ignores any path segment named `coverage`, `test-results`, `playwright-report`, `.cache` (`fingerprint.ts:44-60`). Chain digests are plain sha256, unkeyed (`record-chain.ts:35`).
- Repo-controlled execution: catalog `command`/`services` and project `.tenon/agents/` run on `tenon test run`; a cloned repo is trusted implicitly.
- Routing false negatives (sim project without host install, caveat): the router governed "fix a typo" (simple) and "fix the off-by-one bug ... add a regression test" (backend) but emitted nothing for "add a subtract function to src/add.js", "refactor the add module" and Chinese equivalents. Governance silently does not engage.

### 2.4 Observability, errors, i18n, a11y, onboarding
- No Dashboard log file or `tenon logs`; `SUPPORT.md:20-30` asks users to hand-run five commands and redact by eye. No telemetry is an asset: ship `tenon support bundle` (local, redacted).
- Errors are mixed-language and sometimes unhelpful: `ERROR: illegal transition: open -> spec` lists no legal events, beside Chinese messages. `tenon --help` and all CLI output are Chinese-only with no locale switch (no `TENON_LANG`), while docs are bilingual (17/17 files). Dashboard zh/en is tested (`i18n.test.tsx:146`) but leaks at `taskCommands.ts:28` (`/tenon 继续`) and `blockerLabel.ts:13-34` (regex over Chinese server text); `index.html` fixes `lang="zh"`.
- Accessibility: 488 aria/role uses and roving-radio keyboard work, but no axe automation anywhere and no WebKit.
- Onboarding: the zero-project Dashboard state is good (`Onboarding.tsx`); the CLI path is not: `init` needs `--track --preset` non-interactively, and the first task needs a manual discover.
- Hook latency is fine: gate.sh 23 ms, others 10-34 ms per call (measured).

## 3. Real-user flow friction

From the frozen plan of a new default task (measured): backend = 7 steps, 11 skills (3 interactive dialogues: brainstorming, grilling, domain-modeling), 2 executors, 5 reviewers (4 required), 3 review gates, 3 required inline tests plus test policy on spec/build/verify; frontend = 15 skills, 6 reviewers (5 required), 5 required tests; even `free` has 3 reviewers and 3 review gates. `SKILL.md` asks for a user "继续" before every transition in interactive mode. Estimate for one small backend change: 70-90 `tenon` invocations (about 22 document record/scaffold, 14 agent prompt/record, 10 test-flow, 6 transitions), 11 skill loads, 7 subagent dispatches, 6+ user replies. The only lighter lane, `simple`, is typo-level, excludes multi-file work (`routing-and-workflows.md`) and runs no tests (`simple.yaml` verify is a skill only). The README lists "every task forced through one heavyweight process" as the problem Tenon solves.

Tests-mandatory tax, reproduced in a 2-file node project: `discover --write` gives one `unit` suite; `test plan --seed` then says the policy needs `integration`, `typecheck` and `regression`. The catalog cannot say "not applicable"; only per-change `waive` (reason, human approval) exists. Delegated acknowledgement is refused while waivers are pending (`SKILL.md` `await-review`), so continuous and AFK stall on an ordinary project. `regression` is really "run unit in full" yet must be a separate kind. Seed also lists 7 placeholder optional tasks.

Simplifications, by payoff:
1. Project-level applicability in the catalog (`not_applicable: [typecheck, integration]`, reviewed once, committed); default policies use `run_if_registered` for `typecheck`/`integration`/`regression` and require only `unit`.
2. `tenon init` runs discover when no catalog exists; `tenon test register <c> --auto` = seed + register every unclaimed test file + widen globs; fix `discover-js.ts:64`.
3. A `standard` lane between simple and default: open, build, verify with one required reviewer, no explore/grilling; pick it from diff risk (file count, contract/auth/dependency paths) measured after Build and escalate on breach, instead of predicting from prompt regex.
4. Batch commands: `document record --all`; one `tenon step run` that scaffolds, records and stamps read receipts.
5. Risk-scoped reviewers (security only when auth/deps/contract paths change).
6. Router fall-through nudge when an implementation-shaped prompt matches no rule.

## 4. Competitive landscape

### 4.1 Summary (second-hand figures approximate)
| Product | Does well | Weak | Overlap |
|---|---|---|---|
| Spec Kit | 30+ agents, 124 extensions, role bundles, non-blocking `converge` drift check | review overload, ignores test results | spec flow |
| OpenSpec 1.13 | delta specs, Stores, `/opsx:verify`, 30+ tools | verify covers specs/tasks, not test evidence | Tenon's doc layer (complement) |
| Kiro | EARS specs, property tests from requirements, hooks, steering | IDE-bound, credit-metered, heavy on small bugs | closest on spec-to-test; no tamper-evident record |
| BMAD 6.x, Superpowers | personas, adaptive ceremony; brainstorm-plan-TDD-review on ~14 hosts | prompt-only, advisory, token-heavy | roles, discipline |
| Trellis | spec injection, tasks, journals, 22 platforms | no dashboard/team features found (unverified) | highest |
| Cursor, Copilot Agent HQ | team/managed hooks, Bugbot, cloud agents, audit logs; Copilot review can approve PRs | closed; Bugbot non-blocking by default; approval without an evidence model | hooks, review |
| Claude Code, Codex | 30+ hook events, plugin allowlists, OTel, Code Review ($15-25/PR, neutral check); blocking hooks, `requirements.toml` | agent teams experimental; Codex has no per-agent tool allowlist | Tenon's hosts and its platform-absorption risk |
| Devin, Factory, Amp, Tessl, review bots, Entire, git-ai, Agent Trace | playbooks, on-prem audit, shared threads, skill registry, PR comments, attribution records | closed or attribution only; nothing tied to a test plan | records layer only |

### 4.2 Tenon's edge and lag
Unique: per-task frozen workflow plans; hook-enforced state machine with real skill provenance; catalog + per-change plan + policy gates + case-level results + traceability, local and hash-chained; one workflow over Claude Code and Codex; multi-user ownership records; a Dashboard about gates and evidence. No competitor found combines requirement-to-case-to-verdict with blocking gates.
Behind: no PR/CI-native surface (Copilot, Bugbot, Code Review meet the reviewer at merge); no cloud/background execution beyond Docker AFK; ecosystem (Spec Kit extensions, Trellis 22 platforms vs 2 hosts); ceremony weight; Windows; hosts are absorbing hooks, review and OTel.
Not verified: Jules, Aider 2026, Factory Droids, Trellis releases/pricing, Spec Kit license, community complaint threads, some prices.

### 4.3 Bets
| # | Bet | Effort | Why now |
|---|---|---|---|
| 1 | Blocking PR/CI check: `tenon verify --ci` replays chain, plan and case verdicts, shipped as a GitHub Action | M | vendor reviews neutral by default |
| 2 | Risk-tiered lanes chosen from the diff after Build | S-M | review overload is the top SDD complaint |
| 3 | Cross-vendor reviewer bound to the diff hash (Claude builds, Codex reviews, verdict signed) | M | reviewers are single-vendor, $15-25 each |
| 4 | Evidence export: Agent Trace, git notes, OTel GenAI, commit trailer | S | Agent Trace backers; both hosts emit OTel |
| 5 | One policy file compiled to Claude managed-settings, Codex `requirements.toml`, Cursor hooks | M | separate admin mechanisms |
| 6 | Test-integrity report: case-count drift, deleted/weakened tests, snapshot rewrites, re-baselining | M | closes 2.3 gaps; unique |
| 7 | Keyed or signed chain (HMAC or sigstore) anchored in git notes | M | plain sha256 today |
| 8 | Evidence Dashboard: gate state, flaky trend, waivers, cost per change | S-M | dashboards elsewhere only orchestrate |
| 9 | Pre-push and CI gate for hosts without hooks (Cursor cloud, Devin) | S | hook parity uneven |
| 10 | Team policy packs (agents, workflows, catalogs) shared via git | M | Spec Kit bundles |

## 5. Roadmap

### P0: before calling it production-ready
| Item | Acceptance |
|---|---|
| P0-1 Host acceptance | `docs/acceptance/2026-10-v0.2-{claude,codex}.md` with commands, screenshots, record paths; two-identity takeover/review/archive; Codex allowlist wording fixed; v02 tasks closed; 1.x deleted or docs reworded; README/release notes match `gh release list` |
| P0-2 Token and read auth | unauthenticated `curl` of `/` and `/api/snapshot` gets 401/403 and no token; e2e green; an agent-side POST cannot acknowledge a review |
| P0-3 Evidence trust root | catalog `command`, known-failures or baseline changes in the diff raise a blocker needing human ack; suite reports must be newer than run start and inside the artifact dir; the 13 bypass probes are blocked or detected at transition; known-failure refs name a case and have capped expiry |
| P0-4 Snapshot scale | 30x30 rebuild p95 under 1.5 s, payload under 1 MB or delta-streamed; CI benches the large fixture with a committed baseline |
| P0-5 Default flow usable | fresh JS repo with only `npm test` completes backend Verify with zero waivers; delegated ack works; discover claims `test/`, `tests/`, `__tests__` |
| P0-6 Platform and PATH | support matrix in `installation.md`; `doctor` red on native Windows or missing `tenon` on PATH; test env prepends the running launcher (fixes R7) |
| P0-7 CI truth | CI-profile baseline committed under a coarser profile id; WebKit job; Node 20/22/24 matrix for reporter tests; `TENON_E2E=1` in the `npm test` step |

### P1: differentiation
Bets 1, 2, 3, 4, 6. Acceptance: a PR carrying a forged record fails the Action; a 3-file bug fix completes on the standard lane in at most 25 CLI calls and 2 user replies; a Codex verdict is rejected when the Claude diff hash changes; Agent Trace/OTel export validates against its spec; deleting a test file or rewriting a snapshot raises a Verify notice. Also `tenon support bundle` (no token, no home path, under 5 MB), a Dashboard log file, and `TENON_LANG=en` for CLI help and errors.

### P2: polish
Bets 5, 7-10; `(unknown)` shown as "no file reported" with name fallback for known failures; TrackDialog on FormDialog; skills references from the orchestration endpoint; one wave calculator; prune host agent files on delete/archive and gitignore generated files; ignore `test-results/`, prune records; agent `validate` rejects placeholders and checks Codex fields; axe in Playwright; `lang` follows locale; remaining uninstall scrubbers; retake screenshots; router false-negative nudge; `merge=union` for the history file and a behind-clone warning on `owner take`; e2e for the 09-15 UI.
