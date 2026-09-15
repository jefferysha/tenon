# Design: per-step test evidence (`09-15-test-evidence`)

> **Parent overrides** (`.trellis/tasks/09-15-tenon-next-capabilities/design.md` §9 wins over this file): X2 your CCR-1 stands; X7 no test direction digests in the freeze lock; X9 `.tenon/` fingerprint exclusion is implemented by multi-user; X10 use multi-user helper names instead of `tenonUserRoot` / `ensureTenonDir`; commands get `TENON_CHANGE_NAME`; builtin direction `design-system` is added by design-resources; X16 default tests; X18.

Binding inputs: parent `prd.md`, `design.md` (§1 terms, §2 identity, §3 layout, §4 YAML, §5 records, §6 execution,
§7 surfaces), `implement.md` (waves, hot files), this child's `prd.md` (R1–R13) and `research/current-test-evidence.md`.
Anything here that deviates from the parent is listed under **Contract change requests**; the parent file is not edited.

All `file:line` citations are against `main` at `2290233c`.

---

## 1. Boundaries

### In scope

| Area | Deliverable |
| --- | --- |
| Kernel | step `tests` schema (types, parse, serialize, compile, validate). Test-direction file codec. Run-record and baseline codecs. Metric evaluation. `evaluateTestEvidence`. Transition integration. Report renderer. `.tenon/` fingerprint exclusion. |
| CLI | `tenon test run \| status \| baseline \| report \| code-size`. Process runner (timeout, process-group kill, bounded log). Input/output collection. `tenon check` integration. Transition rendering. Builtin direction sync on install/update. |
| Server | Test context on the transition route. Snapshot `tests` projection with a candidate cache. SSE fingerprint inputs. Read routes for runs and artifacts. CRUD routes for test directions. |
| Dashboard | 工作流 page 测试 section + test editor drawer. 工作台 测试 sheet + run drawer. 测试方向 list on the Library page. |
| Hooks | PostToolUse nudge (`test-nudge.sh`). `gate.sh` deny for direct edits of records. |
| Templates / skills / docs | 8 builtin directions. Default frontend/backend tests (R10). Minimal skill prose. CLI reference. |
| Removal | Unused verification-evidence composer stack (§10). |

### Out of scope

- CI.
- Coverage platforms.
- Cross-user or cross-machine benchmark comparison.
- The Dashboard starting a test: no route spawns a process.
- Anti-forgery beyond "records are written only by the runner" (§12).
- Migrating the default workflow's other track differences (owned by `data-driven-runner`).
- Reviewer agents reading tests (`review-agents` consumes §5.6).

### Dependencies (wave 2, per parent `implement.md:9`)

`multi-user` must be merged first. It supplies:
- `resolveTenonUser`
- the owner check (R3a of `multi-user/prd.md:31-32`)
- per-user directory creation

`workflow-io-openspec` (wave 1) touches the same step schema and `SheetTabs`; see implement.md merge notes.
`instruction-templates` (wave 1) creates the Library page shell that hosts 测试方向.

---

## 2. Current code facts this design relies on

| Fact | Evidence |
| --- | --- |
| Interactive flow never runs a test or records an exit code; only automation has `command-result` | `kernel/src/verification/types.ts:60-73`; `automation/src/verifier/git-revision-verifier.ts:50-76` |
| Step schema is closed. Structured writes are decoded against `STEP_KEYS`. | `kernel/src/workflow/compile.ts:48-50,201-254`; `compile.ts:365-369` (`decodeWorkflowDef`, used by `POST /api/workflows/:name`, `server/src/serverPostGovernanceRoutes.ts:277`) |
| Narrow YAML parser. No `yaml` dependency. Block fields are read in a loop, so order does not matter. | `kernel/src/workflow/parse.ts:1-6,217-291`; serializer order fixed at `serialize.ts:151-169` |
| Plan fingerprint hashes the whole compiled IR; v3 snapshot stores it verbatim | `kernel/src/workflow/effective-plan.ts:116-133,228-238`; snapshot shape check only needs `name` + `steps` (`state/workflow-plan-snapshot.ts:36-41`) |
| Document evidence is enforced inside the transition before review approval, only on non-backward edges | `kernel/src/workflow/transition-application.ts:329-362`; `document-contract.ts:397-405` |
| `tenon check` renders document blockers as `[FAIL] document:`; `review request` preflights through `cmdCheck` | `cli/src/commands/check.ts:190-215,300-325`; `cli/src/commands/review.ts:125-143,172-173` |
| Workspace fingerprint excludes `test-results`, `playwright-report`, `coverage` at any depth, but not `.tenon` | `kernel/src/workspace/fingerprint.ts:22-37,42-50,86-93` |
| Build token = git HEAD or workspace fingerprint, bound to repository and worktree | `kernel/src/workflow/build-revision.ts:131-163`; CLI capture `cli/src/main.ts:252-261` |
| Step visit identity = `[runId, transitionSequence]` from canonical run metadata | `kernel/src/state/document-step-visit.ts:5-11` |
| Immutable exclusive publish helper | `kernel/src/state/atomic-publish.ts:21-29`; pattern `state/review-attempt-budget-io.ts:83-110` |
| Global roots: `configRoot` = `~/Library/Application Support/tenon/config` on macOS; `TENON_RUNTIME_HOME` relocates it | `kernel/src/product-paths.ts:102-127` |
| Detached spawn + `process.kill(-pid)` + SIGTERM→SIGKILL exists only in Codex triage. No helper streams to a file. | `automation/src/triage/codex-provider.ts:74-127`; `automation/src/runner/boundedTail.ts:10-41` |
| CLI resolves repo root as `process.cwd()`; change dir `<cwd>/openspec/changes/<name>` | `cli/src/main.ts:223`; `cli/src/paths.ts:8-10` |
| Frozen plan for a change is resolved by `effectiveWorkflowForState` | `cli/src/commands/effective-workflow.ts:16-35` |
| Hooks are shared by both hosts. PostToolUse `*` runs pure-bash scripts; soft messages use `{"additionalContext": …}`. | `hooks/hooks.json:37-52`; `hooks/interactive-skill-gate.sh:153-178`; hot-path "no node" rule `hooks/gate.sh:13-21`, asserted `tools/test-hooks.sh:500-517` |
| Command text helpers for Bash-like tools | `hooks/json-input.sh:128,179-184` |
| Snapshot built in `scanAnchoredProject`; SSE pushes only when the input fingerprint changes | `server/src/snapshotProjectScan.ts:118-164`; `server/src/snapshotFingerprint.ts:23-97` |
| Document read route: loopback GET, no token, 256 KB, UTF-8 only. No route serves binary bytes. | `server/src/serverGetDocumentRoutes.ts:7,28-68`; `server/src/serverArtifactRoutes.ts:93-100` (base64 JSON) |
| Workspace IO is a `SheetTabs` pair | `dashboard-app/src/workspace/TaskDetailPane.tsx:54,111-126`; `shared/DetailSheets.tsx:13-73` |
| Workflow editor sections 输入 → 技能 → 输出 → 门禁 → 退回 | `dashboard-app/src/workflow/StageEditorPane.tsx:143-224`; client step decoder `api/governanceSchema.ts:384-413`, type `api/governanceTypes.ts:102-114` |
| Evidence composer is unused, and its output says "Tenon did not run these checks" | `kernel/src/verification/evidence-composer.ts:303-330,372`; route `server/src/serverPostVerificationRoutes.ts:6-71`; client has no caller (`dashboard-app/src/api/client.ts:101-104`) |
| Default verify step skills; `verification_report` output | `templates/workflows/default.yaml:344-399` (frontend), `:493-544` (backend) |
| Installer activation seam used by `setup` and `update` | `cli/src/runtime/installer.ts:41-72`; payload already ships `templates/` (`cli/src/runtime/release-store-codecs.ts:22-35`) |

### Codex `workspace-write` sandbox: verified on this machine

Probe: Codex CLI 0.154.0, macOS seatbelt, built-in `:workspace` profile. The script is a Node program run as
`codex sandbox -P ':workspace' -C <git repo> -- node probe.mjs`.
Results, together with earlier archived evidence:

| Operation inside the sandbox | Result |
| --- | --- |
| Spawn `/bin/sh -c …` from node; SIGTERM the process group (`kill(-pid)`) | works (child exits `SIGTERM` in ~300 ms) |
| Write under cwd (`.tenon/users/u/local/x`) | allowed |
| Write `os.tmpdir()` | allowed |
| Write `.git/*` | `EPERM` (also `archive/2026-09/09-15-v1-1-0-release-e2e/research/e2e-default-workflow-and-codex.md:62,243-244`) |
| Write `$HOME/*` (so also `~/Library/Application Support/tenon/…`) | `EPERM` |
| Read `~/Library/Application Support/tenon/config/*` | allowed |
| `git rev-parse …`, `git config user.email` | allowed |
| `/bin/ps` | `EPERM` (matches `.trellis/spec/kernel/backend/state-lock.md:6-9`) |
| `listen` on 127.0.0.1 | `EPERM` (matches `archive/2026-09/09-12-backend-full-workflow-e2e/live-evidence/project-snapshot/test-results.txt:3`) |
| Outbound TCP connect | `EPERM` |
| Playwright `chromium.launch()` | fails: `Target page, context or browser has been closed` |
| Environment | `CODEX_SANDBOX=seatbelt`, `CODEX_SANDBOX_NETWORK_DISABLED=1` |

**Consequences:**
- `tenon test run` itself works in Codex: it reads config and git, writes `.tenon/`, and spawns.
- Commands that bind ports, reach the network, or launch browsers fail inside the sandbox. That covers most integration tests, Playwright, and e2e.
- Codex `exec_command` accepts `sandbox_permissions` and `justification` (`.trellis/spec/kernel/backend/skill-output-registration.md:287-288`). The skill therefore tells agents to run those tests with `sandbox_permissions: "require_escalated"` (§9).
- The runner detects the sandbox and labels likely denials (§5.3).
- A persistent key cannot live under `stateRoot`, because `$HOME` writes are denied. It lives in the gitignored per-user repo dir (§5.4).

---

## 3. Workflow YAML: step `tests`

### 3.1 YAML (block style, written by the serializer)

