# Agent Library Routes (`serverAgentRoutes.ts`, `agentReferences.ts`)

## 1. Scope / Trigger

- Trigger: any change to `/api/agents*`, to the reference scan behind a delete, or to the `agentRuns`
  snapshot projection.
- The library is **global**: the routes take no `root`. Builtin agents are synced by the kernel from the
  plugin payload; custom agents are written under the same config root.

## 2. Signatures

```ts
// serverAgentRoutes.ts — GET has its own Host guard; write methods are guarded and authenticated by the router
resolveAgentGet(req, path, deps): Promise<AgentRouteResult> | null
resolveAgentMutation(req, method: 'POST' | 'PUT' | 'DELETE', path, deps): Promise<AgentRouteResult> | null

// agentReferences.ts
agentReferences(paths: ServerPaths, agent: string): readonly AgentReference[]
missingWorkflowAgents(paths, workflow, payloadRoot?): readonly string[]
interface AgentReference { workflow: string; track: string | null; step: string; label: string; role: 'executor' | 'reviewer' }

// agentRuns.ts
projectAgentRuns(input: AgentRunsInput): Promise<AgentRunsSnapshot>
agentBlockersOf(runs, plan, phase): readonly AgentBlocker[]
```

## 3. Contracts

- Routes: `GET /api/agents` (summaries + builtin sync state), `GET /api/agents/:name` (content, digest,
  references), `POST /api/agents` (create), `POST /api/agents/:name/copy`, `PUT /api/agents/:name`
  (`content` + optional `digest` for optimistic concurrency), `DELETE /api/agents/:name?digest=`.
- The summary never carries the body: the list stays small and the dashboard fetches one agent on demand.
  A file that fails to parse still appears, with `error`.
- `DELETE` checks **builtin first**, then references: a builtin referenced by the default workflow must
  answer `403 内置 agent 只读`, not “referenced”. A referenced custom agent answers `409` **with the
  references**, so the dashboard can list where it is used instead of guessing.
- Writing a workflow YAML (`PUT /api/workflows/:name/yaml`) rejects a definition that references an agent
  the library does not have, and nothing is written to disk.
- `agentRuns` in `GET /api/snapshot` is the same projection the readiness blockers use
  (`agentBlockersOf`) — one read, one verdict, no second opinion. A step that declares no agents is absent
  from the array; the whole field is absent when no step declares any.
- The projection is read-only: an unreadable freeze or ledger degrades to an empty projection. It must
  never block an operation — the real gates are `transition`, `check` and the skill gate, each failing
  closed on its own.

## 4. Validation & Error Matrix

| Condition | Status | Code |
| --- | --- | --- |
| Name outside `AGENT_NAME_RE` | 400 | `agent-invalid` |
| Frontmatter invalid (kernel parse) | 400 | `agent-invalid` |
| Unknown agent | 404 | `agent-missing` |
| Body over `AGENT_FILE_MAX_BYTES` (checked on `content-length` before reading) | 413 | `too-large` |
| Create with an existing name | 409 | `agent-exists` |
| `digest` does not match the file on disk | 409 | `agent-stale` |
| Builtin write or delete | 403 | `agent-builtin-readonly` |
| Delete a custom agent a workflow references | 409 | `agent-referenced` (+ `references`) |
| Non-local `Host` header | 403 | `host-denied` |

## 5. Good / Base / Bad Cases

- Good: `PUT /api/agents/mine` with the digest from the last `GET` → `200`, summary of the stored file.
- Base: `GET /api/agents` while a custom file shadows a builtin → the builtin is listed, the custom entry
  carries `名称冲突`.
- Bad: deleting `security` (builtin, referenced by `default`) → `403`, never `409`.

## 6. Tests Required

- `serverAgentRoutes.test.ts`: every row of the error matrix, the builtin-before-references order, the
  digest round trip.
- `agentRuns.test.ts`: earlier steps show their last visit's verdict and never go stale; the current step
  goes stale when the candidate changes; a tampered frozen file degrades to an empty projection.
- `server.test.ts`: a workflow YAML naming an unknown agent is rejected and not stored.

## 7. Wrong vs Correct

### Wrong

```ts
// Scanning references before the builtin check — a builtin then reports 409 "referenced".
const references = agentReferences(deps.paths, name)
if (references.length > 0) return failure(409, 'agent-referenced', 'agent 被工作流引用', { references })
```

### Correct

```ts
if (entry.source === 'builtin') return failure(403, 'agent-builtin-readonly', '内置 agent 只读')
const references = agentReferences(deps.paths, name)
```
