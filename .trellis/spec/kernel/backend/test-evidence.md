# Per-step Test Evidence (`test-evidence/`, `workflow/compile-tests.ts`)

## 1. Scope / Trigger

- A workflow step may declare `tests[]`. Tenon runs each declared command itself and publishes a record;
  a test an agent ran on its own leaves no record and therefore never satisfies a required test.
- Trigger: before this, nothing in the interactive flow executed a test or recorded an exit code. Evidence
  was an agent-typed string in a report, so "tests pass" could not be distinguished from "tests were claimed".
- Records live per user under `<repo>/.tenon/users/<slug>/`: `tests/<change>/<run-id>.json` and
  `baselines/<test-id>.json` are tracked; the log, the artifact copies, the running marker and the env HMAC
  key stay in the gitignored `local/` subtree.

## 2. Signatures

```ts
// kernel/src/workflow/types.ts (definition layer, snake_case on the wire)
interface StepTestDef {
  id: string; direction: string; command: string
  cwd?: string; label?: string; timeout_s?: number; required?: boolean; keep_runs?: number
  scope?: 'full' | 'known'; metrics_path?: string
  pass?: { exit_code?: number; metrics?: TestMetricCriterion[] }
  inputs?: TestInputDef[]; outputs?: TestOutputDef[]
}
// kernel/src/test-evidence/
evaluateTestEvidence(input): Promise<TestEvidenceReport>      // status + blockers for one step
latestTestRun(repoRoot, change, slug, testId, workflowRunId)  // the acting user's newest record
listTestRuns(repoRoot, change, filter?)                       // every user, ordered by finish time
testDigest(test: StepTestIR): string                          // `sha256:` over canonical JSON
rejectOnTestEvidence(input): Promise<TestEvidenceRejection | undefined>  // the transition gate
renderTestsRegion / replaceTestsRegion                        // verification report section (R12)
```

## 3. Contracts

- **A direction is an authoring template.** Adding a test copies the direction's fields into the step YAML;
  `direction` keeps only the origin id. Editing or deleting a direction never changes an existing workflow
  or a running task, and the frozen workflow IR is therefore the freeze of test content.
- **`tests` is emitted into the IR only when non-empty**, so a workflow without tests compiles to
  byte-identical IR and keeps its `workflowFingerprint`. The IR key order starts `id, direction, command, cwd`
  because `hooks/test-nudge.sh` scans the frozen plan with a bash regex.
- **Declared outputs and `metrics_path` must sit under `test-results/`, `playwright-report/` or `coverage/`**
  (`TEST_OUTPUT_DIR_SEGMENTS`, a subset of the fingerprint's excluded segments), so producing them never
  changes the candidate the record binds to.
- **Candidate** = `fingerprintWorkspace(repoRoot)` captured after the command exits. `candidate_before` is
  captured before the spawn; a difference is the note `workspace-changed`, never a failure (build outputs
  legitimately change the tree).
- **A record is fresh** for `(user, change, test)` only when `workflow_run_id`, `workflow_fingerprint`,
  `test_digest` and `candidate` all match the current plan and tree. Anything else is `stale`.
- **Only the acting user's records count.** Other users' runs are display-only: environments differ and
  benchmark baselines are per user.
- **Records are immutable**: published with an exclusive link, decoded against a closed key set. A corrupt or
  hand-edited file decodes to `undefined` and the test counts as `missing`.

## 4. Enforcement

- The transition evaluates test evidence after document evidence and before the review receipt, under the
  same non-backward edge predicate. Send-backs (`verify-fail`, `requirements-changed`) never demand tests;
  the implicit 完结 edge does, because its target is not in the step order.
- Missing identity or a missing workspace fingerprint fails closed with one blocker
  (`测试证据无法验证：宿主未提供用户身份或工作区指纹`). "Cannot read the evidence" is never "the evidence passed".
- `tenon check` previews the same blockers as `[FAIL] test:`; `tenon review request` inherits them through
  `cmdCheck` before writing any receipt.
- `hooks/gate.sh` refuses edit tools writing `.tenon/users/*/tests/` or `.../baselines/`. Shell redirection is
  a documented residual risk, consistent with "防误操作，不防故意冒名".

## 5. Error Matrix

| Condition | Result |
| --- | --- |
| Unknown test id | exit 1, `未声明的测试 '<id>'；可选：…`, no record |
| Not the owner / identity missing | exit 1 with the 接手 / setup hint, no record |
| Same user, same test already running | exit 1 until `deadline_at + 60s`, then the marker is reclaimed |
| `cwd` missing, not a directory, or escaping the repo | record `fail` with `cwd-invalid`, no spawn |
| Timeout | SIGTERM the process group, SIGKILL after 10s, `timeout`, `exit_code: null` |
| Required output absent, a symlink, or outside the repo | `output-missing` |
| Metrics declared but unreadable | `metric-unreadable`; thresholds → `metric-threshold`; regression → `metric-regression` |
| No baseline / baseline from another command or cwd | notes `baseline-missing` / `baseline-mismatch`, never a failure |
| `CODEX_SANDBOX` set and the tail matches a denial pattern | extra `sandbox-denied` plus the escalation hint |
| Output over 8 MiB | head 8 MiB + omitted marker + 1 MiB tail, note `log-truncated` |
| Record publish fails | exit 1, artifacts kept, the guard still sees `missing` |

## 6. Tests

- `kernel/src/workflow/{parse-tests,compile-tests}.test.ts`: the full YAML item round-trips; every closed-set
  rule rejects with its message; a workflow without tests keeps its golden fingerprint.
- `kernel/src/test-evidence/{record,metrics,evaluate,report,direction}.test.ts`: codecs, metric comparison,
  every status transition, the report region.
- `kernel/src/workflow/transition-application.test.ts`: a forward edge is blocked before the review binding is
  consulted; the backward edge is not; the implicit 完结 edge is.
- `cli/src/test-evidence.integration.test.ts`: real runs through the CLI, two identities, retention, the gate.
- `tools/test-hooks.sh` section 10d2/10d3: the nudge and the record write guard.

## 7. Wrong / Correct

```ts
// WRONG — trusting a field or a report sentence as test evidence
if (state.fields.verify_result === 'pass') allowTransition()

// CORRECT — only a record written by the runner and bound to this tree counts
const report = await evaluateTestEvidence({ repoRoot, changeDir, changeName, plan, stepId, context })
if (!report.pass) return { kind: 'test-evidence-failed', stepId, blockers: report.blockers }
```

```ts
// WRONG — reading "latest" by sorting run ids (same-second runs differ only by a random suffix)
const latest = [...runs].sort((a, b) => (a.run_id < b.run_id ? -1 : 1)).at(-1)

// CORRECT — order by the recorded finish time, with the run id only as a stable tie-break
const latest = [...runs].sort(byFinishedAtThenRunId).at(-1)
```