```yaml
tracks:
  frontend:
    steps:
      - id: build
        label: 实现
        gate: null
        skills: []
        inputs: []
        outputs: []
        tests:
          - id: unit
            direction: unit
            command: pnpm -C frontend test
            cwd: .
            label: 单测
            timeout_s: 900
            required: true
            keep_runs: 5
            scope: full
            metrics_path: frontend/test-results/bench.json
            pass:
              exit_code: 0
              metrics:
                - name: p95_ms
                  max: 250
                  max_regression_pct: 10
                  better: lower
            inputs:
              - kind: document
                ref: delta-spec
              - kind: file
                path: frontend/fixtures
              - kind: env
                name: DATABASE_URL
              - kind: service
                name: postgres
                url: postgres://localhost:5432
            outputs:
              - path: frontend/test-results/junit.xml
                kind: report
                required: true
        guards: []
        transitions: []
```

**Serializer order** (canonical, parser order-insensitive):
- Step: `id, label, gate, prompt, review_lanes, skills, inputs, outputs, artifacts, tests, guards, transitions`.
- Test item: `id, direction, command, cwd, label, timeout_s, required, keep_runs, scope, metrics_path, pass, inputs, outputs`.

Optional keys are omitted when absent. `tests: []` is written and read back as `[]`, matching the three-state
handling of `artifacts` (`serialize.ts:88-94`).

**Scalars:**
- `command`, `label`, `cwd`, `path`, `url`, `ref`, `name` are written plain when safe.
- Otherwise they are written single-quoted, with `''` escaping. The value is unsafe when it has a leading
  `-?:,[]{}#&*!|>'"%@` or backtick, or contains `: `, ` #`, or leading/trailing space.
- The parser accepts plain or single-quoted values, so exported YAML stays valid for standard YAML tools.

A track branch is the only way to express "适用轨道" (R2). No per-test track predicate: tracks are branches
(`.trellis/spec/kernel/backend/workflow-track-branches.md` §1; user memory item 4).

### 3.2 Definition layer (`kernel/src/workflow/types.ts`)

Keys stay snake_case on the wire, like `SkillRef` (`types.ts:61-69`). No camelCase mapping.

```ts
export type TestInputDef =
  | { readonly kind: 'document'; readonly ref: string }                  // DocumentKind (document-contract-model.ts:7-18)
  | { readonly kind: 'file'; readonly path: string }                      // repo-relative file or directory
  | { readonly kind: 'env'; readonly name: string }                       // ^[A-Za-z_][A-Za-z0-9_]{0,127}$
  | { readonly kind: 'service'; readonly name: string; readonly url?: string }

export type TestOutputKind = 'report' | 'coverage' | 'metrics' | 'trace' | 'screenshot' | 'log' | 'other'
export interface TestOutputDef { readonly path: string; readonly kind?: TestOutputKind; readonly required?: boolean }

export interface TestMetricCriterion {
  readonly name: string                       // ^[A-Za-z0-9_.-]{1,128}$
  readonly max?: number
  readonly min?: number
  readonly max_regression_pct?: number        // 0..1000, vs the acting user's baseline
  readonly better?: 'lower' | 'higher'        // default lower
}

export interface StepTestDef {
  readonly id: string                         // IDENT_RE (validate.ts:32), ≤64, unique per track branch
  readonly direction: string                  // IDENT_RE; the direction it was created from
  readonly command: string                    // one line, 1..2000 UTF-8 bytes, no NUL/CR/LF
  readonly cwd?: string                       // repo-relative dir, default '.'
  readonly label?: string                     // ≤80 chars, one line; display = label ?? id
  readonly timeout_s?: number                 // integer 1..14400, default 900
  readonly required?: boolean                 // default true
  readonly keep_runs?: number                 // integer 1..50, default 5 (R13)
  readonly scope?: 'full' | 'known'           // R9 regression: 全量 / 已知问题
  readonly metrics_path?: string              // JSON metrics file; absent = last JSON-object line of stdout
  readonly pass?: { readonly exit_code?: number; readonly metrics?: readonly TestMetricCriterion[] }
  readonly inputs?: readonly TestInputDef[]   // ≤32
  readonly outputs?: readonly TestOutputDef[] // ≤32
}

export interface StepDef { /* existing fields … */ readonly tests?: readonly StepTestDef[] }
```

### 3.3 IR (`kernel/src/workflow/ir.ts`)

```ts
export interface StepTestIR {
  readonly id: string
  readonly direction: string
  readonly command: string
  readonly cwd: string
  readonly label?: string
  readonly timeout_s: number
  readonly required: boolean
  readonly keep_runs: number
  readonly scope?: 'full' | 'known'
  readonly metrics_path?: string
  readonly pass: {
    readonly exit_code: number
    readonly metrics: readonly (TestMetricCriterion & { readonly better: 'lower' | 'higher' })[]
  }
  readonly inputs: readonly TestInputDef[]
  readonly outputs: readonly (TestOutputDef & { readonly kind: TestOutputKind; readonly required: boolean })[]
}
export interface StepIR { /* existing … */ readonly tests?: readonly StepTestIR[] }
```

- **Key order** is fixed by `compileStepTests`, starting `id, direction, command, cwd` (the hook regex in §9.2 relies on it).
- **`tests` is emitted only when non-empty.** Workflows without tests therefore compile to byte-identical IR, so their
  `workflowFingerprint` and existing bindings do not change (`effective-plan.ts:116-133`; required by
  `workflow-track-branches.md` §3).
- **No `capabilities.tests`.** Consumers read `plan.workflow.steps[i].tests`, which already appears in
  `tenon workflow plan --json` (`cli/src/commands/workflow-plan.ts:81-86`) for `data-driven-runner`.

### 3.4 Validation (compile + validate; same messages in parse where syntactic)

| Rule | Error text (prefix `compileWorkflow: <path>:` or `step '<id>'`) |
| --- | --- |
| Unknown key in a test item, pass, metric, input, output | `出现该变体不接受的附加键 '<k>'（闭集：…）` (reuse `rejectExtraKeys`, `compile.ts:76-82`) |
| `id` / `direction` charset | `测试 id '<id>' 含非法字符（仅允许 a-zA-Z0-9_-）` |
| Duplicate test id within one branch (all steps) | `tracks.<t>: 测试 id '<id>' 在分支内重复（step '<a>' 与 '<b>'）` |
| `command` empty, multi-line, NUL, >2000 bytes | `测试 '<id>' 的 command 必须是 1–2000 字节的单行命令` |
| `cwd`/input `path` absolute, contains `..`, `\`, or empty segment | `测试 '<id>' 的路径 '<p>' 必须是仓库内相对路径` |
| Output `path` / `metrics_path` not under a fingerprint-excluded test dir | `测试 '<id>' 的输出 '<p>' 必须位于 test-results/、playwright-report/ 或 coverage/ 目录下` |
| `timeout_s`, `keep_runs`, `exit_code` (0..255), `max_regression_pct` out of range / not integer | `测试 '<id>' 的 <field> 超出范围 <lo>–<hi>` |
| Metric criterion without any of `max`/`min`/`max_regression_pct` | `测试 '<id>' 的指标 '<name>' 至少需要 max、min 或 max_regression_pct` |
| `document` input `ref` not a `DocumentKind` | `测试 '<id>' 的输入文档类型 '<ref>' 不存在` |
| env name charset; service `url` not `http(s)://` / `postgres://` style `^[a-z][a-z0-9+.-]*://\S+$` | `测试 '<id>' 的输入 '<v>' 非法` |

The output-location rule uses `TEST_OUTPUT_DIR_SEGMENTS = ['test-results', 'playwright-report', 'coverage']`, exported
from `workspace/fingerprint.ts` as a subset of `EXCLUDED_ANY_SEGMENT`. That gives one source of truth, and it keeps
declared outputs from changing the candidate (§5.2).

---

## 4. Test direction library (R1)

### 4.1 Storage

| Location | Owner |
| --- | --- |
| `<configRoot>/test-directions/builtin/<id>.yaml` | rewritten on `tenon setup` / `tenon update` from payload `templates/test-directions/*.yaml` |
| `<configRoot>/test-directions/custom/<id>.yaml` | user; never touched by updates |

`<configRoot>` = `resolveProductPaths().configRoot` (`product-paths.ts:102-160`); tests use `TENON_RUNTIME_HOME`.

### 4.2 File format (same item grammar as §3.1, top-level)

```yaml
id: playwright
label: Playwright
command: npx playwright test
timeout_s: 1800
outputs:
  - path: playwright-report
    kind: report
    required: false
  - path: test-results
    kind: trace
    required: false
```

```ts
export interface TestDirectionDef extends Omit<StepTestDef, 'id' | 'direction' | 'required' | 'keep_runs' | 'label'> {
  readonly id: string        // == file stem, IDENT_RE
  readonly label: string     // required, displayed as is (no translation)
}
parseTestDirection(content: string): TestDirectionDef          // throws `test direction 解析错误：…`
serializeTestDirection(def: TestDirectionDef): string
testFromDirection(dir: TestDirectionDef, existingIds: ReadonlySet<string>): StepTestDef
//   id = dir.id, or `${dir.id}-2`, `-3` … on collision; direction = dir.id; label = dir.label; required = true
```

### 4.3 Builtin set

Every file is a template the user copies or edits.

| id | label | command | timeout_s | extras |
| --- | --- | --- | --- | --- |
| `unit` | 单测 | `npm test` | 900 | — |
| `integration` | 集成 | `npm run test:integration` | 1800 | inputs `env DATABASE_URL`, `service database` |
| `regression` | 回归 | `npm test` | 1800 | `scope: full` |
| `benchmark` | 基准 | `npm run bench` | 1800 | `metrics_path: test-results/benchmark.json`; output same path `kind: metrics` required |
| `playwright` | Playwright | `npx playwright test` | 1800 | outputs `playwright-report` (report), `test-results` (trace), both optional |
| `e2e` | e2e | `npm run test:e2e` | 1800 | output `test-results` (trace) optional |
| `code-size` | 代码规模 | `tenon test code-size --json` | 120 | `pass.metrics: [{ name: lines_added, max: 2000 }]` |
| `typecheck` | 类型检查 | `npm run typecheck` | 600 | — (R10 asks for type check) |

### 4.4 Semantics

A direction is an **authoring template**. When a test is added to a step, the direction's fields are copied into
the step's YAML. The step test is then self-contained, and the frozen plan contains everything that affects
execution.
- Editing or deleting a direction never changes an existing workflow or a running task.
- No reference scan is needed on delete.
- Contract change request CCR-1.

