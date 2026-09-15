# Design: task-level agents (executors and reviewers)

> **Parent overrides** (`.trellis/tasks/09-15-tenon-next-capabilities/design.md` §9 wins over this file): X1 your CLI stands; X6 builtin skill ids must exist in skills/sources.yaml (`vercel-react-best-practices`; backend-quality has no skill); frontend-quality gains a GSAP motion checklist and gsap skills; X7 `.pipeline-frozen/lock.json` holds agents only (no test_directions); X15 retired wire slots kept, no schema bump; X18.

Binding inputs: parent `09-15-tenon-next-capabilities/design.md` (terms §1, identity §2, layout §3, YAML §4, records §5,
execution boundary §6, surfaces §7), this child's `prd.md`, `research/current-review.md`, `research/harness-agents.md`,
the Dashboard memory rules (YAML is the only editable source, one word per concept, no sentences, nothing wraps,
workspace and workflow page use the same `SkillFlow` canvas). Deviations from the parent are listed in §17 only.

## 1. Boundaries

In scope

- Agent library: Markdown files with a closed frontmatter, builtin (plugin-maintained) and custom, global config dir.
- Step YAML `agents: { executors, reviewers }` with `depends_on` waves, `required`, `block_at`, `reads_tests`.
- Freezing the agents a Change uses when the Change is created.
- Agent run records, reports, findings, staleness, actor.
- CLI `tenon agent next | prompt | record` used by the single `tenon` skill.
- Progressive skill unlocking per running agent in `internal-skill-gate`.
- Guards: leaving a step (forward exits), `tenon check`, `tenon review request`, readiness projection.
- Deleting the review-attempt budget / lane machinery and the hand-filled review fields.
- Dashboard: agent library, step executors/reviewers editing, workspace agent runs.
- Minimal `default.yaml` / `simple` migration so nothing references deleted keys.

Out of scope (owner)

- Rewriting phase skills into the single `tenon` skill and the full default workflow data migration (data-driven-runner).
  This child only provides the CLI contract (§7) and host delivery contract (§8) that skill follows.
- Test execution, test records, `tests:` step block (test-evidence). Consumed through the interface in §6.3.
- Identity resolution and owner checks (multi-user). Consumed through parent §2.
- Library page shell and shared builtin sync helper if instruction-templates lands them first (§3.3, §12.1).
- Physical removal of retired canonical state slots (version-reset, §13.4).
- Dashboard model calls: none, ever. Every agent runs in the host (parent §6).

## 2. Current state and fate

