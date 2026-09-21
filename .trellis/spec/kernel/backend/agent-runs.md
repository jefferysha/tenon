# Task Agents: Library, Freeze, Runs and Verdict (`agents/`, `state/`, `workflow/`)

## 1. Scope / Trigger

- Trigger: any change to the agent library, the per-step `agents:` block, the run ledger, the leave-step
  verdict, or the `tenon agent` commands.
- An agent is an executor or a reviewer **declared by a workflow step**. The role is not written in the
  agent file; the step decides it. Agent files are unrelated to instruction files (`AGENTS.md`, `CLAUDE.md`).
- Tenon never runs a model. It decides who runs next, hands the host a prompt, and records what came back.

## 2. Signatures

```ts
// agents/types.ts — closed frontmatter contract
AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/   AGENT_FILE_MAX_BYTES = 64 * 1024
AGENT_DESCRIPTION_MAX = 200                   KNOWN_AGENT_HOSTS = INSTRUCTION_HOSTS.map(h => h.id)
interface AgentDefinition { name; description; skills[]; tools[]; model?; hosts?; body }

// agents/parse.ts
parseAgentFile(text: string, expectedName: string): AgentDefinition   // throws AgentFileError
agentDigest(text: string): string                                      // 'sha256:<hex>'

// infrastructure/agent-store.ts — <configRoot>/agents/{builtin,custom}
agentStoreRoot(configRoot): string
ensureBuiltinAgents(options): Promise<BuiltinSyncResult>
loadAgentLibrary(options): Promise<AgentLibrary>
resolveAgent(library, name): AgentEntry & { definition: AgentDefinition }
writeCustomAgent(storeRoot, name, content, { create?, digest? }): Promise<AgentEntry>
deleteCustomAgent(storeRoot, name, digest?): Promise<void>
prepareAgentFreeze(workflow, loadLibrary): Promise<(name) => { source; content }>
class AgentStoreError { code: 'agent-missing' | 'agent-invalid' | 'agent-conflict' | 'agent-exists'
                              | 'agent-builtin-readonly' | 'agent-stale' }

// state/agent-freeze.ts — <change>/.pipeline-frozen/{lock.json,agents/<name>.md}
agentsReferenced(workflow: WorkflowIR): readonly string[]
ensureAgentFreeze({ changeDir, runId, workflowFingerprint, workflow, resolve }): Promise<AgentFreezeLock | undefined>
readFrozenAgents({ changeDir, runId, workflowFingerprint }): Promise<ReadonlyMap<string, FrozenAgent>>
class AgentFreezeError { code: 'freeze-missing' | 'freeze-corrupt' | 'freeze-binding' }

// state/agent-runs.ts — <change>/.pipeline-agent-runs.jsonl, <change>/.pipeline-agent-reports/<run>.md
readAgentRuns(changeDir): Promise<readonly AgentRunRow[]>
appendAgentRunRow(changeDir, row: AgentRunRow): Promise<void>
parseAgentReport(text, role): ParsedAgentReport
severityRank(severity): number                  // low 1 … critical 4
class AgentRunError { code: 'runs-corrupt' | 'runs-limit' | 'report-invalid' | 'run-not-running' | 'candidate-changed' }

// workflow/agent-verdict.ts
projectStepAgents(input: StepAgentsInput): readonly AgentView[]
evaluateStepAgents(input): { pass: boolean; blockers: readonly AgentBlocker[] }
nextAgentWave(input): { wave: readonly string[]; waiting: readonly { agent; for: string[] }[] }
isForwardExit(plan, from, to, event): boolean
renderAgentBlocker(blocker, change): string
```

## 3. Contracts

- **Library**: builtin agents sync from `<payloadRoot>/templates/agents` through the shared
  `BUILTIN_LIBRARIES` row; custom agents live beside them under `<configRoot>/agents/custom`. The library is
  global — never per project, never per Change. A custom file with a builtin's name is recorded as a
  conflict and excluded: a builtin is never shadowed.
- **Declaration**: a step declares `agents: { executors[], reviewers[] }`. An executor is
  `{ agent, depends_on? }`; a reviewer is `{ agent, required, block_at, depends_on?, reads_tests? }` with
  `required: true` and `block_at: high` as the parse defaults. Both lists empty ⇒ no `agents` key
  (round-trip law). An agent in both lists of one step is a compile error; `reads_tests` must name an id
  the same step declares.
- **Freeze**: `tenon init` writes every agent the selected branch references into
  `<change>/.pipeline-frozen/`, with a lock bound to `run_id` + `workflow_fingerprint`. Agent bytes stay out
  of the workflow fingerprint (the plan is compiled in places with no library access); the lock gives the
  same guarantee — editing the library never changes a Change already under way. A new Change picks up
  the edit.