---

## 5. Execution and records

### 5.1 Per-user layout (parent §3 plus additions)

```
<repo>/.tenon/.gitignore                                   # "users/*/local/\n" (CCR-3)
<repo>/.tenon/users/<slug>/
  tests/<change>/<run-id>.json                             # tracked, immutable, schema tenon-test-run-v1
  baselines/<test-id>.json                                 # tracked, schema tenon-test-baseline-v1
  local/                                                   # gitignored
    running/<change>/<test-id>.json                        # live marker {run_id,pid,started_at,deadline_at}
    env.key                                                # 32 random bytes, 0600, created with 'wx'
    artifacts/<change>/<run-id>/output.log
    artifacts/<change>/<run-id>/outputs/<declared path…>   # copies of declared outputs
```

- `run-id` = `YYYYMMDDTHHMMSSZ-<6 hex>` (`^\d{8}T\d{6}Z-[a-f0-9]{6}$`). It sorts by time; separate user directories
  keep different users' files apart.
- Helper: `testEvidencePaths(repoRoot: string, slug: string)` in `kernel/src/test-evidence/paths.ts`. It uses
  `multi-user`'s user-root helper when that exists (merge note).

### 5.2 Candidate and freshness

- **`candidate`** is `fingerprintWorkspace(repoRoot)`, captured **after** the command exits, whatever the isolation
  mode. It covers uncommitted edits, which a git-HEAD token would not.
  - `candidate_before` is captured before spawn.
  - If the two differ, the run records note `workspace-changed`. This is **not** a failure, because build outputs
    such as `dist/` or `target/` legitimately change the tree.
  - The record binds to the tree as it was after the run.
- **`.tenon/` must be excluded from the fingerprint** (add to `EXCLUDED_TOP_LEVEL`, `fingerprint.ts:22-37`). Otherwise
  writing a record would invalidate the candidate. Existing tokens are unaffected, because no repo has `.tenon/` yet
  (CCR-3).
- Declared outputs live under excluded dirs (§3.4), so producing them never changes the candidate or the in-place
  build token.
- **A record is fresh for `(user, change, test)` iff all of these hold:**
  - `record.workflow_run_id === runMetadata.runId`, so a re-created change with the same name never reuses old runs;
  - `record.workflow_fingerprint === plan.workflowFingerprint`;
  - `record.test_digest === testDigest(currentStepTestIR)`;
  - `record.candidate === currentCandidate`.
- `testDigest(t)` = `sha256:` + `sha256Hex(canonicalJson(t))`, with keys sorted recursively.
- `step_visit` and `build_sha` are recorded for display and reports only.

### 5.3 `tenon test run <change> <test-id> [--json]`

**Sequence:**
1. Validate the change name (`isValidChangeName`, `cli/src/paths.ts:13-15`).
2. Read state and reject an archived change.
3. Resolve the frozen plan (`effectiveWorkflowForState`).
4. `resolveTenonUser(cwd)`. Missing → exit 1 with `multi-user`'s setup hint.
5. Owner check (`multi-user` R3a). Not owner → exit 1 with the 接手 hint.
6. Find the test by id in `plan.workflow.steps[*].tests`. Unknown → exit 1: `未声明的测试 '<id>'；可选：<ids|(无)>`.
7. Create the running marker exclusively.
   - If it exists and `deadline_at + 60s` is still in the future → exit 1: `测试 '<id>' 正在运行（run <run-id>，开始于 <t>）`.
   - Otherwise reclaim it. No pid probing: `/bin/ps` and cross-pid `kill` are unreliable in Codex (`state-lock.md` §3).
8. Capture `candidate_before`, `git_head` (optional, 1.5 s timeout) and state `build_sha`.
9. Collect inputs (§5.5).
10. Resolve `cwd`: `realpath(repoRoot/cwd)` must stay inside `realpath(repoRoot)` and be a directory. Otherwise
    record `fail` with reason `cwd-invalid`, without spawning.
11. **Spawn** via `runTestProcess`:
    - Shell: `/bin/sh -c <command>`; on win32, `%ComSpec% /d /s /c`.
    - `detached: true`, stdin `ignore`.
    - Env = `process.env` plus `TENON_CHANGE`, `TENON_TEST_ID`, `TENON_TEST_RUN_ID`, `TENON_TEST_ARTIFACTS=<abs run dir>`
      and `TENON_BASE_BRANCH=<state.base_branch>` (`types.ts:27`).
    - No templating of the command string. No `CI` injection.
12. **Stream** stdout and stderr, interleaved, into `output.log`:
    - Keep the first `MAX_LOG_BYTES = 8 MiB`.
    - After that, keep counting and hold a 1 MiB rolling tail in memory. On exit, append
      `\n[tenon] … <n> bytes omitted …\n` plus the tail.
    - sha256 of the final file.
13. **Timeout** `timeout_s`: SIGTERM the process group; after `GRACE_MS = 10_000`, SIGKILL the group. Reason `timeout`.
14. **Interrupt:** SIGINT, SIGTERM or SIGHUP to `tenon` itself is forwarded to the group, then the same grace applies.
    Reason `interrupted`. Exit code 130.
15. **After exit:**
    - Collect outputs and copy them into artifacts (§5.5).
    - Parse metrics and compare with the baseline (§5.6).
    - Capture `candidate`.
    - Classify (§5.3.1).
    - Publish the record with `atomicLinkPublish` into `tests/<change>/<run-id>.json`.
    - Prune artifacts (§5.7).
    - Remove the marker.
16. **Print** the summary (below). On `fail`, also print the last 4 KiB of the log to stderr. **Exit 0 = pass,
    2 = fail, 1 = usage/environment error** (no record written for exit 1 cases before step 9).

```
[TEST] <change> <test-id> run=<run-id>
  command: <command> (cwd=<cwd>, timeout=<n>s)
  result: pass|fail exit=<code|signal> duration=<s>s
  reasons: <code, …>
  record: .tenon/users/<slug>/tests/<change>/<run-id>.json
  log: .tenon/users/<slug>/local/artifacts/<change>/<run-id>/output.log
```

`--json` prints the record plus `{ "record_path", "log_path" }` on stdout instead.

#### 5.3.1 Result classification

The result is `pass` iff there are no failing reasons.

| Reason | Kind |
| --- | --- |
| `exit-code` (≠ `pass.exit_code`) | failing |
| `command-not-found` (exit 127) | failing |
| `not-executable` (126) | failing |
| `spawn-error` | failing |
| `cwd-invalid` | failing |
| `timeout` | failing |
| `interrupted` | failing |
| `output-missing` (required output absent or invalid) | failing |
| `metric-unreadable` | failing |
| `metric-threshold` | failing |
| `metric-regression` | failing |
| `candidate-unavailable` (fingerprint capture failed twice) | failing |
| `sandbox-denied` | failing, added **alongside** the exit reason |
| `workspace-changed` | note |
| `log-truncated` | note |
| `baseline-missing` | note |
| `baseline-mismatch` | note |

`sandbox-denied` is added when `exit ≠ expected` and `CODEX_SANDBOX` is set **and** the last 64 KiB contains
`Operation not permitted`, `EPERM`, `sandbox-exec`, or `Target page, context or browser has been closed`.
The CLI then adds this line to stderr: `可能被宿主沙箱拦截：Codex 中用 sandbox_permissions=require_escalated 重新执行 tenon test run <change> <id>`.

### 5.4 Record schema (tracked, `.tenon/users/<slug>/tests/<change>/<run-id>.json`)

```ts
export interface TestRunRecordV1 {
  readonly schema: 'tenon-test-run-v1'
  readonly run_id: string
  readonly change: string
  readonly workflow_run_id: string
  readonly workflow: string
  readonly workflow_fingerprint: string                  // 64 hex
  readonly track: string
  readonly step: string                                  // step that declares the test
  readonly step_visit: { readonly run_id: string; readonly transition_sequence: number }  // current visit at run time
  readonly test_id: string
  readonly test_digest: string                           // sha256:<hex>
  readonly direction: string
  readonly label?: string
  readonly command: string
  readonly cwd: string
  readonly timeout_s: number
  readonly required: boolean
  readonly actor: { readonly id: string; readonly name: string; readonly trust: 'declared' }
  readonly host: { readonly kind: 'claude-code' | 'codex' | 'terminal'; readonly sandbox: string | null }
  readonly candidate_before: string | null               // workspace:sha256:<hex>
  readonly candidate: string | null
  readonly git_head: string | null
  readonly build_sha: string | null
  readonly started_at: string
  readonly finished_at: string
  readonly duration_ms: number
  readonly exit_code: number | null
  readonly signal: string | null
  readonly result: 'pass' | 'fail'
  readonly reasons: readonly { readonly code: TestRunReasonCode; readonly detail?: string }[]  // detail ≤200 chars, no output text
  readonly inputs: readonly TestInputRecord[]
  readonly outputs: readonly TestOutputRecord[]
  readonly metrics: readonly TestMetricRecord[]
  readonly log: { readonly artifact: 'output.log'; readonly bytes_total: number; readonly bytes_kept: number; readonly truncated: boolean; readonly digest: string }
}
export type TestInputRecord =
  | { readonly kind: 'document'; readonly ref: string; readonly present: boolean; readonly entries: readonly { readonly path: string; readonly digest: string }[] }
  | { readonly kind: 'file'; readonly path: string; readonly present: boolean; readonly digest: string | null; readonly files: number }
  | { readonly kind: 'env'; readonly name: string; readonly present: boolean; readonly digest: string | null }   // hmac-sha256 with local/env.key
  | { readonly kind: 'service'; readonly name: string; readonly url?: string }
export interface TestOutputRecord {
  readonly path: string; readonly kind: TestOutputKind; readonly required: boolean
  readonly present: boolean; readonly digest: string | null; readonly bytes: number; readonly files: number
  readonly artifact: string | null        // run-dir relative copy path, null when not copied
}
export interface TestMetricRecord {
  readonly name: string; readonly value: number | null; readonly baseline: number | null; readonly delta_pct: number | null
  readonly max?: number; readonly min?: number; readonly max_regression_pct?: number; readonly better: 'lower' | 'higher'
  readonly ok: boolean
}
decodeTestRunRecord(value: unknown): TestRunRecordV1 | undefined        // closed keys; undefined = corrupt
```