| Piece | Evidence | Fate |
| --- | --- | --- |
| Review attempt store (`begin/lane/complete`, budget, override) | `kernel/src/state/review-attempt-budget.ts:106-329`, model `review-attempt-budget-model.ts:1-296`, io `review-attempt-budget-io.ts:1-110`; aggregate = all lanes pass `review-attempt-budget.ts:248-250` | Delete. Report containment + immutable publish ideas (`review-attempt-budget-io.ts:56,83-107`) are reimplemented in the agent run ledger |
| CLI `review-attempt`, `review-budget` | `cli/src/program-review.ts:27-48`, `cli/src/commands/review-attempt.ts:1-252` | Delete (keep `review request/acknowledge` and `interaction`, `program-review.ts:8-25`) |
| `review_budget` workflow policy | `workflow/types.ts:50-54,202`, `parse.ts:337-341`, `parse-policy.ts:72-73`, `policy.ts:140-147`, `serialize.ts:56-66,201`, `compile.ts:46,307,322`, `ir.ts:186`, `effective-plan.ts:123,143,172`, snapshot `workflow-plan-snapshot.ts:53-57,106-108`, templates `default.yaml:2-4`, `simple.yaml:2-4`, `builtin-workflows.ts:11` | Delete; historical v3 snapshot fingerprint math keeps a raw literal (§13.3) |
| Step `review_lanes`, skill `kind` / `review_lane` | `types.ts:61-69,177-178`, `parse.ts:228,258-269,288`, `parse-skill-refs.ts:29-47`, `compile.ts:49,51,163-187,222-224,252`, `serialize.ts:22-23,159-161`, `validate.ts:106-110`, `ir.ts:172`, `effective-plan.ts:111-113,158-159`, `effective-plan-types.ts:39-40,56-59` | Delete |
| Manifest `review_skills`, resolver `reviewLaneFor` | `templates/manifest.yaml:62-65`, `flow/manifest.ts:199-221,465-469,584-596`, `workflow/effective-skill-resolver.ts:40,214` | Delete |
| Review-lane skill gate (fail-closed) | `cli/src/commands/internalSkillGate.ts:91-153`, call `:194-197` | Replace by agent skill scoping (§9) |
| `agent_review_result` / `codex_review_result` | guards `flow/default-event-policy.ts:92-93`, renderer `:199-200`, exit rules `flow/guard.ts:101-102`, seed `state/state-init.ts:103-104`, enum `cli/src/commands/field-values.ts:21-22`, graph `server/src/orchestrationGraph.ts:206-210`, labels `dashboard-app/src/i18n/translations.ts:490-491,2433-2434`, skill prose `skills/tenon-verify/SKILL.md:339-368,406-420` | Delete every reader and writer; wire slot stays reserved (§13.4) |
| Hard-coded reviewer tracks in skill text | `skills/tenon-verify/SKILL.md:74-102,143-248` (3–4 lanes, `codex exec` at `:228-238`) | Remove review-attempt and lane steps; data-driven-runner rewrites the rest |
| Plugin agents | `agents/tenon-builder.md`, `tenon-design-reviewer.md`, `tenon-researcher.md`, `tenon-reviewer.md`; content asserted by `tools/test-bundle.sh:65-68` | Move to `templates/agents/` in the new format (Claude Code auto-discovers a plugin's root `agents/`, which would expose them outside tasks and violate R2) |
| Candidate resolution | `cli/src/commands/review-candidate.ts:10-15,25-48` (build token → `sha256:<revisionHash>`, else workspace fingerprint) | Reuse, renamed (§5.3) |
| Step visit identity | `kernel/src/state/document-step-visit.ts:5-11` | Reuse as `step_visit` |
| Skill DAG waves | `workflow/skillDag.ts:18-27`, `SkillFlow` waves (`component-guidelines.md:109-147`) | Reuse the same wave rule for agents |
| Orchestration v2 `role`/`mode` | `kernel/src/orchestration/v2-types.ts:97-115` | Not reused (runtime-v2 only; host-driven Changes never reach it) |
| Workspace fingerprint scope | `kernel/src/workspace/fingerprint.ts:22-37` excludes top-level `openspec` | Records and reports under the Change dir never change the candidate |

## 3. Agent library

### 3.1 File format

```markdown
---
name: frontend-quality
description: 前端质量评审
skills: [react-best-practices, web-design-guidelines]
tools: [Read, Grep, Glob, Bash, Skill]
model: sonnet
hosts: [claude, codex]
---
<prompt body, Markdown>
```

| Key | Required | Rule |
| --- | --- | --- |
| `name` | yes | `^[a-z0-9][a-z0-9-]{0,62}$`, equals the file basename without `.md` |
| `description` | yes | 1–200 chars, one line |
| `skills` | no (default `[]`) | inline list; each id matches the existing skill id rule (`SKILL_IDENT_RE`, `workflow/validate.ts:112`), namespaces allowed |
| `tools` | no (default `[]`) | inline list; `^[A-Za-z][A-Za-z0-9_:-]{0,63}$` |
| `model` | no | `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$` |
| `hosts` | no (absent = every host) | inline list; each id ∈ `KNOWN_AGENT_HOSTS`, mirror of `TENON_HOSTS` (`cli/src/commands/plugin-host.ts:11-24`) |

- Frontmatter: first line `---`, closing `---`, one `key: value` per line, no duplicates, no other keys. Body after the
  closing line must be non-empty after trim. File ≤ 64 KiB, strict UTF-8.
- Role is not part of the file: the step decides whether an agent executes or reviews.
- `digest` = `sha256:` + hex of the raw file bytes.

```ts
// packages/kernel/src/agents/agent-file.ts
export const KNOWN_AGENT_HOSTS: readonly string[]
export type AgentSource = 'builtin' | 'custom'
export interface AgentDefinition {
  readonly name: string
  readonly description: string
  readonly skills: readonly string[]
  readonly tools: readonly string[]
  readonly model?: string
  readonly hosts?: readonly string[]
  readonly body: string
}
export class AgentFileError extends Error { readonly code: 'agent-file-invalid'; readonly field?: string }
export function parseAgentFile(bytes: Buffer, expectedName: string): AgentDefinition   // throws AgentFileError
export function agentDigest(bytes: Buffer): string                                    // sha256:<hex>
```

### 3.2 Locations

| Path | Content |
| --- | --- |
| `templates/agents/<name>.md` (repo, plugin payload) | builtin sources |
| `<configRoot>/agents/builtin/<name>.md` | builtin copies, rewritten by sync |
| `<configRoot>/agents/builtin/.builtin.json` | `{ "version": 1, "source_digest": "sha256:…", "names": [...], "synced_at": "<utc>" }` |
| `<configRoot>/agents/custom/<name>.md` | user agents, never touched by sync |

`configRoot` = `resolveProductPaths().configRoot` (`kernel/src/product-paths.ts:102-146`); tests use
`TENON_RUNTIME_HOME` like the workflow store (`workflow-track-branches.md` §3 Storage).

```ts
// packages/kernel/src/agents/library.ts
export interface AgentEntry {
  readonly name: string
  readonly source: AgentSource
  readonly path: string
  readonly digest: string
  readonly definition?: AgentDefinition   // absent when invalid
  readonly error?: string                 // parse error or name conflict
}
export interface AgentLibrary {
  readonly entries: readonly AgentEntry[]
  resolve(name: string): AgentEntry & { readonly definition: AgentDefinition; readonly bytes: Buffer }  // throws AgentLibraryError
}
export function loadAgentLibrary(input: { readonly configRoot: string; readonly payloadDir: string }): AgentLibrary
export function writeCustomAgent(input: { configRoot: string; name: string; content: string; expectedDigest?: string }): AgentEntry
export function deleteCustomAgent(input: { configRoot: string; name: string; expectedDigest: string }): void
export class AgentLibraryError extends Error {
  readonly code: 'agent-missing' | 'agent-invalid' | 'agent-conflict' | 'agent-exists' | 'agent-builtin-readonly' | 'agent-stale'
}
```

- `loadAgentLibrary` first calls `ensureBuiltinAgents` (§3.3), then lists both dirs. A name present in both dirs is an
  `agent-conflict` entry (never shadowing). Writes are atomic (temp file + rename), refuse symlinks.
- `payloadDir` = `<pluginRoot>/templates/agents`: CLI `pluginRoot()` (`cli/src/main.ts:85`), server
  `repoRootForSkills()` (`server/src/serverSupport.ts:40-42`).

### 3.3 Builtin sync

```ts
// packages/kernel/src/library/builtin-sync.ts  (shared; reuse instruction-templates' helper if it landed first)
export function syncBuiltinDir(input: {
  readonly payloadDir: string
  readonly targetDir: string          // <configRoot>/agents/builtin
  readonly validate: (name: string, bytes: Buffer) => void
  readonly clock: () => string
}): { readonly changed: boolean; readonly names: readonly string[] }
// packages/kernel/src/agents/library.ts
export function ensureBuiltinAgents(input: { configRoot: string; payloadDir: string }): { changed: boolean }
```

- `source_digest` = sha256 over sorted `(name, bytes)` of the payload. Equal to `.builtin.json` → no-op. Otherwise every
  payload file is validated (a bad builtin is a release bug → throw), written into `builtin.tmp-<pid>`, then swapped in
  with renames; the old dir is removed. `custom/` is never opened for writing.
- Triggers: (1) lazily on every library load (CLI `tenon init`, `tenon agent *`, server `/api/agents*`, workflow save);
  this covers marketplace installs where no Tenon code runs at install time; (2) explicitly at the end of a successful
  `tenon setup` and `tenon update` (`cli/src/commands/setup.ts`, `cli/src/commands/update-success-report.ts`), so the
  directory exists right after install.

### 3.4 Builtin agents

| name | Typical role | skills | tools | Origin |
| --- | --- | --- | --- | --- |
| `builder` | executor | test-driven-development | Read, Write, Edit, Bash, Grep, Glob, Skill | `agents/tenon-builder.md` |
| `researcher` | executor | deep-research, market-research | Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch, Skill | `agents/tenon-researcher.md` |
| `architecture` | reviewer | improve-codebase-architecture | Read, Grep, Glob, Bash, Skill | new |
| `frontend-quality` | reviewer | react-best-practices, web-design-guidelines, design-taste-frontend | Read, Grep, Glob, Bash, Skill | `agents/tenon-reviewer.md` (TS/JS) + `agents/tenon-design-reviewer.md` (read-only visual mode) |
| `backend-quality` | reviewer | code-review | Read, Grep, Glob, Bash, Skill | `agents/tenon-reviewer.md` (backend) |
| `code-size` | reviewer | — | Read, Grep, Glob | new; meant for `reads_tests` |
| `security` | reviewer | security-review | Read, Grep, Glob, Bash, Skill | new |
| `spec-consistency` | reviewer | — | Read, Grep, Glob, Bash | new |
| `e2e` | reviewer | e2e-testing, browser-qa | Read, Grep, Glob, Bash, Skill | E2E lane `skills/tenon-verify/SKILL.md:221-226` |

Skill ids are checked by `tools/check-agents.mjs` against the payload `skills/` tree; the final list follows the
upstream-skills manifest (§ overlap in `implement.md`).

## 4. Workflow YAML `agents`

### 4.1 YAML

Block form (canonical output of `serializeWorkflow`, indentation as other step blocks):

```yaml
      - id: build
        label: 实现
        gate: null
        skills: []
        agents:
          executors:
            - agent: builder
            - agent: builder-ui
          reviewers:
            - agent: frontend-quality
              required: true
              block_at: high
            - agent: code-size
              required: true
              block_at: medium
              reads_tests: [code-size]
            - agent: architecture
              required: false
              block_at: high
              depends_on: [frontend-quality, code-size]
        inputs: []
```

Inline items as in parent §4 are also accepted by the parser: `- { agent: code-size, required: true, block_at: medium,
reads_tests: [code-size] }`. Parse defaults: `required: true`, `block_at: high`. `executors: []` / `reviewers: []`
allowed; when both are empty the step has no `agents` (parse returns undefined, serialize omits the block) so the
round-trip law `parseWorkflow(serializeWorkflow(wf)) ≡ wf` (`serialize.ts:1-5`) holds.

### 4.2 Types

```ts
// packages/kernel/src/workflow/types.ts
export type AgentSeverity = 'critical' | 'high' | 'medium' | 'low'
export interface StepExecutorRef {
  readonly agent: string
  readonly depends_on?: readonly string[]      // executors of the same step
}
export interface StepReviewerRef {
  readonly agent: string
  readonly required: boolean
  readonly block_at: AgentSeverity
  readonly depends_on?: readonly string[]      // reviewers of the same step
  readonly reads_tests?: readonly string[]     // test ids of the same step (test-evidence `tests[].id`)
}
export interface StepAgentsDef {
  readonly executors: readonly StepExecutorRef[]
  readonly reviewers: readonly StepReviewerRef[]
}
export interface StepDef { /* existing fields minus reviewLanes */ readonly agents?: StepAgentsDef }
export interface SkillRef { readonly id: string; readonly depends_on?: readonly string[] }   // kind, review_lane removed
// ir.ts StepIR: `readonly agents?: StepAgentsDef` (deep-frozen); reviewLanes removed
```

```ts
// packages/kernel/src/workflow/effective-plan-types.ts (EffectiveWorkflowPlan)
//   removed: reviewBudget, capabilities.review.budget, capabilities.review.laneScopes, declared[].kind, declared[].reviewLane
readonly capabilities: {
  // …existing
  readonly review: { readonly steps: readonly string[] }            // review-gate steps, still used at transition-application.ts:263
  readonly agents: {
    readonly steps: readonly {
      readonly stepId: string
      readonly executors: readonly { readonly agent: string; readonly dependsOn: readonly string[] }[]
      readonly reviewers: readonly {
        readonly agent: string; readonly required: boolean; readonly blockAt: AgentSeverity
        readonly dependsOn: readonly string[]; readonly readsTests: readonly string[]
      }[]
    }[]
  }
}
```

`tenon workflow plan <change> --json` prints the plan object (`cli/src/commands/workflow-plan.ts:80-86`), so the
`tenon` skill reads `capabilities.agents` with no extra command.

### 4.3 Parse / compile / validate rules

| Rule | Where | Error text |
| --- | --- | --- |
| `agents` keys ⊆ {executors, reviewers} | parse, compile (`AGENTS_KEYS`) | `step '<id>' agents 出现未知字段 '<k>'` / `出现该变体不接受的附加键` |
| executor keys ⊆ {agent, depends_on}; reviewer keys ⊆ {agent, required, block_at, depends_on, reads_tests} | parse, compile | same as above |
| agent name rule (§3.1) | compile | `<path>.agent: agent 名称非法（仅允许小写字母、数字与 -）` |
| duplicate agent in one list | compile | `<path>: 同一步骤重复声明 agent '<a>'` |
| same agent in executors and reviewers | compile | `<path>: agent '<a>' 在同一步骤不能既是执行者又是评审者` |
| `depends_on` target not in the same list | validate | `step '<id>' 的 agent '<a>' 依赖了同一身份列表内不存在的 '<b>'` |
| cycle | validate (reuse `detectCycle`, `validate.ts:141`) | `step '<id>': <cycle message>` |
| `block_at` ∉ enum | parse, compile | `<path>.block_at: 必须是 critical | high | medium | low` |
| `required` not boolean | parse, compile | `<path>.required: 必须是 true | false` |
| `reads_tests` id not in the step's `tests` | validate (only once test-evidence `tests` exists) | `step '<id>' 的评审者 '<a>' 读取的测试 '<t>' 未在本步骤声明` |
| removed keys `review_lanes`, `review_budget`, skill `kind`, `review_lane` | parse | `workflow 解析错误：'<key>' 已删除——评审改用步骤 agents.reviewers` |
| agent not in library | server save, `tenon init` (not kernel compile: kernel stays pure) | `工作流引用了 agent 库中不存在的 '<a>'` |

Compile (structured JSON from the server) requires explicit `required` and `block_at`; the Dashboard always sends them.
Inline map parsing lives in `workflow/parse-primitives.ts` as `parseInlineMap(raw): Record<string, string | string[]>`
(scalars and one-level inline lists only), shared with test-evidence.

## 5. Freezing and run records

### 5.1 Freeze sidecar (Change dir, tracked)

```
openspec/changes/<change>/.pipeline-frozen/
  lock.json                 {"version":1,"run_id":"…","workflow_fingerprint":"<64 hex>","agents":[{"name":"frontend-quality","source":"builtin","digest":"sha256:…"}]}
  agents/<name>.md          frozen bytes
```

```ts
// packages/kernel/src/state/agent-freeze.ts
export const FROZEN_DIR = '.pipeline-frozen'
export interface FrozenAgent { readonly name: string; readonly source: AgentSource; readonly digest: string; readonly definition: AgentDefinition }
export function agentsReferenced(workflow: WorkflowIR): readonly string[]          // selected track branch, sorted, unique
export async function ensureAgentFreeze(input: {
  readonly changeDir: string; readonly runId: string; readonly workflowFingerprint: string
  readonly workflow: WorkflowIR; readonly library: AgentLibrary
}): Promise<void>
export async function readFrozenAgents(input: {
  readonly changeDir: string; readonly runId: string; readonly workflowFingerprint: string
}): Promise<ReadonlyMap<string, FrozenAgent>>                                     // throws AgentFreezeError
export class AgentFreezeError extends Error { readonly code: 'freeze-missing' | 'freeze-corrupt' | 'freeze-binding' }
```

- Only the selected track branch (`plan.workflow`) is frozen; a Change's pipeline is stable while its track is stable
  (`workflow-track-branches.md` §3).
- `ensureAgentFreeze` is idempotent for the same `run_id`; an existing lock with another `run_id` is replaced only when
  the Change has no canonical revision yet (retry of a failed create). Write order: files, then `lock.json` via atomic
  publish (`state/atomic-publish.ts`).
- Callers (every place a Change is created, today where `reviewSeed` is passed): `cli/src/commands/init.ts:234`,
  `server/src/serverPostChangesRoutes.ts:244`, `automation/src/triage/workflow-run-create-repository.ts:350`; plus
  `tenon state pin-workflow-snapshot` (`cli/src/commands/state-projection.ts:85-91`). The library is resolved and every
  referenced agent validated **before** the Change is published; a missing agent aborts creation with exit 1 / HTTP 400.
- A step with no agents never needs the lock; Changes created before this feature have no `agents` in their frozen IR.

### 5.2 Run ledger `.pipeline-agent-runs.jsonl` (Change dir, tracked, append-only)

Each state change appends one full row; the last row per `run_id` wins.

```json
{"schema":"agent-run/v1","run_id":"6f0c…","agent":"frontend-quality","agent_digest":"sha256:…","role":"reviewer",
 "step":"verify","step_visit":"[\"<runId>\",7]","candidate":"sha256:…","status":"running","result":null,
 "findings":[],"report_path":"openspec/changes/c/.pipeline-agent-reports/6f0c….md","report_digest":null,
 "actor":{"id":"a@x.com","name":"A","trust":"declared"},"started_at":"2026-09-20T01:00:00Z","finished_at":null}
```

| Field | Rule |
| --- | --- |
| `schema` | `agent-run/v1` |
| `run_id` | UUID v4 |
| `agent`, `agent_digest` | frozen name and digest |
| `role` | `executor` \| `reviewer` |
| `step`, `step_visit` | current phase; `currentDocumentStepVisitId(changeDir)` (`state/document-step-visit.ts:5-11`) |
| `candidate` | §5.3 at start |
| `status` | `running` \| `finished` |
| `result` | reviewer: `pass` \| `fail` (derived); executor: `done` \| `failed` (reported); `null` while running |
| `findings[]` | `{ severity: critical|high|medium|low, location: string ≤200, message: string ≤500 one line }`, ≤ 200 |
| `report_path`, `report_digest` | fixed path under `.pipeline-agent-reports/`; digest set on finish |
| `actor` | `resolveTenonUser()` (parent §2); missing identity blocks writes |
| `started_at`, `finished_at` | UTC |

```ts
// packages/kernel/src/state/agent-runs.ts
export const AGENT_RUNS_FILE = '.pipeline-agent-runs.jsonl'
export const AGENT_REPORTS_DIR = '.pipeline-agent-reports'
export interface AgentFinding { readonly severity: AgentSeverity; readonly location: string; readonly message: string }
export interface AgentRunRow { /* exactly the fields above */ }
export async function readAgentRuns(changeDir: string): Promise<readonly AgentRunRow[]>     // last row per run_id, file order
export async function appendAgentRunRow(changeDir: string, row: AgentRunRow): Promise<void> // under change lock
export function parseAgentReport(text: string, role: 'executor' | 'reviewer'): { findings: readonly AgentFinding[]; result?: 'done' | 'failed' }
export class AgentRunError extends Error { readonly code: 'runs-corrupt' | 'runs-limit' | 'report-invalid' | 'run-not-running' | 'candidate-changed' }
```

- Append takes the Change lock (`state/lock.ts`, `.trellis/spec/kernel/backend/state-lock.md`); writers emit
  `JSON.stringify(row) + '\n'` in one `appendFile`. Readers need no lock and ignore a trailing segment without `\n`.
- Any other malformed line → `runs-corrupt` naming the line number (fail closed for guards).
- Limits: 1 MiB file, 512 runs.

### 5.3 Candidate

`frozenReviewCandidate` / `normalizeReviewCandidate` (`cli/src/commands/review-candidate.ts:10-48`) become
`currentCandidate(deps, change, state, plan, stepId)` / `normalizeCandidate(value)` in `cli/src/commands/candidate.ts`
(or test-evidence's shared helper if it already exists). Rule unchanged: a candidate-shaped step input (build token →
`sha256:<revisionHash>`) wins; otherwise the content-addressed workspace fingerprint. Server snapshot uses the same
function through its existing `workspaceFingerprint` capability (`server/src/changeSnapshot.ts:333-335`).

### 5.4 Report format

The agent writes Markdown to `report_path`. The last fenced block must be `tenon-result`:

````markdown
# frontend-quality
…free text…

```tenon-result
{"findings":[{"severity":"high","location":"src/app.tsx:42","message":"未处理加载失败"}]}
```
````

- Reviewer JSON keys ⊆ {findings}; `result` in a reviewer block is rejected (`评审者不自报结论，结论由阻断级别计算`).
- Executor JSON keys ⊆ {result, findings}; `result` required, `done` | `failed`.
- Reviewer result: `fail` iff some finding has rank(severity) ≥ rank(block_at) with low=1 … critical=4.

### 5.5 Projection and staleness (kernel, pure)

```ts
// packages/kernel/src/workflow/agent-verdict.ts
export type AgentRunState = 'idle' | 'running' | 'done' | 'stale'
export interface AgentView {
  readonly agent: string; readonly role: 'executor' | 'reviewer'
  readonly required: boolean; readonly blockAt?: AgentSeverity
  readonly dependsOn: readonly string[]; readonly readsTests: readonly string[]
  readonly state: AgentRunState; readonly result: 'pass' | 'fail' | 'done' | 'failed' | null
  readonly findings: number; readonly blocking: number
  readonly runId: string | null; readonly reportPath: string | null
  readonly actor: { readonly id: string; readonly name: string } | null; readonly finishedAt: string | null
}
export type AgentBlocker =
  | { readonly kind: 'executor-missing' | 'executor-running' | 'executor-failed'; readonly agent: string }
  | { readonly kind: 'reviewer-missing' | 'reviewer-running' | 'reviewer-stale'; readonly agent: string }
  | { readonly kind: 'reviewer-failed'; readonly agent: string; readonly blocking: readonly AgentFinding[] }
  | { readonly kind: 'agent-records-invalid'; readonly reason: string }
export interface StepAgentsInput {
  readonly step: EffectiveWorkflowPlan['capabilities']['agents']['steps'][number]
  readonly runs: readonly AgentRunRow[]
  readonly stepVisit: string
  readonly candidate: string
  readonly testsReady: { readonly ready: boolean; readonly pending: readonly string[] }
}
export function projectStepAgents(input: StepAgentsInput): readonly AgentView[]
export function evaluateStepAgents(input: StepAgentsInput): { readonly pass: boolean; readonly blockers: readonly AgentBlocker[] }
export function nextAgentWave(input: StepAgentsInput): { readonly wave: readonly string[]; readonly waiting: readonly { agent: string; for: readonly string[] }[] }
export function renderAgentBlocker(blocker: AgentBlocker, change: string): string
```

Per declared agent, the relevant run is the latest run of that agent in the current `step_visit` (runs from earlier
visits are history only).

| Latest run | executor state | reviewer state |
| --- | --- | --- |
| none | `idle` | `idle` |
| running, same candidate | `running` | `running` |
| running, other candidate | `running` | `stale` |
| finished | `done` | `done` if candidate equals current, else `stale` |

Executors are never stale by candidate: they are what changes the code.

Leave-step verdict (`evaluateStepAgents`), in declared order:

- every executor: `done` with result `done`; `failed` → `executor-failed`; `running` → `executor-running`; `idle` → `executor-missing`;
- every `required` reviewer: `done`+`pass`; `done`+`fail` → `reviewer-failed` (blocking findings); `stale` → `reviewer-stale`;
  `running` → `reviewer-running`; `idle` → `reviewer-missing`;
- advisory reviewers never produce blockers.

## 6. Scheduling

### 6.1 Waves

`wave(x)` = 0 without `depends_on`, else 1 + max wave of its dependencies (same rule as `skillDag`/`SkillFlow`).
Execution order for a step: executor waves → required tests ready → reviewer waves.

### 6.2 Runnable

- Executor `x`: every `depends_on` executor is `done`; `x` is not `done` with result `done`.
- Reviewer `r`: every executor is `done`+`done`; `testsReady.ready`; every `depends_on` reviewer is `done` on the current
  candidate (any result); `r` itself is not `done`+`pass` on the current candidate.
- `nextAgentWave` returns the runnable agents of the lowest unfinished wave, plus what each non-runnable agent waits for
  (`executor:<a>`, `agent:<a>`, `test:<id>`).

### 6.3 Test-evidence interface consumed

```ts
// provided by 09-15-test-evidence (names adapted at merge only inside cli/src/commands/agent.ts and server/src/agentRuns.ts)
requiredTestsReady(input: { repoRoot: string; change: string; step: StepIR; candidate: string }): Promise<{ ready: boolean; pending: readonly string[] }>
currentTestResults(input: { repoRoot: string; change: string; testIds: readonly string[]; candidate: string }):
  Promise<ReadonlyMap<string, { run_id: string; result: 'pass' | 'fail'; exit_code: number; stale: boolean; outputs: readonly { path: string; present: boolean }[] }>>
```

Until test-evidence is merged the adapter returns `{ ready: true, pending: [] }` and an empty map, and `reads_tests`
validation is skipped.

## 7. CLI

Registered by `packages/cli/src/program-agents.ts` (`registerAgentCommands`, wired in `cli/src/program.ts` next to
`registerReviewCommands`, `:172`); logic in `cli/src/commands/agent.ts`, rendering in `cli/src/commands/agent-prompt.ts`.
Exit codes follow `check`/gates: 0 ok, 1 usage / IO / corrupt state, 2 blocked.

### 7.1 `tenon agent next <change> [--json]`

Human output: one line per declared agent of the current step `<agent> <身份> <state> [结论] [问题 n]`, then
`下一波：a, b` or `全部完成`. JSON:

```json
{"change":"c","step":"verify","step_visit":"[\"r\",7]","candidate":"sha256:…",
 "agents":[{"agent":"spec-consistency","role":"reviewer","required":true,"block_at":"medium","depends_on":[],
            "reads_tests":[],"state":"idle","result":null,"findings":0,"blocking":0,"run_id":null,"waiting_for":[]}],
 "wave":["spec-consistency","frontend-quality","security","e2e"],
 "pass":false,
 "blockers":[{"kind":"reviewer-missing","agent":"e2e"}]}
```

A step without agents: `{"…","agents":[],"wave":[],"pass":true,"blockers":[]}`.

### 7.2 `tenon agent prompt <change> <agent> [--host <id>] [--json]`

Starts (or resumes) a run and prints the prompt.

1. Resolve state, plan, frozen agents, runs, candidate, identity (and owner check from multi-user).
2. `<agent>` must be declared on the current step → else exit 2 `agent '<a>' 未在步骤 '<step>' 声明`.
3. `--host` given and frozen `hosts` excludes it → exit 2 `agent '<a>' 不支持宿主 '<host>'`.
4. Not runnable (§6.2) → exit 2 `agent '<a>' 还需等待：<waiting_for>`.
5. A `running` run of the same agent, visit and candidate exists → reuse it; otherwise append a `running` row.
6. Output prompt (text) or JSON `{"run_id","agent","role","model","tools","skills","hosts","report_path","prompt"}`.

Prompt layout (deterministic, `agent-prompt.ts`):

````text
<tenon-agent change="c" step="verify" role="reviewer" run="6f0c…">
候选：sha256:…
技能：react-best-practices, web-design-guidelines
工具：Read, Grep, Glob, Bash, Skill
阻断：medium
测试：
- code-size 通过 exit=0 reports/size.json
步骤说明：<step.prompt when present>
报告：openspec/changes/c/.pipeline-agent-reports/6f0c….md
结束：tenon agent record c 6f0c…
</tenon-agent>

<frozen agent body>

## tenon-result
报告末尾写一个 ```tenon-result``` 代码块：{"findings":[{"severity":"critical|high|medium|low","location":"<path:line>","message":"<一句话>"}]}
````

Executors get `{"result":"done|failed","findings":[…]}` in the last line. Reviewers with `reads_tests` whose current
result is missing are not runnable (`test:<id>`).

### 7.3 `tenon agent record <change> <run-id> [--json]`

1. Run exists, `status: running`, same step visit → else exit 1 `run '<id>' 不是本次步骤访问中进行中的运行`.
2. Identity present (and owner) → else exit 1 / 2 with the multi-user hint.
3. Report exists at `report_path`, ≤ 256 KiB, parses (§5.4) → else exit 1 `报告无效：<reason>`.
4. Reviewer: current candidate ≠ run candidate → exit 2 `评审期间候选已变化；重跑：tenon agent prompt <change> <agent>`
   (row stays `running`, projects as `stale`).
5. Append `finished` row with findings, derived or reported result, `report_digest`, `finished_at`.
6. Output `[AGENT] <change> <agent> <role> result=<r> findings=<n> blocking=<m>` or JSON row.

No `start`, `abandon`, `list` or `status` commands: `prompt` resumes, `next` shows state, the Dashboard shows the library.

## 8. Host delivery (contract for the `tenon` skill)

Nothing is written to `.claude/agents/`, `.codex/agents/` or any host agent dir; builtin sources live under
`templates/agents/`, which no host auto-discovers.

- Claude Code: for each wave, call `tenon agent prompt <c> <a> --host claude --json` for every agent of the wave, then
  dispatch all of them in one message with the Agent tool (`subagent_type: general-purpose`, `description: <agent>`,
  `prompt`, `model` when set). After each returns, `tenon agent record <c> <run_id>`.
- Codex: if the session offers a subagent tool, same as Claude Code (parallelism capped by the host,
  `research/harness-agents.md` Codex row). Otherwise one `codex exec --sandbox workspace-write [-m <model>] "<prompt>"`
  process per agent of the wave in the background, `wait`, then `record` each.
- Hosts without subagents (Cline, Zed, Pi, Aider; `research/harness-agents.md:47-48`): the main session runs each prompt
  itself in wave order, one at a time: `prompt` → do the work → write report → `record`. No isolation, no parallelism.
- `model` is passed only where the host accepts it; `tools` is rendered as instruction and is not enforced (a
  general-purpose subagent keeps its default tools). A reviewer that edits code is caught by candidate staleness
  (§7.3 step 4) and, on verify steps, by `build-head-unchanged`.

## 9. Progressive skill unlocking

`hooks/gate.sh` needs no change: every Skill tool call (`gate.sh:430-436`) and every trusted Codex `SKILL.md` read
(`gate.sh:454-459`) already reaches `tenon internal-skill-gate` (`gate.sh:372-417`). The hot-path rule (no node in the
common path, `.trellis/spec/cli/frontend/hook-guidelines.md:145,175`) is untouched.

`cli/src/commands/internalSkillGate.ts` changes:

- Delete `explicitReviewLane` and `requireActiveReviewAttempt` (`:91-153`) and their call (`:194-197`).
- Before the existing DAG logic (`:188-197`), for a plan whose current step declares agents:
  1. `S` = skills the step itself allows (step-declared `declared[].id`, or manifest slot alternatives for
     `manifest-overlay`, `:218-229`). Skill ∈ `S` → existing logic unchanged.
  2. `A` = union of frozen agents' `skills` for the step. Skill ∈ `A` → allow (exit 0, skip the DAG) iff some run in the
     current visit has `status: running`, is not `stale`, and its agent lists the skill; otherwise exit 2:
     `【Tenon 门】技能 '<s>' 属于 agent '<a>'（步骤 '<step>'）；先运行 tenon agent prompt <change> <a> 开始该 agent 后再加载`.
  3. Freeze or run ledger unreadable → exit 2 `【Tenon 门】步骤 '<step>' 的 agent 记录不可读：<reason>` (fail closed only
     for steps that declare agents; steps without agents keep today's fail-open catch at `:323-326`).
- Canonical `tenon:` namespace handling (`:70-76`) applies to agent skill ids as well.

Parallel agents of the same wave share the unlocked set (the gate cannot attribute a tool call to a subagent). This is
accepted: waves are declared by the user.

## 10. Guards

Forward exit = a transition whose target comes later in `plan.workflow.steps`, or the implicit `archived` self-edge
(`workflow/implicit-completion.ts`), or, for `phase-manifest`, an event whose `DEFAULT_EVENT_POLICY.enforceTaskExit`
is true (`flow/default-event-policy.ts:36-41`; `verify-fail`, `requirements-changed` are false). Send-back edges never
check agents.

```ts
// packages/kernel/src/workflow/agent-verdict.ts
export function isForwardExit(plan: EffectiveWorkflowPlan, from: string, to: string, event: string): boolean
// packages/kernel/src/workflow/transition-application-types.ts
stepAgentBlockers?: (input: {
  readonly changeDir: string; readonly stepId: string; readonly plan: EffectiveWorkflowPlan; readonly state: PipelineState
}) => Promise<readonly AgentBlocker[]>
// new rejection
| { readonly kind: 'step-agents-incomplete'; readonly workflowName: string; readonly stepId: string; readonly blockers: readonly AgentBlocker[] }
```

| Surface | Change |
| --- | --- |
| `tenon transition` | `TransitionApplication` calls `stepAgentBlockers` right after `missingStepSkills` (`transition-application.ts:303-317`) when `isForwardExit`; CLI wires it in `transition.ts:142-160` and renders `ERROR: step '<id>' 的 agent 未通过：` + one `renderAgentBlocker` line each, exit 2 (same mapping as `step-skills-incomplete`, `transition.ts:277-280`) |
| `tenon check` | both branches (`check.ts:84-86` graph → `checkGraphWorkflow` `:246-326`; default branch `:88-222`) add `[FAIL] agent: <line>` and count them; with `--event` of a send-back edge agents are skipped |
| `tenon review request` | unchanged code: success edges already run `cmdCheck` (`review.ts:125-143`), so the receipt is refused while required reviewers are not passed; `verify-fail` keeps its own readiness path |
| Readiness projection | `readinessByTransition` (`transition-readiness.ts:91`) gets `stepAgents?: () => Promise<readonly AgentBlocker[]>` in its context; forward edges add `{ kind: 'agents-incomplete', agents: [{ agent, reason: AgentBlocker['kind'] }] }` to `TransitionReadinessBlocker` (`:18-36`) |

Blocker lines (`renderAgentBlocker`), each naming the command that unlocks it (`guides/index.md:63-64`):

| Blocker | Line |
| --- | --- |
| `executor-missing` | `执行者 '<a>' 未运行；运行：tenon agent next <change>` |
| `executor-running` | `执行者 '<a>' 进行中；完成后：tenon agent record <change> <run>` |
| `executor-failed` | `执行者 '<a>' 失败；重跑：tenon agent prompt <change> <a>` |
| `reviewer-missing` | `评审者 '<a>' 未运行；运行：tenon agent next <change>` |
| `reviewer-running` | `评审者 '<a>' 进行中；完成后：tenon agent record <change> <run>` |
| `reviewer-stale` | `评审者 '<a>' 的结论已过期（候选已变化）；重跑：tenon agent prompt <change> <a>` |
| `reviewer-failed` | `评审者 '<a>' 未通过（<n> 个问题 ≥ <block_at>）：<location> <message>；…修复后重跑：tenon agent prompt <change> <a>` (first 5 findings) |
| `agent-records-invalid` | `agent 记录不可读：<reason>` |

Removed from guards: `verify-pass` agent/codex field guards (`default-event-policy.ts:92-93`, renderer `:197-201`) and the
legacy exit rows (`flow/guard.ts:101-102`). For default frontend/backend the reviewers of §13.2 now carry that check.

## 11. Server

### 11.1 Library routes

GET handlers next to `/api/skills/registry` (`server/src/serverGetRoutes.ts:253-259`); writes in
`server/src/serverAgentRoutes.ts`, dispatched from the POST/PUT/DELETE handlers (`server/src/server.ts:330-343`) with the
same Host guard + token check as workflow writes (`server/src/serverMutationRoutes.ts:302`).

| Route | Body | 2xx | Errors |
| --- | --- | --- | --- |
| `GET /api/agents` | — | `200 {"agents":[AgentSummary]}` | 500 |
| `GET /api/agents/:name` | — | `200 {"name","source","content","digest","references":[AgentReference]}` | 400 bad name, 404 |
| `POST /api/agents` | `{"name","content"}` | `201 {"agent":AgentSummary}` | 400 invalid / name ≠ frontmatter, 409 exists (either dir) |
| `PUT /api/agents/:name` | `{"content","digest"}` | `200 {"agent":AgentSummary}` | 400 invalid, 403 builtin, 404, 409 digest mismatch |
| `POST /api/agents/:name/copy` | `{"name"}` | `201 {"agent":AgentSummary}` | 400 bad name, 404, 409 exists |
| `DELETE /api/agents/:name?digest=` | — | `200 {"ok":true}` | 403 builtin, 404, 409 `{"ok":false,"error":"agent 被工作流引用","references":[…]}`, 409 digest mismatch |

```ts
interface AgentSummary { name: string; source: 'builtin' | 'custom'; description: string; skills: string[]; tools: string[]
  model?: string; hosts?: string[]; digest: string; error?: string }
interface AgentReference { workflow: string; track: string | null; step: string; label: string; role: 'executor' | 'reviewer' }
```

- Error strings: 403 `内置 agent 只读`, 409 exists `agent '<a>' 已存在`, 409 digest `agent 已被修改，请刷新`.
- References scan every workflow name of the global store (`workflow/global-store.ts` `workflowNamesUnder`) plus
  `default` (builtin or override) and `simple`, all branches. Frozen copies in Changes are not scanned: deleting a
  library file never affects a started Change.
- Workflow saves validate agent existence: `writeWorkflowForApi` (`server/src/workflows.ts:251`) and
  `handleWorkflowYamlPut` (`server/src/serverWorkflowYamlRoutes.ts:98`) → 400 `工作流引用了 agent 库中不存在的 '<a>'`.

### 11.2 Snapshot

- `server/src/agentRuns.ts`: `projectAgentRuns(changeDir, plan, state, candidate, testsReady): Promise<AgentRunsSnapshot>`
  where `AgentRunsSnapshot = Array<{ stepId: string; agents: AgentView[] }>`; current step uses §5.5, earlier steps show
  the latest runs of their last visit without staleness, later steps `idle`. Called where `projectSkillRuns` is
  (`server/src/snapshot.ts:33`, `server/src/skillRuns.ts:129-162`); optional field `agentRuns` on the change.
- Readiness: `snapshotWorkflowExecution` (`server/src/workflowSnapshot.ts:247-296`) passes `stepAgents`.
- Reports are opened with the existing `GET /api/documents/read` (`server/src/serverGetDocumentRoutes.ts:33-54`): root-
  relative, trusted read, 256 KB cap. No new report route.

## 12. Dashboard

### 12.1 Library (agents)

- View: the parent's library page (§7). If instruction-templates has not added it, this child adds `library` to `VIEWS`
  (`shell/views.ts:6`) and a lazy `LibraryView` in `App.tsx` (pattern `:24-28,327-344`), `ThreeColumns` layout
  (`component-guidelines.md:23-28`): rail = kinds (only `agent` from this child), list = agents, detail = editor.
- `library/AgentList.tsx`: search input (`lib-agent-search`), rows `lib-agent-<name>` = mono name + source icon (builtin
  `Cpu`, custom `User`, reuse `SkillSourceIcon` icons `workflow/SkillSourceIcon.tsx:5-10`) + truncated description;
  `+` (`lib-agent-new`) in the column head. Invalid entry shows `error` in red text.
- `library/AgentDetail.tsx`: `DetailColumn` header (H1 name, mono digest, `StatusPill` 内置 / 自定义); `SheetTabs`
  编辑 / 预览 (`lib-agent-sheet-edit|preview`); edit = mono `<textarea>` (`lib-agent-content`) disabled for builtin;
  preview = frontmatter key table (技能 · 工具 · 模型 · 宿主) + `shared/Markdown.tsx` body; footer 保存 (`lib-agent-save`),
  复制 (`lib-agent-copy`, dialog with 名称 input `lib-agent-copy-name`), 删除 (`lib-agent-delete`, inline confirm; 409
  lists references `workflow › track › step · 身份` rows). Builtin: only 复制. Write controls disabled without token
  (`component-guidelines.md:159-160`). Errors through `formatApiError` into `detail` (`:283-284`).
- `api/agentClient.ts` + `api/agentSchema.ts` (closed decoders) + `library/useAgentLibrary.ts`.

### 12.2 Workflow page

- `WbStepDef` (`api/governanceTypes.ts:102-114`): remove `reviewLanes`; add `agents?: { executors: WbExecutorRef[];
  reviewers: WbReviewerRef[] }`. `WbSkillRef` (`:45-46`) drops `kind`/`review_lane`. Decoder `decodeStep`
  (`api/governanceSchema.ts:384-410`) and `decodeSkill` (`:108-118`) updated; `cloneSteps`
  (`workbench/workbenchDefinition.ts:298-310`) clones `agents`; new `setStepAgentsInDef(def, stepId, role, refs)` next
  to `setStepSkillsInDef` (`:177-179`); `useWorkflowEditor` gains `setAgents(stepId, role, refs)` (`:107-113` pattern).
  Empty lists on both roles remove the `agents` key.
- `StageEditorPane` sections (`workflow/StageEditorPane.tsx:142-190`) become 输入 → 技能 → 执行者 → 输出 → 评审者 → 门禁 →
  退回. Executors after skills (they produce outputs); reviewers right before the gate, as a separate section.
  - `stage-executors` / `stage-reviewers`: `SectionHead(title, count, 编辑)` (`wb-executors-edit`, `wb-reviewers-edit`) +
    read-only `SkillFlow` (`:159` pattern) with nodes `{ id: agent, depends_on }` and registry mapped from
    `AgentSummary` (`source` builtin → `builtin`, custom → `user`). Empty → noun `无`.
  - `SkillFlow` gets one optional prop `captionOf?: (id: string) => string | null` rendered under the node name;
    reviewers caption `必需 · 中` / `参考 · 高` (+ ` · 测试 n`). No other SkillFlow change.
- `workflow/AgentComposer.tsx` (dialog, same three-column mechanics as `SkillComposer.tsx:11-18,59`): palette = agent
  library (`palette-agent-<name>`, drag or `+`), canvas = editable `SkillFlow` (edge = `depends_on`, `wouldCycle`),
  right column = selected node: reviewers get 必需/参考 radio (`wb-agent-required-<name>`), 阻断 select
  (`wb-agent-block-<name>`: 严重/高/中/低), 测试 chips from the step's `tests[].id` (`wb-agent-tests-<name>`); below, the
  agent Markdown preview. 保存 → `editor.setAgents`.
- Lint (`workflow/lint.ts`): `agent-missing` (not in `GET /api/agents`) blocks save with `agent <name> 不存在`.

### 12.3 Workspace

- Snapshot type + decoder: optional `agentRuns` (like `skillRuns`, `api/snapshotDecoder.ts:56,183,201,221`); readiness
  blocker decoder accepts `agents-incomplete` (strict decoder drops the whole change on unknown shapes,
  `snapshotDecoder.ts:314-327`).
- `workspace/TaskDetailPane.tsx`: section `stage-agents` right after `stage-skills` (`:104-109`), title `agent` + count,
  read-only `SkillFlow` where reviewers depend on the last executor wave, `statusOf` (`:60-63` pattern) →
  `idle` 未运行 / `running` 进行中 / `done` 通过 · 不通过 · 完成 · 失败 (+ ` · 问题 n`) / stale shown as `idle` with label 过期.
  Hidden when the step declares no agents.
- `workspace/AgentRunDrawer.tsx` (shared `Drawer`): header agent name; one row 身份 · 结论 · 问题 n · 操作人 · 时间;
  findings table 级别 · 位置 · 说明 (nowrap, truncate, full text on `title`); 报告 = `Markdown` of
  `/api/documents/read?path=<reportPath>`.

### 12.4 i18n keys (zh / en, `i18n/translations.ts`)

`workflow.executors_title` 执行者, `workflow.reviewers_title` 评审者, `workflow.agent_required` 必需,
`workflow.agent_advisory` 参考, `workflow.agent_block_at` 阻断, `workflow.severity_critical` 严重,
`workflow.severity_high` 高, `workflow.severity_medium` 中, `workflow.severity_low` 低, `workflow.agent_tests` 测试,
`workflow.no_agents` 无, `workflow.lint_agent_missing` agent {name} 不存在;
`library.agent` agent, `library.builtin` 内置, `library.custom` 自定义, `library.new` 新建, `library.edit` 编辑,
`library.preview` 预览, `library.save` 保存, `library.copy` 复制, `library.delete` 删除, `library.name` 名称,
`library.references` 引用, `library.skills` 技能, `library.tools` 工具, `library.model` 模型, `library.hosts` 宿主;
`workspace.agents` agent, `workspace.agent_executor` 执行者, `workspace.agent_reviewer` 评审者,
`workspace.agent_pass` 通过, `workspace.agent_fail` 不通过, `workspace.agent_done` 完成, `workspace.agent_failed` 失败,
`workspace.agent_running` 进行中, `workspace.agent_stale` 过期, `workspace.agent_idle` 未运行,
`workspace.agent_findings` 问题 {n}, `workspace.agent_actor` 操作人, `workspace.agent_report` 报告,
`workspace.finding_severity` 级别, `workspace.finding_location` 位置, `workspace.finding_message` 说明.
Removed: `review_agent_review_result`, `review_codex_review_result` (`translations.ts:490-491,2433-2434`),
`policy_review_budget(_desc)` (`:808-809,2740-2741`) once unreferenced.

## 13. Removals and migration

### 13.1 Deleted

- Kernel: `state/review-attempt-budget.ts`, `-model.ts`, `-io.ts` and their tests; exports `state/index.ts:19-34`;
  `WorkflowReviewBudgetPolicyV1` and every `reviewBudget` path (§2 row); `reviewLanes`, `SkillRef.kind`,
  `SkillRef.review_lane` (§2 row); `flow/manifest.ts` `review_skills` + `reviewSkillLanes`; resolver `reviewLaneFor`;
  verify-pass field guards and renderer lines; `flow/guard.ts:101-102`; `GUARD-RULES.md` rows.
- CLI: `commands/review-attempt.ts`, `registerAutomatedReviewCommands` (`program-review.ts:27-48`),
  `review-attempt.integration.test.ts`, review-lane branch of `internalSkillGate.ts`, `field-values.ts:21-22`.
- Templates: `templates/manifest.yaml:62-65`, `review_budget` + `review_lanes` in `default.yaml`/`simple.yaml`,
  `agents/*.md` (moved), review-attempt and `agent_review_result`/`codex_review_result` steps in
  `skills/tenon-verify/SKILL.md:74-102,339-368,406-420`.
- Server: review field nodes except `pre_verify_review_result` (`orchestrationGraph.ts:206-210`).
- Dashboard: `reviewLanes`/`kind`/`review_lane` in types, decoders, `workbenchDefinition.ts:301`; i18n keys above.
- Oracle fixtures that assert the removed verify-pass messages (`tools/oracle/fixtures/default-guard-errors.sh`) drop
  those cases; the oracle's FIELD_ORDER strings (`tools/oracle/run.sh:120-124`) stay because the wire slots stay.

### 13.2 Default and simple workflows

| Branch · step | Before | After |
| --- | --- | --- |
| all | `review_budget` (`default.yaml:2-4`) | removed |
| frontend · verify (`:370-399`) | `review_lanes: [standards, spec, e2e]` | `reviewers`: `spec-consistency`, `frontend-quality`, `security`, `e2e` (`required: true`, `block_at: medium`, parallel); `architecture` (`required: false`, `block_at: high`, `depends_on` the four) |
| backend · verify (`:519-544`) | same | `spec-consistency`, `backend-quality`, `security` (`required: true`, `block_at: medium`); `architecture` advisory after them |
| pm · verify (`:222-251`) | same | no agents (old flow: no reviewer agent, `skills/tenon-verify/SKILL.md:131`) |
| free · verify (`:660-685`) | same | no agents (old guard exempted free, `default-event-policy.ts:92-93`) |
| chat · verify (`:84-108`) | same | no agents (drivers-only branch) |
| simple · verify (`simple.yaml:24-28`, `builtin-workflows.ts:30-31`) | lane `e2e`, skill `kind: review` | plain skill `verification-before-completion` |

`block_at: medium` keeps the old PASS rule "no CRITICAL/HIGH/MEDIUM" (`agents/tenon-reviewer.md:40-41`). Executors,
`code-size` and tests in default are added by data-driven-runner. `default-workflow.generated.ts` is regenerated by the
main session after merge (parent `implement.md:21-22`).

### 13.3 Frozen workflow snapshots

- Removing `reviewBudget` changes the fingerprint input (`workflow/effective-plan.ts:116-133`), and a v3 snapshot without
  `reviewBudget` is already read as a pre-policy snapshot (`effective-plan.ts:266-290`). New Changes therefore write
  **snapshot v4** = v3 keys minus `reviewBudget` (`state/workflow-plan-snapshot.ts:53-57` gains a `version === 4` key
  list), fingerprinted with schema `effective-workflow-plan-v4` = the v3 input minus `reviewBudget`. Agents are not part of
  the fingerprint (they are frozen in the sidecar, §5.1).
- Reading v1–v3 stays. `validateV3WorkflowPolicies` / `historicalV3WorkflowFingerprint`
  (`workflow/effective-plan-snapshot-compat.ts:215-281`) keep hashing the stored `reviewBudget` object verbatim (or the
  literal `{"version":"v1","max_attempts":2}` when absent) so historical fingerprints still verify; nothing else reads it.
- Stored IR JSON of old snapshots may carry `reviewLanes` / `kind` / `review_lane`; restore ignores them.

### 13.4 Retired canonical state slots

`agent_review_result` and `codex_review_result` stay in `FIELD_ORDER` (`kernel/src/types.ts:23`) as reserved, always-
empty slots: the canonical codec requires the exact closed field set (`state/run-revision-codec.ts:272-274`) and revision
digests hash `state.fields` (`:338-340`), so dropping them would make every stored revision unreadable. Every reader and
writer is removed; `tenon set` rejects them with `字段 '<f>' 已删除`; Dashboard never shows them. The track policy key
`review_seed` (required by `tracks/validate.ts:254-256`) only seeds these slots (`state-init.ts:103-104`) and is left for
the same schema bump. Physical removal of both belongs to version-reset (§17 CCR-3).

## 14. Validation and error matrix

| Condition | Surface | Result |
| --- | --- | --- |
| Frontmatter key outside closed set / missing name or description / empty body / >64 KiB | kernel parse, `POST/PUT /api/agents` | `AgentFileError`; HTTP 400 `agent 文件无效：<field> <reason>` |
| `name` ≠ file / path name | same | 400 `frontmatter name 与文件名不一致` |
| Custom name equals a builtin | `POST`, copy | 409 `agent '<a>' 已存在` |
| Same name in both dirs on disk | library load | entry `error: 名称冲突`; `resolve` throws `agent-conflict`; init aborts |
| Builtin payload file invalid | builtin sync | throw (release bug), CLI exit 1 `内置 agent '<a>' 无效` |
| PUT/DELETE builtin | server | 403 `内置 agent 只读` |
| PUT/DELETE stale digest | server | 409 `agent 已被修改，请刷新` |
| DELETE referenced | server | 409 with `references` |
| Workflow references unknown agent | server save, `tenon init` | 400 / exit 1 `工作流引用了 agent 库中不存在的 '<a>'` |
| YAML uses `review_lanes` / `review_budget` / `kind` / `review_lane` | parse | load error `'<key>' 已删除——评审改用步骤 agents.reviewers` |
| §4.3 compile / validate rules | compile, validate, Dashboard lint | error at YAML path, save blocked |
| Freeze lock missing on a step with agents | agent CLI, guards, gate | exit 1 / blocker `agent-records-invalid` / gate exit 2 |
| Frozen file digest mismatch / lock bound to other run or fingerprint | same | `freeze-corrupt` / `freeze-binding` |
| Identity missing | `prompt`, `record` | exit 1 with multi-user setup hint |
| Not the owner | `prompt`, `record` | exit 2 with multi-user take-over hint |
| Agent not declared on current step | `prompt` | exit 2 |
| Host not in `hosts` | `prompt --host` | exit 2 |
| Dependencies / executors / tests not ready | `prompt` | exit 2 `还需等待：…` |
| Run not running / other visit | `record` | exit 1 |
| Report missing / no or malformed `tenon-result` / reviewer supplies `result` | `record` | exit 1 `报告无效：…` |
| Candidate changed during review | `record` | exit 2, run projects `stale` |
| Ledger line corrupt / over limits | all readers | exit 1; guards blocker `agent-records-invalid` |
| Required reviewer fail / stale / missing / running; executor missing / running / failed | transition (forward), `check`, `review request` | exit 2 with §10 lines |
| Advisory reviewer fail | same | no blocker |
| Send-back edge (`verify-fail`, `requirements-changed`, custom `to` earlier) | transition, check `--event` | agents not evaluated |
| Agent skill loaded before its agent runs | `internal-skill-gate` | exit 2 naming the agent and `tenon agent prompt` |
| Agent skill loaded while its run is running | same | exit 0 |
| Step-declared skill that also belongs to an agent | same | existing DAG rule |

## 15. Tests required

Kernel (`npx vitest run packages/kernel/src/...`)

- `agents/agent-file.test.ts`: valid file round-trip of every field; each closed-set violation from §3.1 throws with the
  field name; name ≠ file; CRLF body kept verbatim in digest; 64 KiB boundary.
- `agents/library.test.ts`: builtin sync writes files and `.builtin.json`; second call is a no-op (mtime unchanged);
  payload change rewrites builtin and leaves `custom/` byte-identical; conflict entry; atomic write refuses symlink;
  every file in `templates/agents/` parses.
- `workflow/agents-schema.test.ts`: parse block + inline forms equal; defaults `required: true`, `block_at: high`;
  serialize → parse deep-equal; both-empty lists omit `agents`; every §4.3 error string; removed keys error; track branch
  prefix `tracks.<id>:` on validation errors; `effective-plan` exposes `capabilities.agents` and no `reviewBudget` /
  `laneScopes`.
- `workflow/effective-plan.test.ts`, `policy-snapshot.test.ts`, `build-revision.acceptance.test.ts`: historical v1–v3
  snapshots still restore with their stored fingerprints; a v3 snapshot with `reviewBudget` restores; a new plan writes
  snapshot v4 with no `reviewBudget` key and restores with an identical fingerprint; tampered v4 → binding error.
- `state/agent-freeze.test.ts`: freeze writes files + lock; idempotent for same run; read verifies digest; tampered file →
  `freeze-corrupt`; other run id → `freeze-binding`; library edit after freeze does not change `readFrozenAgents`.
- `state/agent-runs.test.ts`: last row wins; trailing partial line ignored; corrupt middle line → `runs-corrupt` with line
  number; limits; concurrent appends under lock keep every row (crossprocess helper pattern of
  `review-attempt-budget.crossprocess.integration.test.ts`); report parser accepts/rejects per §5.4; severity rank.
- `workflow/agent-verdict.test.ts`: state table §5.5 (every cell); verdict blockers per state; advisory never blocks;
  waves and runnable rules §6.2 incl. `test:<id>`; `isForwardExit` for default events and custom back edges;
  `renderAgentBlocker` exact lines.
- `flow/default-event-policy.test.ts`, `flow/guard.test.ts`: verify-pass no longer mentions agent/codex fields.

CLI (`npx vitest run packages/cli/src/...`)

- `commands/agent.test.ts` (unit with fake deps): `next` JSON shape; `prompt` refuses undeclared / host / waiting with
  exit 2; `prompt` twice returns the same `run_id`; prompt text contains frozen body and header lines; `record` derives
  `fail` when a finding ≥ `block_at`, `pass` below; executor `failed`; candidate change → exit 2.
- `agent.integration.test.ts` (real bundle, `integration-harness.ts`): custom workflow with build executors ×2 parallel,
  build reviewers 2 parallel + 1 depending on both, verify reviewers; init freezes; editing a custom agent after init leaves
  the Change prompt unchanged and a new Change sees the edit; transition from build blocked with `评审者 ... 未运行`;
  record failing report → blocked with finding location; changing a file → `过期`; rerun pass → transition succeeds;
  advisory fail does not block; `verify-fail` back edge ignores agents.
- `review.integration.test.ts`: `review request --event <forward>` exit 2 while a required reviewer is missing, no
  `.pipeline-pending-review` written; succeeds after pass.
- `commands/internalSkillGate.test.ts` + `internal-skill-gate-hook.integration.test.ts`: agent skill blocked with message
  naming agent; allowed while its run is running; blocked again after `record`; step-declared skill unaffected;
  unreadable ledger on an agent step → exit 2; step without agents keeps fail-open on internal errors; Codex
  `tenon:<id>` namespace.
- `commands/check.test.ts`, `commands/transition.test.ts`, `transition-effects.integration.test.ts`: removed field guards;
  `[FAIL] agent:` lines in both branches.
- `commands/field-values` via `fields.test.ts`: `tenon set <c> agent_review_result pass` → exit 1 `已删除`.
- `init-workflow.integration.test.ts`: unknown agent → exit 1 and no Change directory left.

Server (`npx vitest run packages/server/src/...`)

- `serverAgentRoutes.test.ts`: every row of §11.1 incl. token required, 403/404/409 bodies, references list for default
  and a global workflow branch, copy of builtin creates custom, delete removes palette entry.
- `workflows.test.ts` / `runtimeWorkflowEditor.integration.test.ts`: save with unknown agent → 400; YAML import round trip
  keeps `agents`.
- `agentRuns.test.ts` + `snapshot.test.ts`: projection states, earlier-step history, readiness `agents-incomplete` on
  forward edges only.
- `orchestrationGraph.test.ts`: no agent/codex review nodes.

Dashboard (`npm run test:web -- <files>`)

- `api/governanceSchema.test.tsx`: `agents` decode/encode, rejects extra keys, no `reviewLanes`.
- `api/snapshotDecoder` tests: `agentRuns` optional; `agents-incomplete` blocker accepted; unknown kind still rejected.
- `workflow/StageEditorPane.test.tsx`: section order by testids (`stage-inputs`, `stage-skills`, `stage-executors`,
  `stage-outputs`, `stage-reviewers`, `stage-gate`); captions `必需 · 中`; `data-nodes` counts.
- `workflow/AgentComposer.test.tsx`: add via `+`, required/advisory toggle and block select write refs; save calls
  `setAgents`; cycle refused (pure `wouldCycle`); YAML written back equals expected `agents` block via
  `workbenchDefinition` tests.
- `library/AgentLibrary.test.tsx`: builtin has no textarea edit and no delete; copy dialog posts; save sends digest; 409
  references rendered as rows; preview renders frontmatter table; nothing wraps (`whitespace-nowrap` classes asserted
  on rows).
- `workspace/TaskDetailPane` tests: `stage-agents` hidden without agents; node `data-status` and labels 通过 / 过期 /
  问题 n; drawer shows actor and findings, fetches report path.

Hooks and bundle

- `bash tools/test-hooks.sh`: new case — active Change on an agent step, Skill tool for an agent skill → exit 2 message;
  after writing a running row → exit 0.
- `bash tools/test-bundle.sh`: builtin agents present under `templates/agents/`, no `agents/` dir at plugin root.
- `node tools/check-agents.mjs` (`npm run check:agents`): every builtin parses; every skill id exists in the payload.

Real hosts (acceptance, with data-driven-runner's `tenon` skill): one custom workflow in Claude Code and one in Codex
per prd AC — order of runs in `.pipeline-agent-runs.jsonl` matches waves; `/agents` in an unrelated Claude Code session
lists no Tenon agent; blocked skill message observed; Dashboard shows runs with actor.

## 16. Decisions made during design

1. **Freeze in a sidecar, not in the fingerprint.** `compileEffectiveWorkflowPlan` is called at many sites without library
   access, and fingerprints are compared on attach and pin (`workflow-plan-snapshot.ts:171-174`,
   `state-projection.ts:85-90`). A lock bound to `run_id` + fingerprint gives the same guarantee without putting library
   content into the fingerprint. The only fingerprint schema change is v4 for the `reviewBudget` removal (§13.3). (CCR-2)
2. **One row per state change, last wins**, with `status`, `step`, `report_digest`, `schema` added to the parent record.
   Needed for "running" (skill unlocking) without a second file. (CCR-1)
3. **Reviewer result is computed by Tenon** from findings and `block_at`; executors report `done|failed`.
4. **Single report file with a `tenon-result` block** instead of separate findings JSON: works when only the final message
   is available (`codex exec`), one path to validate.
5. **Executors are required to finish before leaving a step and before reviewers run.** Declaring executors without any
   check would be dead configuration.
6. **Staleness by candidate only for reviewers**; runs are scoped to the step visit, so a new visit starts clean.
7. **Agents are checked only on forward exits**; send-back edges stay available to fix problems.
8. **No review budget replacement.** Reruns are explicit `prompt` calls; AFK loops keep their own limits.
9. **`hosts` is enforced only when `--host` is given; `tools` is instruction only.** Hosts cannot restrict a
   general-purpose subagent's tools; candidate staleness catches edits.
10. **Parallel agents in one wave share unlocked skills.** Hooks cannot attribute a tool call to a subagent.
11. **Builtin sources move to `templates/agents/`** so no host auto-loads them; builtin names drop the `tenon-` prefix;
    `tenon-reviewer` and `tenon-design-reviewer` fold into `frontend-quality` / `backend-quality`.
12. **Builtin sync is lazy on every library load plus explicit in setup/update**, idempotent by source digest.
13. **Retired review fields keep their wire slots** until the version-reset schema bump; all behavior is gone now. (CCR-3)
14. **Default workflow keeps its old strictness** (`block_at: medium`) and old exemptions (pm, free, chat without agents).
15. **Section order 输入 → 技能 → 执行者 → 输出 → 评审者 → 门禁 → 退回**; reviewers are separate from the gate section.
16. **Reports open through `/api/documents/read`**; no new report route.
17. **CLI surface is three commands** (`next`, `prompt`, `record`); `prompt` starts or resumes.

## 17. Contract change requests (parent `design.md`, not edited here)

- **CCR-1 (§5 records):** `.pipeline-agent-runs.jsonl` rows add `schema: "agent-run/v1"`, `step`, `status: running|finished`,
  `report_digest`; append-only, last row per `run_id` wins; `result` enum `pass|fail` (reviewer) / `done|failed`
  (executor); reports at `<change>/.pipeline-agent-reports/<run_id>.md` with a trailing `tenon-result` block.
- **CCR-2 (§4 freezing):** replace "the workflow snapshot freezes their content digests together with the workflow
  fingerprint" with a shared Change sidecar `<change>/.pipeline-frozen/lock.json`
  `{version, run_id, workflow_fingerprint, agents[], test_directions[]}` plus frozen copies under
  `.pipeline-frozen/agents/` and `.pipeline-frozen/test-directions/`; the workflow fingerprint does not include agent or
  test-direction digests. test-evidence uses the same lock.
- **CCR-3 (§4 removed keys):** "Removed keys" becomes: YAML `review_lanes`, `review_budget`, skill `kind`/`review_lane`,
  manifest `review_skills`, CLI `review-attempt`/`review-budget`; `agent_review_result`/`codex_review_result` lose all
  behavior but keep reserved canonical wire slots, and track policy `review_seed` stays, until version-reset bumps the
  state wire schema and removes them together.
- **CCR-4 (§3 builtin content):** name one shared `syncBuiltinDir` helper (`kernel/src/library/builtin-sync.ts`, first
  lander owns) and its triggers (lazy on library load + end of `tenon setup` / `tenon update`); plugin builtin sources live
  under `templates/<kind>/`, never at plugin root `agents/`.
- **CCR-5 (§7 surfaces):** library page view id `library`, `ThreeColumns` with a rail of kinds (agent, 模板, 资源目录,
  测试方向); owner of the shell: instruction-templates.
- **CCR-6 (§4 YAML):** flow-style items in the example require `parseInlineMap` in `workflow/parse-primitives.ts`, shared
  by review-agents and test-evidence; serialize always writes block style.
- **CCR-7 (§7 workspace detail):** snapshot readiness blockers gain `agents-incomplete` (and test-evidence's equivalent);
  the Dashboard decoder change ships in the same commit as the server change.