- **Ledger**: `.pipeline-agent-runs.jsonl` is append-only; each state change writes a whole row, and the
  **last row per `run_id` wins**. `running` rows are what the skill gate reads, so no second file is needed.
  The relevant run for a verdict is the last one for that agent **within the current step visit**
  (`step_visit`); rows from an earlier visit are history.
- **Verdict** (`evaluateStepAgents`, declaration order): every executor must be `done` with result `done`;
  every **required** reviewer must be `done` and pass on the **current candidate**. Advisory reviewers never
  block. A reviewer's result is computed, never self-reported: findings at or above `block_at`
  (`severityRank(finding) >= severityRank(block_at)`) make it `fail`.
- **Candidate**: the reviewer staleness key is the build token (`sha256:<revisionHash>`), else the
  workspace fingerprint. Executors are never judged stale — they are the ones changing the code.
- **Waves** (`nextAgentWave`): `wave(x) = 0` with no dependency, else `1 + max(wave(deps))`. Within a step
  the order is always executor waves → required tests → reviewer waves. A reviewer waits for every
  executor, for required tests, and for the reviewers it depends on to have a verdict on the current
  candidate.
- **Gate**: only **forward** exits check agents (`isForwardExit`: a later step, the implicit completion
  self-edge, or a `phase-manifest` event with `enforceTaskExit`). Back edges (`verify-fail`,
  `requirements-changed`, custom back edges) never check agents — the road to fixing things stays open.
- **Skill gate**: a skill a step declares only through an agent's `skills` unlocks while that agent has a
  `running` row; otherwise the progressive gate answers as before. The workspace fingerprint is computed
  only when such a row exists.

## 4. Validation & Error Matrix

| Condition | Where | Result |
| --- | --- | --- |
| Frontmatter key outside the closed set, missing `description`, file > 64 KiB | `parseAgentFile` | `AgentFileError` (`agent-file-invalid`), names the field |
| Step references an agent the library does not have | workflow validate / server PUT | `agent 库中不存在 '<name>'`, definition not stored |
| Same agent as executor and reviewer of one step | compile | `<path>: agent '<a>' 在同一步骤不能既是执行者又是评审者` |
| `reads_tests` id not declared by the step | validate | `step '<id>' 的评审者 '<a>' 读取的测试 '<t>' 未在本步骤声明` |
| Freeze lock missing / corrupt / bound to another run or fingerprint | `readFrozenAgents` | `AgentFreezeError` — fails closed, the step's agents cannot run |
| Malformed ledger line | `readAgentRuns` | `AgentRunError('runs-corrupt')` naming the line number — guards fail closed, never “no review” |
| Report without a trailing ```tenon-result``` block, or a reviewer self-reporting `result` | `parseAgentReport` | `AgentRunError('report-invalid')` (`评审者不自报结论，结论由阻断级别计算`) |
| `tenon agent record` when the candidate moved since the run started | `cmdAgentRecord` | `AgentRunError('candidate-changed')`, exit 2 |
| Forward transition with an unsatisfied step agent | transition | rejected `step-agents-incomplete`, one line per blocker from `renderAgentBlocker` |

## 5. Good / Base / Bad Cases

- Good: `build` declares executor `builder`; `verify` declares required reviewer `security` at `block_at:
  high`. `tenon agent next` offers `builder`, then after its `done` row the reviewer wave.
- Base: an advisory reviewer reports two `medium` findings — the step still leaves; the findings show in the
  workspace and in the report.
- Bad: a reviewer ran, then the code changed. The old verdict is `stale`, the forward exit is blocked, and
  the blocker line names `tenon agent prompt <change> <agent>`.

## 6. Tests Required

- `agents/parse.test.ts`: closed key set, size and description limits, host closed set.
- `infrastructure/agent-store.test.ts`: builtin sync, builtin/custom conflict, `agent-stale` on a digest
  mismatch, builtin write refused.
- `state/agent-freeze.test.ts`: lock binding to run id + fingerprint, tampered frozen file, library edited
  after freeze.
- `state/agent-runs.test.ts`: last row per `run_id` wins, corrupt line names the line, the **last**
  `tenon-result` block wins over an example block in the body.
- `workflow/agent-verdict.test.ts`: executor/reviewer blockers, advisory never blocks, staleness, wave
  order, back edges unchecked.
- `cli/agent.integration.test.ts`: `next` / `prompt` / `record` end to end, host mismatch, candidate moved.

## 7. Wrong vs Correct

### Wrong

```ts
// Reading the live library while a Change is running — an edit would change a task under way.
const agent = resolveAgent(await loadAgentLibrary(options), name)
```

### Correct

```ts
// The frozen copy of this run, bound to run_id + workflow_fingerprint.
const frozen = await readFrozenAgents({ changeDir, runId, workflowFingerprint: plan.workflowFingerprint })
const agent = frozen.get(name)
```