**Host detection:**
- `codex` if `CODEX_SANDBOX` or `CODEX_THREAD_ID` is set.
- `claude-code` if `CLAUDECODE=1`.
- `terminal` otherwise.
- `sandbox` = `CODEX_SANDBOX` value, or `null`.

### 5.5 Inputs, outputs, artifacts

**Inputs:**
- **document:** records of that kind from `.pipeline-documents.json` (`state/document-ledger.ts:43-70`), each with the
  file's current digest (`resolveDocument`, `document-evidence.ts:130-136`). No record → `present: false`.
- **file:** `lstat`, without following symlinks.
  - A file gives `sha256:`.
  - A directory gives a manifest digest over sorted `relpath\0size\0sha256` entries, capped at 5000 files; beyond
    that, `digest: null` with detail.
  - Missing → `present: false`.
- **env:** `present` plus `hmac-sha256(local/env.key, name\0value)`. The key is created with `wx` and mode 0600.
  If it cannot be created, `digest: null`.
- **service:** recorded as declared. No probe, since network access is denied in Codex anyway.

Inputs are recorded, never gated.

**Outputs:** `lstat` each path, and reject symlinks or anything whose realpath escapes the repo.
- File → digest. Directory → manifest digest.
- Copy into `artifacts/<change>/<run-id>/outputs/<path>` without following symlinks. Per file ≤ 64 MiB;
  per run ≤ 256 MiB total. Past a cap → `artifact: null`.
- A required output that is absent or invalid → `output-missing`.

### 5.6 Metrics and baselines (R9)

**Metric source:**
- `metrics_path` file (≤ 1 MiB), or
- the last stdout line of the kept log that parses as a JSON object.

Nested objects are flattened with `.`. Only finite numbers are kept, at most 200 metrics. If criteria are declared
but the source is missing or invalid → `metric-unreadable`.

**Criteria:**
- `max` / `min` are absolute → `metric-threshold`.
- `max_regression_pct` compares with the acting user's baseline:
  - `delta_pct = (value - base) / |base| * 100`, sign flipped when `better: higher`.
  - Fail if `delta_pct > max_regression_pct` → `metric-regression`.
  - No baseline → note `baseline-missing`, no failure.
  - Baseline recorded with a different `command` or `cwd` → note `baseline-mismatch`, no comparison.

```ts
export interface TestBaselineV1 {
  readonly schema: 'tenon-test-baseline-v1'
  readonly test_id: string
  readonly command: string
  readonly cwd: string
  readonly metrics: Readonly<Record<string, number>>
  readonly source: { readonly change: string; readonly run_id: string }
  readonly actor: { readonly id: string; readonly name: string; readonly trust: 'declared' }
  readonly updated_at: string
  readonly history: readonly Omit<TestBaselineV1, 'schema' | 'test_id' | 'history'>[]  // previous entries, newest first, ≤20
}
```

`tenon test baseline <change> <test-id> --run <run-id>`:
- Reads the acting user's record, which must be `pass` and have metrics.
- Moves the current baseline into `history`, then writes the new one via `atomicReplaceFile`.
- Prints `[BASELINE] <test-id> <n> 项指标 ← run <run-id>`.

The history array plus git history of the tracked file are the audit trail. Baselines are per user by construction.

### 5.7 Retention (R13)

After publishing, list `artifacts/<change>/*` directories whose record has `test_id` = this test (acting user only).
Keep the newest `keep_runs` by `run_id` and remove older run directories. Summaries are never deleted. The server
reports artifact availability by checking the directory at read time.

### 5.8 Guard evaluation

```ts
// kernel/src/test-evidence/evaluate.ts
export type TestItemStatus = 'passed' | 'failed' | 'stale' | 'missing' | 'running'
export interface TestEvidenceContext {
  readonly user: { readonly id: string; readonly name: string; readonly slug: string }
  readonly currentCandidate: () => Promise<string>
  readonly now?: () => number
}
export interface TestEvidenceItem {
  readonly test: StepTestIR
  readonly status: TestItemStatus
  readonly run?: TestRunRecordV1          // latest record for (user, change, test, workflow_run_id)
  readonly staleBecause?: 'candidate' | 'declaration' | 'workflow'
}
export interface TestEvidenceReport { readonly stepId: string; readonly pass: boolean; readonly blockers: readonly string[]; readonly items: readonly TestEvidenceItem[] }

export async function evaluateTestEvidence(input: {
  readonly repoRoot: string
  readonly changeDir: string
  readonly changeName: string
  readonly plan: EffectiveWorkflowPlan
  readonly stepId: string
  readonly context: TestEvidenceContext | undefined
}): Promise<TestEvidenceReport>
export async function listTestRuns(repoRoot: string, changeName: string, filter?: { readonly slug?: string; readonly testId?: string }): Promise<readonly { readonly slug: string; readonly record: TestRunRecordV1 }[]>
export async function latestTestRun(repoRoot: string, changeName: string, slug: string, testId: string, workflowRunId: string): Promise<TestRunRecordV1 | undefined>
export function testDigest(test: StepTestIR): string
```

**Rules:**
- The step has no tests → `pass: true`, no I/O.
- `context` is undefined while tests are declared → one blocker: `测试证据无法验证：宿主未提供用户身份或工作区指纹`
  (fail closed).
- **Only the acting user's records are read** (CCR-6). Other users' runs appear only in history.
- Corrupt JSON is ignored, so the test counts as `missing`. The server snapshot lists corrupt files under `diagnostics`.
- **Status:**
  - `running` if a live marker exists (`deadline_at + 60s > now`);
  - otherwise from the latest record: fresh + `pass` → `passed`; fresh + `fail` → `failed`; not fresh → `stale`;
  - none → `missing`.
- **Blockers (required tests only):**

  | Status | Blocker text |
  | --- | --- |
  | `failed` | `测试 <label>（<id>）失败：<reason codes>；执行 tenon test run <change> <id>` |
  | `stale` | `测试 <label>（<id>）过期：<代码已变化 \| 测试声明已变化 \| 工作流已变化>；执行 tenon test run <change> <id>` |
  | `missing` | `测试 <label>（<id>）未运行；执行 tenon test run <change> <id>` |
  | `running` | `测试 <label>（<id>）运行中` |

  A failed record whose reasons include `sandbox-denied` gets the suffix `（Codex 中以 sandbox_permissions=require_escalated 执行）`.

### 5.9 Enforcement points

| Point | Change |
| --- | --- |
| Transition (CLI + server) | `transition-application.ts`: after document evidence (`:329-362`) and before the review receipt (`:363-381`). Evaluate when the step being left has tests **and** the edge is not backward (same predicate as `shouldEnforceDocumentPolicyOnTransition`, `document-contract.ts:397-405`, computed over `plan.workflow.steps` order). This includes the implicit `archived` edge. New deps field `testEvidence?: TestEvidenceContext`. New result `{ kind: 'test-evidence-failed'; stepId: string; blockers: readonly string[] }` in `transition-application-types.ts:70-122`. |
| CLI transition render | `cli/src/commands/transition.ts` next to `document-evidence-failed` (`:281-284`): `  - <blocker>` lines, exit 1. |
| Server transition | `server/src/transition.ts:241-262`: pass `testEvidence` (identity via `resolveTenonUser(root)`, candidate via the existing `workspaceFingerprint(root, name)`). Map `test-evidence-failed` to the same HTTP status as `document-evidence-failed`. |
| `tenon check` | `check.ts` default path (`:183-215`) and `checkGraphWorkflow` (`:300-325`): `  [FAIL] test: <blocker>`, counted in the total, exit 2. |
| `tenon review request` | Covered through `cmdCheck` (`review.ts:125-143`); `verify-fail` readiness (`review.ts:79-123`) is backward and does not evaluate tests. |

---

## 6. CLI surface

```ts
// packages/cli/src/program-tests.ts
export function registerTestCommands(program: Command, deps: CliDeps): void   // called from program.ts next to registerReviewCommands (program.ts:172)

// packages/cli/src/commands/test-run.ts
export async function cmdTestRun(deps: CliDeps, change: string, testId: string, opts: { readonly json?: boolean }): Promise<number>
// packages/cli/src/commands/test-status.ts
export async function cmdTestStatus(deps: CliDeps, change: string, opts: { readonly step?: string; readonly json?: boolean }): Promise<number>
// packages/cli/src/commands/test-baseline.ts
export async function cmdTestBaseline(deps: CliDeps, change: string, testId: string, opts: { readonly run: string }): Promise<number>
// packages/cli/src/commands/test-report.ts
export async function cmdTestReport(deps: CliDeps, change: string, opts: { readonly step?: string; readonly write?: string; readonly locale?: 'zh-CN' | 'en' }): Promise<number>
// packages/cli/src/commands/test-code-size.ts
export async function cmdTestCodeSize(deps: CliDeps, opts: { readonly base?: string; readonly json?: boolean }): Promise<number>

// packages/cli/src/test-runner/process.ts
export interface TestProcessRequest {
  readonly command: string; readonly cwd: string; readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number; readonly graceMs: number
  readonly logPath: string; readonly maxLogBytes: number; readonly tailBytes: number
  readonly signal?: AbortSignal
}
export interface TestProcessOutcome {
  readonly exitCode: number | null; readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean; readonly interrupted: boolean; readonly spawnError?: string
  readonly startedAt: string; readonly finishedAt: string; readonly durationMs: number
  readonly log: { readonly bytesTotal: number; readonly bytesKept: number; readonly truncated: boolean; readonly sha256: string }
  readonly tail: string   // last 64 KiB, in memory only
}
export function runTestProcess(req: TestProcessRequest): Promise<TestProcessOutcome>
// packages/cli/src/test-runner/collect.ts
export async function collectTestInputs(repoRoot: string, changeDir: string, test: StepTestIR, envKeyPath: string): Promise<readonly TestInputRecord[]>
export async function collectTestOutputs(repoRoot: string, test: StepTestIR, runDir: string): Promise<readonly TestOutputRecord[]>
// packages/cli/src/testEvidenceContext.ts
export function testEvidenceContextFor(deps: CliDeps): TestEvidenceContext | undefined
```

**`CliDeps` additions** (`cli/src/deps.ts:139-320`):
- `testProcess?: typeof runTestProcess` (injection for unit tests).
- `resolveUser` comes from `multi-user`.
- The existing `workspaceFingerprint` (`main.ts:252`) is reused.

| Command | Output | Exit |
| --- | --- | --- |
| `tenon test run <change> <test-id> [--json]` | §5.3 | 0 / 2 / 1 |
| `tenon test status <change> [--step <id>] [--json]` | text: `[TEST] <change> step=<id>` + `  <状态词> <id> <label> <duration> <finished_at>` per test + blockers; JSON: `{ change, step, pass, items:[{ id, label, direction, required, status, run?:{ run_id, result, finished_at, duration_ms, reasons } }], blockers }` | 0 when pass, 2 when blockers, 1 errors |
| `tenon test baseline <change> <test-id> --run <run-id>` | §5.6 | 0 / 1 |
| `tenon test report <change> [--step <id>] [--write <path>] [--locale zh-CN\|en]` | Markdown region (§8) to stdout, or replaced in `<path>` (repo-relative existing regular file) | 0 / 1 |
| `tenon test code-size [--base <ref>] [--json]` | `{ "files_changed", "lines_added", "lines_deleted", "largest_added_lines" }`. Git read-only: `git diff --numstat <merge-base(HEAD, base)>` plus line counts of `git ls-files --others --exclude-standard` (≤ 5000 files, ≤ 1 MiB each). `base` = `--base` → `$TENON_BASE_BRANCH` → `HEAD`. | 0 / 1 |

`tenon test` without a subcommand prints usage and exits 1, like `document` (`program.ts:126-132`).

---

## 7. Server

### 7.1 Snapshot projection

Types (`server/src/types.ts:37-80`, mirrored in `dashboard-app/src/types.ts` and `api/snapshotDecoder.ts`):

```ts
export interface TestStepSnapshot { stepId: string; items: TestItemSnapshot[] }
export interface TestItemSnapshot {
  id: string; label?: string; direction: string; required: boolean
  status: 'passed' | 'failed' | 'stale' | 'missing' | 'running'
  run?: {
    runId: string; user: string; actor: { id: string; name: string }; result: 'pass' | 'fail'
    exitCode: number | null; durationMs: number; finishedAt: string; reasons: string[]
  }
}
// ChangeSnapshot.tests?: TestStepSnapshot[]        (omitted when the branch declares no tests)
// ChangeSnapshot.testDiagnostics?: string[]        (corrupt record file names, ≤20)
```

- **Projector:** `server/src/testEvidenceSnapshot.ts` →
  `projectTestEvidence(input: { root; changeDir; changeName; plan; user; candidate: () => Promise<string | undefined> }): Promise<{ tests?: TestStepSnapshot[]; diagnostics?: string[] }>`.
  - Calls `evaluateTestEvidence` for every step of the change's branch.
  - Wired into `Promise.all` at `snapshotProjectScan.ts:118-124` and the object at `:138-164`.
  - `readChangeSnapshot` (`changeSnapshot.ts:276-384`) is left alone (single caller is orchestration).
- **Candidate cache:** `server/src/testCandidateCache.ts` →
  `createCandidateCache(fingerprint: (root: string) => Promise<string>, ttlMs = 5000): (root: string) => Promise<string | undefined>`.
  - In-flight de-duplication.
  - Called only for roots with at least one non-archived change that has records.
  - An error yields `undefined`, which projects fresh-looking records as `stale`.
- **SSE fingerprint:** `snapshotFingerprint.ts:66-78` adds per change `lstat` size and mtime of
  `.tenon/users/*/tests/<change>` and `.tenon/users/*/local/running/<change>`, so new runs push.

### 7.2 Routes

All GET routes are loopback-only, need no token, validate `root` through `workflowRootForRequest`
(`serverGovernance.ts:193-219`), and return JSON errors `{ ok:false, error }`.

| Route | Params / body | 200 | Errors |
| --- | --- | --- | --- |
| `GET /api/tests/runs` | `root`, `change` (`^[A-Za-z0-9_-]+$`), `test` (IDENT) | `{ ok, runs: [{ user, runId, result, exitCode, durationMs, finishedAt, actor, reasons, artifacts: boolean }] }` newest first, ≤50, all users | 400 params, 404 root/change |
| `GET /api/tests/run` | `root`, `change`, `user` (`^[a-z0-9._-]{1,128}$`), `run` (run-id regex) | `{ ok, record: TestRunRecordV1, artifacts: { log: boolean, files: string[] } }` (`files` = copied output paths present on disk) | 400, 404, 422 corrupt |
| `GET /api/tests/artifact` | `root`, `change`, `user`, `run`, `path` (run-dir relative posix, no `..`/absolute/backslash), optional `tail` (1..1048576) | raw bytes (streamed); `tail` returns the last N bytes | 400, 403 symlink/escape, 404, 413 > 64 MiB |
| `GET /api/test-directions` | — | `{ ok, directions: [{ id, label, source: 'builtin'\|'custom', yaml, definition: TestDirectionDef }] }` sorted builtin first, then id | 500 fs |
| `PUT /api/test-directions/:id` | token (same checks as `serverMutationRoutes.ts:311-317`), text body ≤64 KB YAML | `{ ok, direction }` | 400 parse/validate or id ≠ `:id`, 401, 409 builtin id |
| `DELETE /api/test-directions/:id` | token | `{ ok }` | 401, 404, 409 builtin |

**Artifact content types** (allowlist by extension):

| Extension | Served as |
| --- | --- |
| `.png` `.jpg` `.jpeg` `.webp` | `image/*` |
| `.zip` | `application/zip` + `Content-Disposition: attachment` |
| `.json` | `application/json` |
| everything else | `text/plain; charset=utf-8` |

Every artifact response carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`.
Files are opened with `O_NOFOLLOW` after an `lstat` regular-file check, and the realpath is contained in
`<repo>/.tenon/users/<user>/local/artifacts/<change>/<run>/` (pattern: `contextBundleTrustedReader.ts:107-142`).

**Files:**
- `server/src/serverGetTestRoutes.ts`, chained into `serverGetRoutes.ts:116-396`.
- `server/src/serverTestDirectionRoutes.ts`, with GET in the GET chain and PUT/DELETE in `serverMutationRoutes.ts:124,303`.

**Removal:** `POST /api/verification-evidence/compose` (§10).

---

## 8. Verification report tests section (R12)

```ts
// kernel/src/test-evidence/report.ts
export function renderTestsRegion(input: {
  readonly changeName: string
  readonly locale: 'zh-CN' | 'en'
  readonly items: readonly (TestEvidenceItem & { readonly stepId: string; readonly stepLabel: string })[]
}): string
export function replaceTestsRegion(markdown: string, region: string, locale: 'zh-CN' | 'en'): string
```

**Region:**

```markdown
<!-- tenon:tests:start digest=sha256:<hex of rendered body> -->
| 阶段 | 测试 | 方向 | 状态 | 退出码 | 耗时 | 执行人 | 时间 | 候选 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 实现 | 单测 `unit` | unit | 通过 | 0 | 12.3s | A | 2026-09-15T10:15:30Z | `workspace:sha256:ab12…` |
### 失败
- `e2e`：exit-code, sandbox-denied — `.tenon/users/a-at-x.com/tests/c/<run>.json`
### 命令
- `unit`：`pnpm -C frontend test`（cwd `.`）
<!-- tenon:tests:end -->
```

**Content:**
- Rows: every test of the branch from the first step through `--step` (default: current phase), in step order,
  using the acting user's latest record and status.
- Missing, stale and running tests appear with their status word.
- `en` uses English column headers.

**`--write`:**
- Replaces an existing region.
- Otherwise it appends `\n## 测试\n\n<region>\n` (`## Tests` for `en`). This fills the `results` / `commands` /
  `failures` intent of `templates/documents/registry.v1.yaml:15`, without touching scaffold creation.

The skill runs it before `tenon document record … verification-report` (§9.3). No guard compares the region with
the records; the digest comment exists for later audit (decision D10).

---

## 9. Hosts: hooks, sandbox, skill prose

### 9.1 Codex sandbox policy

`tenon test run` needs nothing Codex denies (verified in §2). The spawned command inherits the sandbox. The tenon
skill states this rule:

- Run `unit` / `typecheck` / `code-size` normally.
- For `integration`, `playwright`, `e2e`, or any test that binds a port, uses the network, or launches a browser,
  call `exec_command` with `sandbox_permissions: "require_escalated"` and a `justification`. `prefix_rule`
  `["tenon","test","run"]` may be proposed so the approval sticks.
- A record with `sandbox-denied` is rerun escalated.
- When approvals are disabled (`approval_policy=never`), the required test stays failed and the transition stays
  blocked. That is the honest outcome.

Claude Code: long tests (> 10 min) should use the Bash tool's background mode. An interrupted runner still writes an
`interrupted` record (§5.3 step 14).

### 9.2 Nudge hook `hooks/test-nudge.sh` (PostToolUse `*`, pure bash, fail-open)

1. Read stdin, then `pipeline_json_is_command_tool "$tool"` (`json-input.sh:179-184`); otherwise exit 0.
   Command text comes from `pipeline_json_get_command` (`:128`). Commands containing `tenon test ` → exit 0.
2. Resolve project root and the active change with the existing resolvers (`hooks/active-change.sh`, or
   `multi-user`'s per-user resolver after merge). None → exit 0.
3. Plan file `<changeDir>/.pipeline-workflow-plan.json` must be a regular, non-symlink file of ≤1 MiB, else exit 0.
   Scan it with a bash `[[ =~ ]]` loop for
   `"id":"([A-Za-z0-9_-]{1,64})","direction":"[A-Za-z0-9_-]{1,64}","command":"((\\.|[^"\\])*)"`.
   Unescape `\"` and `\\`.
4. If the whitespace-collapsed executed command contains a declared command, collect that test id. Print once:
   `{"additionalContext":"<tenon-test-nudge>命令对应测试 <ids>；自行运行不计入登记，执行 tenon test run <change> <id></tenon-test-nudge>"}`
   (JSON-escaped with `pipeline_json_escape`, `json-input.sh:186`). Exit 0.
5. No node, jq or python. The existing no-interpreter assertions are extended to this script.

Registration: add `{ "type": "command", "command": "bash \"${HOME}/.local/bin/tenon-hook\" test-nudge", "timeout": 5 }` to
the PostToolUse `*` block (`hooks/hooks.json:45-52`).

### 9.3 Record write guard (`hooks/gate.sh`, PreToolUse)

- Claude `Write|Edit|MultiEdit|NotebookEdit` `file_path`, or Codex `apply_patch` raw input containing
  `*** (Add|Update|Delete) File: `, whose target path contains `.tenon/users/` **and** `/tests/` or `/baselines/`
  → exit 2 with `测试记录与基线只能由 tenon test run / tenon test baseline 写入`.
- This is a `case` pattern placed before existing marker logic, with no node. Shell redirection is not detected
  (§12).

### 9.4 Skill prose (minimal, interim until `data-driven-runner` rewrites skills)

| File | Change |
| --- | --- |
| `skills/tenon/SKILL.md` | New section `## 测试（硬规则）` after `:198-204`. Declared tests are run only via `tenon test run <change> <id>`. Read `tenon test status <change> --json` before `tenon check`. §9.1 Codex escalation. Run `tenon test report <change> --write <report>` before recording the verification report. Hand-written or self-reported results do not count. |
| `skills/tenon-build/SKILL.md:285-293` | Keep local type/test/lint loops; add "离开 build 前 `tenon test status` 必须通过". |
| `skills/tenon-verify/SKILL.md:104-111` | "Repo-zero-output barrier" allows declared outputs under `test-results/`, `playwright-report/`, `coverage/` (they are fingerprint-excluded). The report tests section comes from `tenon test report`. |

---

## 10. Compatibility and removals

- **Existing workflows and changes:** no `tests` → IR, fingerprints and frozen snapshots are byte-identical. No guard
  fires. Changes frozen before this feature never get tests, even if the global workflow later adds them (the
  snapshot IR wins, `effective-plan.ts:367-384`).
- **Fingerprint:** adding `.tenon` to `EXCLUDED_TOP_LEVEL` changes nothing for trees without `.tenon/`. If
  `multi-user` already added it, the commit is skipped.
- **Default workflow (R10), `templates/workflows/default.yaml`:**

  | Branch | Step | Tests |
  | --- | --- | --- |
  | frontend | build (`:344-369`) | `typecheck` (`npm run typecheck`), `unit` (`npm test`) |
  | frontend | verify (`:370-399`) | `playwright` (`npx playwright test`, outputs `playwright-report` report + `test-results` trace, optional) |
  | backend | build (`:493-518`) | `unit` (`npm test`) |
  | backend | verify (`:519-544`) | `integration` (`npm run test:integration`) |

  - All four are `required: true`. chat, pm and free get no tests.
  - Non-npm projects edit the default: it is editable and stored as a global override.
  - `default-workflow.generated.ts` is regenerated by the main session after merge (parent `implement.md:21-22`).
  - `check:default-skill-matrix` compares skills only, so it is unaffected.
- **Removed** (unused, and superseded by record-generated reports; semantics conflict at
  `evidence-composer.ts:306,319`):

  | Package | Removed |
  | --- | --- |
  | kernel | `verification/evidence-composer.ts`, its test, and its re-export in `verification/index.ts` |
  | server | `serverPostVerificationRoutes.ts`, its import at `serverPostRoutes.ts:78` and mount at `:196`, and the `server.test.ts:2121-2270` describe block |
  | dashboard | `api/verificationEvidenceClient.ts`, `api/verificationEvidenceTypes.ts`, `api/verificationEvidenceDecoders.ts`, `api/verificationEvidenceClient.test.tsx`, the re-exports at `api/client.ts:101-104,180-187`, and the stale comment at `i18n/i18n.test.tsx:192` |

  `VerificationResult` / `EvidenceRef` (`verification/types.ts`) stay, because automation uses them. Historical docs
  under `docs/superpowers/` stay untouched.
- **Docs:** `docs/usage/cli-reference.md` and `docs/usage/zh-CN/cli-reference.md` gain `tenon test`.
- **Task deletion (`task-delete-archive`):** physical delete must also remove `.tenon/users/*/tests/<change>/` and
  `.tenon/users/*/local/{artifacts,running}/<change>/`. A name reuse without deletion is harmless
  (`workflow_run_id` filter).

---

## 11. Dashboard

Wording: one word per concept, no sentences except errors, nothing wraps (`whitespace-nowrap`, truncation). Names
render `label ?? id`; builtin direction labels ship in YAML and are never translated.

### 11.1 工作流 page: 测试 section

Section order in `StageEditorPane` (`workflow/StageEditorPane.tsx:143-224`):
**输入 → 技能 → 输出 → 测试 → 门禁 → 退回**. `review-agents` inserts its sections separately (merge note).

| Component (new) | Contract |
| --- | --- |
| `workflow/TestsSection.tsx` | `SectionHead` (`StageEditorPane.tsx:36-46`): title `测试`, mono count, `+` (`wb-tests-add`) opening a `MenuButton` of directions (`wb-tests-direction-<id>`, `label`). Table `wb-tests` with columns 名称 · 方向 · 命令 · 必需 (lock-free check icon). Row `wb-test-<id>` opens the drawer. An empty table renders the header row only. |
| `workflow/TestEditorDrawer.tsx` | `shared/Drawer.tsx` (560px). Fields, one label each: 名称 `wb-test-label`, 方向 (read-only chip), 命令 `wb-test-command`, 目录 `wb-test-cwd`, 超时 `wb-test-timeout`, 必需 `wb-test-required` (switch), 保留 `wb-test-keep`, 范围 `wb-test-scope` (无/全量/已知), 退出码 `wb-test-exit`, 指标文件 `wb-test-metrics-path`. 指标 table (名称 · 上限 · 下限 · 退化 · 更优 越低/越高, `+`). 输入 table (类型 · 值, `+`). 输出 table (路径 · 类型 · 必需, `+`). 删除 with inline confirm (`wb-test-delete`). Esc closes without applying; 应用 writes to the draft. |
| `workbench/workbenchDefinition.ts` | `setStepTestsInDef(def, branch, stepId, tests: WbStepTest[]): WbWorkflowDef` (pattern `setStepSkillsInDef`, `:177-179`); `testFromDirection(direction, existingIds)` (client mirror of kernel §4.2). |
| `workbench/useWorkflowEditor.ts` | `setTests(stepId: string, tests: WbStepTest[]): void` next to `setSkills` (`:355-357`). |
| `api/governanceTypes.ts` | `WbStepTest` (= `StepTestDef` shape), `WbStepDef.tests?: WbStepTest[]` (`:102-114`). |
| `api/governanceSchema.ts` | `decodeStepTest` + `decodeStep` spread `tests` when present (`:384-413`). |
| `workflow/lint.ts` | `test-id-duplicate`, `test-output-location`, `test-command-empty` block save (same messages as §3.4, rendered through `formatApiError`-style keys). |
| `api/testDirectionsClient.ts` | `fetchTestDirections()`, `putTestDirection(id, yaml)`, `deleteTestDirection(id)`. |

### 11.2 Library page: 测试方向

`library/TestDirectionsPane.tsx`, mounted in the Library page shell from `instruction-templates`:
- **List:** `lib-dir-<id>`: `label` · mono id · lock icon for builtin.
- **Actions:** `+` 新建 (`lib-dir-new`), 复制 (`lib-dir-copy-<id>`: builtin or custom → custom with id `<id>-copy`),
  删除 (`lib-dir-delete-<id>`, custom only, inline confirm).
- **Detail:** YAML `<textarea>` (`lib-dir-yaml`, read-only for builtin) plus a preview table from the server's parsed
  `definition` (命令 · 目录 · 超时 · 输入 n · 输出 n), and 保存 (`lib-dir-save`).
- **Errors** come from the server's 400 body. Writes are disabled without a token (same rule as the workflow page,
  component-guidelines "Save is blocked while … no write credential").

### 11.3 工作台: 测试 sheet

`TaskDetailPane.tsx:111-126`:
- The sheet union becomes `'inputs' | 'outputs' | 'tests'`.
- The 测试 tab `task-io-tab-tests` appears only when `change.tests?.find(s => s.stepId === selectedStep)` has items.
- Its count is `passed/total` (requires `SheetTabs.count: number | string`, shared with `workflow-io-openspec`'s
  `输出 n/m`).

| Component (new) | Contract |
| --- | --- |
| `workspace/stageTests.ts` | `stageTestRows(change, stepId): TestRow[]`; `testStatusWord(status, t)`. Status words: 通过 / 失败 / 过期 / 未运行 / 运行中. `TestRow = { id, name, direction, required, status, durationMs?, finishedAt?, actorName?, run? }`. |
| `workspace/StageTestsPanel.tsx` | Rows `stage-test-<id>` with `data-status`: 名称 · status word (tone via `StatusPill`) · 耗时 · 时间 · 执行人. Required tests carry a small lock-less dot `stage-test-required-<id>`. Click opens `TestRunDrawer`. |
| `workspace/TestRunDrawer.tsx` | `Drawer`. Header: 名称 + status word. Sections: 输入 (类型 · 值 · 摘要 short), 输出 (路径 · 大小 · 打开 when `artifact`), 日志 (`打开` → `<pre>` of `GET /api/tests/artifact?…&path=output.log&tail=262144`), 截图 (inline `<img>` for image outputs inside copied dirs), trace (`<a download>` for `.zip`), 历史 (`GET /api/tests/runs`: 时间 · 执行人 · 结果 · 耗时, row selects that run). Missing local artifacts render `—`. |
| `api/testEvidenceClient.ts` | `fetchTestRuns(root, change, testId)`, `fetchTestRun(root, change, user, run)`, `testArtifactUrl(root, change, user, run, path, tail?)`. |
| `api/snapshotDecoder.ts` | `decodeTests` (pattern `decodeSkillRuns`, `:56-72`); an invalid present value rejects the change as today (`:197-203`). |

**i18n** (`i18n/translations.ts`, zh + en): no `*_note|*_desc|*_lead|*_hint` keys.

| Namespace | Keys |
| --- | --- |
| `workspace.*` | `tests`, `test_status_{passed,failed,stale,missing,running}`, `test_{duration,time,actor,inputs,outputs,log,screenshot,trace,history,open}`, `test_reason_<code>` for every §5.3.1 code |
| `workflow.*` | `tests_title`, `test_{label,direction,command,cwd,timeout,required,keep,scope,scope_full,scope_known,exit_code,metrics,metrics_path,metric_max,metric_min,metric_regression,metric_better,better_lower,better_higher,inputs,outputs,input_kind_*,output_kind_*,delete,apply}` |
| `library.*` | `test_directions`, `direction_{new,copy,delete,save,builtin}` |

---

## 12. Security notes

- **Commands come from workflow YAML.** Workflows are stored in the user's global store and written only through
  token-authenticated routes (`serverPostGovernanceRoutes.ts:239-308`, `serverWorkflowYamlRoutes.ts:98-140`) or by
  hand. `tenon test run` executes them as the invoking OS user, with the same authority the agent's own shell
  already has.
  - The frozen snapshot prevents swapping commands in the middle of a task.
  - The editor shows every command verbatim.
  - Importing a workflow is a user action.
- **The Dashboard never executes tests.** No route spawns.
- **No interpolation.** The command string is passed as one argv element to the shell. Tenon-provided values travel
  only as environment variables, so change names and ids never reach shell parsing.
- **Tracked summaries contain no output text.** Output lives only in gitignored logs. Env values are never stored;
  only HMAC digests keyed by a per-user local key (not brute-forceable from git alone). `reasons[].detail` is
  generated by Tenon (≤200 chars) and never copies output.
- **Artifact serving** is loopback GET with realpath containment, `O_NOFOLLOW`, an extension allowlist, `nosniff`,
  `CSP: sandbox`, and zip as attachment. HTML reports are never rendered in the Dashboard origin.
- **Output collection** never follows symlinks and never copies from outside the repo. Size caps bound disk use.
- **Integrity boundary.** Records carry `actor.trust: 'declared'` (parent §2).
  - What the guard enforces: only files written by the runner count. Fields, report text and agent claims never do.
    Direct edit tools are blocked by `gate.sh` (§9.3).
  - Residual risk: shell redirection can still forge a JSON record. This is accepted, consistent with `multi-user`'s
    "防误操作，不防故意冒名" (`multi-user/prd.md:31-32`). Reviewers can cross-check `log.digest` against the
    local log.
- **Sandbox escalation** is requested by the agent per command. Tenon never disables a sandbox itself.

---

## 13. Validation and error matrix

| Condition | Behavior |
| --- | --- |
| Invalid change name / change missing | `tenon test *` exit 1 `ERROR: …`; server 400 / 404 |
| Change archived | exit 1 `ERROR: change '<c>' 已完结` |
| Identity missing | exit 1 with `multi-user` setup hint; no record |
| Actor is not the owner | exit 1 with 接手 hint; no record |
| Unknown test id | exit 1 `未声明的测试 '<id>'；可选：…` |
| Plan frozen without tests | same as unknown (`可选：(无)`) |
| Same user runs the same test concurrently | exit 1 `测试 '<id>' 正在运行（run …）`; stale marker past `deadline_at+60s` reclaimed |
| `cwd` missing / not a dir / escapes via symlink | record `fail` `cwd-invalid`, exit 2 |
| Shell spawn error (EACCES, ENOENT) | record `fail` `spawn-error`, exit 2 |
| Command not found (127) / not executable (126) | record `fail` `command-not-found` / `not-executable`, exit 2 |
| Timeout | SIGTERM group → 10 s → SIGKILL group; `exit_code: null`, `signal`, `timeout`, exit 2 |
| `tenon` interrupted (SIGINT/TERM/HUP) | forward to group, record `interrupted`, marker removed, exit 130 |
| Grandchild ignores SIGTERM | SIGKILL of the group after grace; a daemon that re-parented out of the group is not tracked (documented) |
| Output > 8 MiB | head 8 MiB + omitted marker + 1 MiB tail; `log.truncated: true`, note `log-truncated` |
| Binary / invalid UTF-8 output | stored raw; UI decodes with replacement characters |
| Required output missing / symlink / escapes repo | `output-missing` (`detail` names the path), exit 2 |
| Output dir > 5000 files | `digest: null`, `files` counted to cap, not failing unless required and absent |
| Copy cap exceeded | `artifact: null`, not failing |
| Metrics declared but unreadable | `metric-unreadable`, exit 2 |
| Metric beyond `max`/`min` | `metric-threshold`, exit 2 |
| Regression beyond `max_regression_pct` | `metric-regression`, exit 2, record shows `baseline` and `delta_pct` |
| Baseline absent / different command or cwd | note `baseline-missing` / `baseline-mismatch`, no comparison |
| Workspace changed during run | note `workspace-changed`; `candidate` = after |
| Fingerprint capture raced twice | `candidate-unavailable`, exit 2 (record kept so the UI shows why) |
| Codex sandbox denial (`CODEX_SANDBOX` + pattern) | extra `sandbox-denied`, stderr escalation hint, exit 2 |
| Record publish fails (ENOSPC, EACCES) | exit 1 `ERROR: 测试记录写入失败: …`; artifacts kept; guard sees `missing` |
| Corrupt record JSON | ignored by guard (`missing`); snapshot `testDiagnostics` |
| Record from another `workflow_run_id` | ignored |
| Declaration or workflow changed since run | `stale` (`declaration` / `workflow`) |
| Required test failed / stale / missing / running at transition | `test-evidence-failed`, CLI exit 1; `tenon check` exit 2; `review request` exit 2 before any mutation |
| Optional test failed | shown, never blocks |
| Backward edge (`verify-fail`, `requirements-changed`) | tests not evaluated |
| Server transition without identity | fail closed blocker `测试证据无法验证…` |
| Direction YAML invalid on PUT | 400 with the parser message; nothing written |
| PUT/DELETE builtin id | 409 |
| Artifact path traversal / symlink | 400 / 403 |
| Artifact > 64 MiB | 413 |
| Nudge hook: plan file missing / huge / unmatched | exit 0, no output |
| `gate.sh` direct write to records | exit 2 with message |

---

## 14. Tests required (assertion points)

### Kernel (`npx vitest run packages/kernel/src/test-evidence packages/kernel/src/workflow packages/kernel/src/workspace`)

| File | Assertions |
| --- | --- |
| `workflow/parse-tests.test.ts` | Full §3.1 item parses to the exact `StepTestDef`. Single-quoted command with `: `, ` #`, `''` round-trips. Unknown key line throws `出现未知字段行`. `tests: []` → `[]`. Duplicate `id` key in one item throws. |
| `workflow/serialize.test.ts` (extend) | `parseWorkflow(serializeWorkflow(wf))` deep-equals for a branch workflow with tests. Unsafe scalars are quoted. Key order matches §3.1. |
| `workflow/compile-tests.test.ts` | Defaults filled. IR key order starts `id,direction,command,cwd`. Each §3.4 row rejects with its message. Output under `frontend/test-results/x.xml` accepted, under `frontend/reports/x.xml` rejected. |
| `workflow/track-branch.test.ts` (extend) | Duplicate test id across two steps of one branch rejected with the `tracks.<t>:` prefix; same id in two different branches accepted. |
| `workflow/effective-plan.test.ts` (extend) | A workflow without tests has the same `workflowFingerprint` as before (golden value). Adding tests changes it. The v3 snapshot round trip (`workflowPlanSnapshot` → `effectiveWorkflowPlanFromSnapshot`) keeps tests. |
| `workspace/fingerprint.test.ts` (extend) | Writing `.tenon/users/u/tests/c/r.json` leaves the fingerprint unchanged. `TEST_OUTPUT_DIR_SEGMENTS ⊆ EXCLUDED_ANY_SEGMENT`. |
| `test-evidence/direction.test.ts` | Each `templates/test-directions/*.yaml` parses. Id equals file stem. `testFromDirection` suffixes `-2` on collision. |
| `test-evidence/record.test.ts` | `decodeTestRunRecord` accepts the §5.4 fixture and rejects extra keys, a bad run-id, and a bad candidate prefix. Baseline decode keeps history ≤20. |
| `test-evidence/metrics.test.ts` | Nested JSON is flattened. The last JSON line of stdout wins. Non-finite values are dropped. `max`/`min`. Regression lower/higher sign. `baseline-mismatch` when the command differs. |
| `test-evidence/evaluate.test.ts` | No tests → pass without fs access. Missing / passed / failed / stale-by-candidate / stale-by-digest / stale-by-workflow. Other `workflow_run_id` ignored. Other user's pass ignored. Live marker → running; expired marker → record status. Optional failure → no blocker. `context` undefined → fail-closed blocker. `sandbox-denied` suffix. |
| `workflow/transition-application.test.ts` (extend) | Forward edge blocked with `test-evidence-failed` before the review receipt is consulted (the review binding stub is not called). Backward edge not blocked. Implicit `archived` edge blocked. Pass → applied. The state revision is not incremented on rejection. |
| `test-evidence/report.test.ts` | Region renders zh and en headers. Replace is idempotent (twice equals once). Append when no region. Failures and commands lists. |

### CLI (`npm test -- packages/cli/src/test-runner packages/cli/src/test-evidence.integration.test.ts`)

| File | Assertions |
| --- | --- |
| `test-runner/process.test.ts` (real `/bin/sh`) | Exit code captured. `sleep` with `timeoutMs: 200` → `timedOut`, signal set, grandchild `sleep` gone (verified with `kill -0` on its pid written to a file). A 9 MiB output → `truncated`, `bytesKept` ≤ 8 MiB + 1 MiB + marker, sha256 of the file matches. An abort signal → `interrupted`. Exit 127 kept. |
| `test-runner/collect.test.ts` | Document input digests from a seeded ledger. Directory manifest is stable across runs. Symlinked output → not present. Env digest differs for different values and is stable for the same key. The copy cap sets `artifact: null`. |
| `test-evidence.integration.test.ts` (harness `integration-harness.ts:414-484`) | Init a custom branch workflow with build tests `unit` (`node -e "process.exit(0)"`) and `bad` (`exit 3`). `test run unit` → exit 0 and a record under `.tenon/users/<slug>/tests/<change>/`. `transition build-complete` blocked while `bad` is missing / failed (exit 1, message names `bad`). `tenon check` exit 2 with `[FAIL] test:`. Fix `bad` → pass → transition applies. Edit a source file → `unit` stale → blocked again → rerun → applies. Second identity (`TENON_USER`) running the same test writes a separate dir; the first user's guard ignores it. `review request` on a review step blocked with the same blockers and no receipt written. Required output missing → `output-missing`. Metrics threshold + `baseline --run` + regression failure. `test report --write` replaces the region. `test status --json` shape. Retention keeps 5 of 7 artifact dirs and all 7 summaries. |
| `commands/test-code-size.test.ts` | Temp git repo: committed + uncommitted + untracked lines counted; `--base` merge-base. |
| `runtime/builtin-test-directions.test.ts` (new) + `runtime/release-store.integration.test.ts` (extend) | Sync writes `builtin/*.yaml` and leaves `custom/` untouched. A second sync removes a builtin file no longer shipped. Activation through `activateWithinTransaction` (`installer.ts:41-72`) invokes the sync. |

### Server (`npm test -- packages/server/src/server.test.ts packages/server/src/testEvidenceSnapshot.test.ts`)

- The snapshot includes `tests` for a change with records. Status becomes `stale` after a source edit (candidate cache TTL injected as 0). `testDiagnostics` lists a corrupt file.
- The SSE fingerprint changes when a record is added.
- `GET /api/tests/runs|run|artifact`: 200 paths; `..` → 400; symlink → 403; over cap → 413; image content type; `nosniff` + CSP headers; zip attachment.
- `GET /api/test-directions` lists builtin before custom. PUT without token → 401; builtin id → 409; invalid YAML → 400; valid → file on disk. DELETE custom → 200, builtin → 409.
- Server transition blocked with `test-evidence-failed`.
- Removal: `POST /api/verification-evidence/compose` → 404.

### Dashboard (`npm run test:web -- TestsSection TestEditorDrawer StageTestsPanel TestRunDrawer TestDirectionsPane boundaryDecoders governanceSchema`)

All dashboard tests are `*.test.tsx`: `packages/dashboard-app/vitest.config.ts` only includes that pattern. Snapshot decoder cases go in `api/boundaryDecoders.test.tsx`.

- `TestsSection`: `+` → pick direction → row `wb-test-unit` appears. Editing the command in the drawer updates `editor.setTests` payload. The YAML export after save contains the test (round-trip through the `governanceSchema` decoder). A duplicate id disables save via lint.
- `StageTestsPanel`: `data-status` per row, count `2/3` in `task-io-tab-tests`, the tab is hidden when the step has no tests, and no text node matches a sentence (no `。` in rendered text except errors).
- `TestRunDrawer`: history fetch, log `<pre>` fetch uses `tail`, image output renders `<img>`, zip renders a download link, missing artifact renders `—`.
- `TestDirectionsPane`: the builtin textarea is read-only; copy → PUT `<id>-copy`; delete confirm → DELETE.
- `snapshotDecoder`: a valid `tests` value decodes; an invalid status rejects the change.
- `i18n.test.tsx` keeps passing (keys exist, no Chinese literals in TSX).

### Hooks (`bash tools/test-hooks.sh`)

- New section `10e test-nudge`:
  - `npm test` on a change whose frozen plan declares `npm test` → stdout contains `<tenon-test-nudge>` and the id.
  - `tenon test run …` → no output.
  - Unrelated command → no output.
  - Missing plan → no output.
  - Exit 0 in all cases.
  - The script contains no `node` / `jq` / `python`.
- `gate.sh`: `Write` to `.tenon/users/u/tests/c/r.json` → exit 2 with the message. `Write` to `.tenon/users/u/local/x` → not blocked by this rule.
- `hooks.json` registers the `test-nudge` hook id (pattern `tools/test-hooks.sh:1986`).

### Real hosts (acceptance, PRD)

- Claude Code and Codex each run a real task: the build unit test and a verify Playwright test through `tenon test run`.
  - Codex runs the Playwright test escalated.
  - The workbench shows exit code, duration, actor, input digests and output files.
  - A fabricated "通过" in a field or report does not unblock.
- A Playwright failure opens its screenshot and trace in the drawer.

---

## 15. Decisions made during design

| # | Decision | Why |
| --- | --- | --- |
| D1 | Test directions are templates copied into step YAML; step tests are self-contained | YAML stays the single editable truth; the frozen IR already freezes test content; direction edits cannot silently alter running tasks (CCR-1) |
| D2 | Declared outputs must live under `test-results/`, `playwright-report/` or `coverage/` | Those segments are already fingerprint-excluded (`fingerprint.ts:42-50`), so producing outputs never invalidates the candidate or the in-place build token |
| D3 | Candidate = workspace fingerprint after the run, for every isolation mode; `workspace-changed` is a note | HEAD misses uncommitted edits; failing on build outputs (`dist/`, `target/`) would make ordinary commands unusable |
| D4 | Guard reads only the acting user's records | PRD stores records per user; environments differ; benchmark baselines are per user |
| D5 | Tests are a separate evidence stage in the transition (like documents), not a `WorkflowGuardConfig` variant | Works identically for default (phase-manifest) and step-graph plans without touching `DEFAULT_EVENT_POLICY`; needs identity + fs, which guard handlers do not have |
| D6 | Enforced on non-backward exits only, including the implicit `archived` edge | Same predicate as documents; send-backs must never demand tests |
| D7 | No live output streaming; last 4 KiB printed on failure | Keeps agent context small while giving the failure cause |
| D8 | `CI` is not injected; stdin is closed | Tools already run non-interactively without a TTY; implicit env changes alter test behavior |
| D9 | `typecheck` added as the 8th builtin direction; `code-size` backed by `tenon test code-size` | R10 requires type check; a deterministic, sandbox-safe probe gives `review-agents` stable metrics |
| D10 | `tenon test report` writes a marked region; no guard compares it with records | R12 asks for generation; enforcing report equality would add a second evidence gate for the same facts |
| D11 | Delete the unused verification-evidence composer stack | Unused (no production caller) and semantically contradicts real records ("Tenon did not run these checks"); user rule: remove unused capabilities |
| D12 | Env inputs recorded as HMAC digests keyed by `local/env.key` in the repo's gitignored per-user dir | Values may be secrets; `$HOME` is unwritable in Codex, so the key cannot live under `stateRoot` |
| D13 | Running marker without pid probing; reclaim after `deadline_at + 60s` | `/bin/ps` and cross-pid `kill` are unreliable inside Codex (`state-lock.md` §3) |
| D14 | Nudge (PostToolUse additionalContext), not a PreToolUse block, for self-run test commands | TDD loops need quick local runs; only records count, so a hint is enough |
| D15 | `gate.sh` blocks edit tools writing records/baselines | Keeps "agent 自报无法满足必需测试" true for ordinary edits; shell redirection remains a documented residual risk |
| D16 | Default workflow gets npm-convention tests on frontend/backend branches only | R10 names those tracks; commands are editable in the global default override |
| D17 | Codex tests needing network/ports/browser run with `sandbox_permissions: "require_escalated"` | Verified: listen/connect/Chromium are denied under `:workspace`; Tenon must not weaken the sandbox itself |
| D18 | Retention prunes only local artifact dirs; tracked summaries are kept forever | Summaries are small and are the audit trail; R13 limits large files only |

---

## 16. Contract change requests (parent `design.md`; not edited here)

| # | Section | Request |
| --- | --- | --- |
| CCR-1 | §4 bullet "Agents and test directions are referenced by id; … freezes their content digests" | For **test directions**: step `tests[]` items are self-contained copies (command required). `direction` is the origin id only. No direction digest is frozen; the frozen workflow IR is the freeze. Agents are unchanged. |
| CCR-2 | §4 YAML example | Use `outputs: [ { path: frontend/test-results/junit.xml, required: true } ]` (outputs must be under `test-results/`, `playwright-report/`, `coverage/`). Keys stay snake_case in TS. The narrow parser writes block style; flow maps are illustrative. |
| CCR-3 | §3 "Project per user" | (a) `.tenon/` is excluded from `fingerprintWorkspace` (`EXCLUDED_TOP_LEVEL`). The owner is `multi-user`, who writes `.tenon/` first. (b) Replace "`.gitignore` gets `.tenon/users/*/local/`" with a committed `.tenon/.gitignore` containing `users/*/local/`, created by the shared ensure-dir helper. This avoids editing a user project's root `.gitignore`. (c) Add `local/running/<change>/<test-id>.json` and `local/env.key` to the layout. |
| CCR-4 | §5 test record row | Replace the field list with `TestRunRecordV1` (§5.4 here). Adds: `schema`, `workflow_run_id`, `workflow_fingerprint`, `test_digest`, `candidate_before`, `git_head`, `build_sha`, `host`, `signal`, `reasons[]`, `metrics[]`, `log{…}`; `outputs[].artifact`; `inputs` shape per kind. `candidate` is the workspace fingerprint. `log_ref` → `log.artifact`. |
| CCR-5 | §5 "Guards read these records; … stale" | Staleness = candidate **or** test declaration digest **or** workflow fingerprint mismatch. Records from another `workflow_run_id` are ignored. |
| CCR-6 | §5 | Test guards read only the acting user's records; other users' runs are display-only. |
| CCR-7 | §6 | `tenon test` family = `run`, `status`, `baseline`, `report`, `code-size`. `code-size` is the deterministic probe behind the builtin `code-size` direction that `review-agents` reads (`reads_tests: [code-size]`). |
| CCR-8 | §7 Workspace detail | 测试 is a third sheet tab next to 输入 / 输出 (not a section). `SheetTabs.count` accepts `"n/m"` strings (shared with `workflow-io-openspec`). |
| CCR-9 | §2 / multi-user exports | `multi-user` exports, consumed here: `resolveTenonUser` (already in contract); an owner assertion for "advance" actions (name chosen by `multi-user`; `tenon test run` and `test baseline` call it); a per-user root helper `tenonUserRoot(repoRoot, slug)` + `ensureTenonDir(repoRoot)` (CCR-3b). |
| CCR-10 | §3 Global table | Builtin test directions include `typecheck` (R10), in addition to unit, integration, regression, benchmark, playwright, e2e, code-size. |

---

## 17. Interface offered to other children

| Consumer | API |
| --- | --- |
| `review-agents` | `latestTestRun(repoRoot, changeName, slug, testId, workflowRunId)`, `evaluateTestEvidence(…)`, `TestRunRecordV1.metrics` (code-size metrics: `files_changed`, `lines_added`, `lines_deleted`, `largest_added_lines`). Reviewers run after required tests pass (`review-agents/prd.md:47`), so they can call `evaluateTestEvidence` first. |
| `data-driven-runner` | `plan.workflow.steps[i].tests` via `tenon workflow plan --json`; `tenon test status <change> --json`; `tenon test run`; `tenon test report --write`. |
| `task-delete-archive` | Paths to remove on delete (§10). |
| `multi-user` | Needs CCR-3 and CCR-9. Records carry `actor` per parent §2. |
