# Shared design contracts for the next-capabilities child tasks

Every child `design.md` must follow these contracts. §9 lists cross-child resolutions; where a child design says otherwise,
§9 wins. A child that needs to change a contract updates this file first.

## 1. Terms (UI and docs use exactly one word per concept)

| Concept | Word | Notes |
| --- | --- | --- |
| Change | 任务 | |
| Workflow / track / step | 工作流 / 轨道 / 步骤 | step label in YAML is the only displayed name |
| Skill | 技能 | only upstream skills plus the single `tenon` skill |
| Task-level agent | agent；执行者 / 评审者 | never mixed with instruction files |
| Instruction file | 指令文件（项目级 / 用户级） | AGENTS.md, CLAUDE.md, GEMINI.md … |
| Template | 模板 | instruction file blocks |
| Project design system | 设计体系 / `DESIGN.md` | |
| Resource catalog | 资源目录 | code, routes, CLI named `resources` |
| Test / test direction | 测试 / 测试方向 | |
| Gate | 门禁：评审 / 自动 | |
| Hide a task for me | 归档 / 取消归档 | per user, reversible |
| Workflow last step, done | 完结 / 已完结 | internal field stays `archived`; OpenSpec archive command unchanged |
| Physical removal | 删除 / 未提交删除 | working tree only, no auto commit |
| Owner / take over | 负责人 / 接手 | |
| Library page / builtin / custom | 库 / 内建 / 自定义 | |
| Instruction level loading | 叠加 / 项目优先 / 个人优先 / 仅项目 / 需配置 | |

## 2. User identity (kernel)

```ts
interface TenonUser { id: string /* email */; name: string; slug: string; source: 'env' | 'config' | 'git'; trust: 'declared' }
resolveTenonUser(repoRoot?: string, env?: NodeJS.ProcessEnv): TenonUser | { missing: true; invalid?: 'env' | 'config' | 'git' }
```

- Order: `TENON_USER` (+ `TENON_USER_NAME`) → `<configRoot>/user.json` `{ id, name }` → `git config user.email` / `user.name`
  (repo scope, then global). No login. Synchronous; git call has a 1.5 s timeout.
- Ids: printable ASCII, exactly one `@`, ≤ 200 chars. An invalid higher source makes identity missing (no fall-through).
- `slug`: lowercase id, `@` → `-at-`, every char outside `[a-z0-9._-]` → `-`, collapsed. Bash and TypeScript identical.
- New records carry `actor: { id, name, trust: 'declared' }`, except `TransitionRecord.actor`, which stays a user-ref string
  `Name <id>` (the API projects the object). Hook-written host evidence rows carry no actor.
- Missing identity blocks writes with a setup hint (HTTP 412 `user-missing`); non-owner advancing is refused (403 `owner-required`).
- AFK sandboxes receive `TENON_USER` / `TENON_USER_NAME` from the enqueuing host.

Sibling API (multi-user, stable after its commit C3): `userProjectPaths`, `ensureUserLocalDir`, `RecordActor`, `assertOwner`,
CLI `requireUser` / `requireActor` (`packages/cli/src/userIdentity.ts`), server `deps.resolveUser`. Children add their own
path fields to `userProjectPaths`; they do not create parallel helpers.

## 3. Directory layout

### Global (`resolveProductPaths()`; macOS `~/Library/Application Support/tenon/`)

| Path | Owner | Content |
| --- | --- | --- |
| `config/workflows/.pipeline/workflows/*.yaml` | existing | workflows |
| `config/user.json` (`ProductPaths.userConfigPath`) | multi-user | identity override |
| `config/agents/{builtin,custom}/*.md` | review-agents | agent library |
| `config/templates/instructions/{builtin,custom}/**` | instruction-templates | template blocks |
| `config/templates/instructions/audit.jsonl` | instruction-templates | template and instruction-file writes |
| `config/resources/{builtin,custom}/*.yaml` | design-resources | resource catalog entries |
| `config/test-directions/{builtin,custom}/*.yaml` | test-evidence | test directions |
| `<stateRoot>/skills/last-update.json` | upstream-skills | last fetch outcomes (state, not config) |

Builtin library content ships in the plugin under `templates/<kind>/` (never at plugin root `agents/`, which Claude Code
auto-loads). One helper, `packages/kernel/src/infrastructure/builtin-library-sync.ts` (instruction-templates lands it in
wave 1), copies every kind into `config/<kind>/builtin/` by source digest: after release activation (setup, update) and
lazily on every library read. `custom/` is never touched. Builtin items are read-only in UI and can be copied to `custom/`.

Kernel domain directories stay free of Node fs/process APIs; fs and git code goes in kernel `infrastructure/` or the CLI /
server packages, as enforced by `npm run check:architecture`.

### Upstream skills (upstream-skills)

- Fetched at setup/update (git partial clone + sparse checkout) into the **host plugin root's `skills/` before candidate
  verification**; the managed payload receives the same bytes, so Codex trust roots (`codexSkillTrust.ts`) keep working.
  Tenon writes `skills/<upstream-id>/`, `skills/skills.lock.json` and `.tenon-skills-staging-*` there.
- `skills/sources.yaml` (checked in): flow YAML, `version: 1`, keyed by id `{ repo, path, ref: default-branch, license_expected }`.
- `skills/skills.lock.json` (payload, not in git): top-level `version`, `updated_at`; entries
  `{ id, repo, path, commit, previous_commit, tree_sha256 ("sha256:" tree-sha256-v1), license, fetched_at }`.
- Failures never change the active release; the previous content stays. Licenses allowed: MIT, Apache-2.0.
- Repository keeps only `skills/tenon/` after data-driven-runner merges; until then other Tenon-owned dirs stay tracked
  through `.gitignore` allow lines.
- GSAP: design-resources appends the 8 `greensock/gsap-skills` rows.

### Project per user (multi-user; additions from test-evidence and task-delete-archive)

```
<repo>/.tenon/
  .gitignore                          # tracked, contains: users/*/local/   (Tenon never edits the root .gitignore)
  users/<slug>/
    tests/<change>/<run-id>.json      # tracked: test run summary (TestRunRecordV1)
    baselines/<test-id>.json          # tracked: benchmark baseline
    audit.jsonl                       # tracked: task deletions
    local/                            # gitignored
      active-change                   # replaces .pipeline-active
      authority                       # replaces .pipeline-interaction-authority (v2 line grammar kept)
      archived.json                   # UI archive state
      audit.jsonl                     # archive / unarchive
      deleting/                       # staging for atomic delete
      running/<change>/<test-id>.json # running test marker
      env.key                         # HMAC key for env input digests
      artifacts/<change>/<run-id>/    # logs, traces, screenshots (retention 5 runs per test)
```

The workspace fingerprint excludes the whole `.tenon/` top-level directory.

## 4. Workflow YAML extensions (kernel `workflow/types.ts`, parse, serialize, compile, validate, fingerprint)

```yaml
name: my-flow
openspec: true                     # workflow-io-openspec: the only OpenSpec switch; `openspec_contract` is rejected
tracks:
  frontend:
    document_contract:             # under tracks.<id> when tracks exist; top level otherwise
      version: v1
      slots:
        - { kind: proposal, owner_step: open, producers: [openspec-propose], role: produce }
        - { kind: design-md, owner_step: design, producers: [hue], role: produce }   # kind decides scope (project doc at DESIGN.md)
        - { kind: design-md, owner_step: build, role: require }                     # require: no producers
      reads: [ { step: build, kinds: [design-md] } ]
    steps:
      - id: build
        label: 实现
        gate: auto
        skills: [ { id: test-driven-development } ]
        agents:                    # review-agents
          executors: [ { agent: builder } ]
          reviewers:
            - { agent: frontend-quality, required: true, block_at: high }
            - { agent: code-size, required: true, block_at: medium, reads_tests: [code-size] }
            - { agent: architecture, required: false, depends_on: [frontend-quality, code-size] }
        tests:                     # test-evidence: self-contained copies; `direction` is the origin id only
          - id: unit
            direction: unit
            command: pnpm test     # required
            cwd: frontend
            required: true
            timeout_s: 900
            inputs: [ { kind: document, ref: delta-spec } ]
            outputs: [ { path: frontend/test-results/junit.xml, required: true } ]   # under test-results/, playwright-report/ or coverage/
```

- Flow maps are accepted by `parseInlineMap` (`workflow/parse-primitives.ts`, first lander owns); the serializer writes block style.
- Slot `role: produce | update | require`; one kind may have several slots with different roles; `require` has no producers.
  No `scope:` key.
- The kernel's fixed per-phase document tables are deleted; `default.yaml` spells out full per-track tables.
- Fingerprints include the selected track's document policy. Agents are frozen in a Change sidecar (§5), not in the fingerprint.
- Removed: YAML `openspec_contract`, `review_lanes`, `review_budget`, skill `kind` / `review_lane`, manifest `review_skills`,
  CLI `review-attempt` / `review-budget`, phase skills in default, snapshot `reviewBudget` and `artifactAttempts`,
  `/api/artifacts/*`. `agent_review_result` / `codex_review_result` lose all behavior but keep reserved canonical wire slots;
  track policy `review_seed` stays.

## 5. Records (change directory, tracked unless noted)

| File | Owner | Record |
| --- | --- | --- |
| `.pipeline-frozen/lock.json` + `.pipeline-frozen/agents/*.md` | review-agents | `{ version, run_id, workflow_fingerprint, agents[] }` frozen at Change creation |
| `.pipeline-agent-runs.jsonl` | review-agents | append-only, last row per `run_id` wins: `{ schema: "agent-run/v1", run_id, agent, agent_digest, role, step, step_visit, status: running\|finished, candidate, result: pass\|fail (reviewer) / done\|failed (executor), findings[{severity, location, message}], report_path, report_digest, actor, started_at, finished_at }` |
| `.pipeline-agent-reports/<run_id>.md` | review-agents | report with trailing `tenon-result` block |
| (per user) `.tenon/users/<slug>/tests/<change>/<run-id>.json` | test-evidence | `TestRunRecordV1` (test-evidence §5.4): `schema, run_id, workflow_run_id, workflow_fingerprint, test_id, test_digest, direction, command, cwd, exit_code, signal, duration_ms, candidate_before, candidate, git_head, build_sha, host, inputs, outputs[{path, digest, present, artifact}], metrics[], log{…}, reasons[], step_visit, actor, result` |
| `.pipeline-history.jsonl` rows | multi-user | CLI rows gain `actor` via the history writer |
| `.pipeline-documents.json` records | multi-user | gain `actor` |
| `.pipeline.yaml` | multi-user | creator / owner stored in existing `created_by` / `assignee` as `Name <id>`; projected as `creator` / `owner` `{id,name,slug}`; `tenon status --json` shows `owner` instead of `assignee` |

- Agent staleness: reviewer run candidate ≠ current candidate. Test staleness: candidate, test declaration digest or workflow
  fingerprint differs; records from another `workflow_run_id` are ignored. Test guards read only the acting user's records.
- Reviewer results are computed by Tenon from findings and `block_at`.
- Snapshot readiness blockers gain `agents-incomplete` and test-evidence's test blocker; the Dashboard decoder change ships
  in the same commit as the server change.

## 6. Execution boundary

- Dashboard never calls models. Agents run in the host (Claude Code Agent tool, Codex subagent or `codex exec`), prompted
  by `tenon agent prompt`; hosts without subagents run them sequentially in the main session. Nothing is written to host
  agent directories.
- Step order: executors → step skills → required tests → reviewers → exit.
- Tests always run through `tenon test run <change> <test-id>`; commands get `TENON_CHANGE_NAME`. Codex tests needing
  network, ports or a browser run with escalated sandbox permissions.
- The single `tenon` skill drives every step from `tenon status <change> --json` → `step.next` (data-driven-runner), which
  embeds the results of `tenon agent next --json` and `tenon test status --json`.

## 7. CLI and HTTP surface (owners)

| Command / route | Owner |
| --- | --- |
| `tenon user [set]`, `tenon owner take\|set`, `GET/POST /api/user`, `POST /api/change/:name/owner` | multi-user |
| `tenon task delete\|archive\|unarchive <name> [--yes]`, `tenon list --archived` | task-delete-archive |
| `tenon agent next\|prompt\|record` | review-agents |
| `tenon test run\|status\|baseline\|report\|code-size` | test-evidence |
| `tenon spec apply [--dry-run]` | data-driven-runner |
| `tenon design validate` | design-resources |
| `tenon doctor --skills`, `GET /api/skills/sources`, `npm run skills:fetch` | upstream-skills |
| `POST /api/projects/create` (dry run; existing dir or new empty dir with git init) | instruction-templates |

Commands acting on a Change (test, agent, owner) refuse archived Changes of the acting user with a 取消归档 hint.

## 8. Dashboard surfaces

| Surface | Children |
| --- | --- |
| Top bar: current user | multi-user |
| Workspace list: owner facet (first, default 全部), 归档 / 删除, 已归档 view, 未提交删除 hint; 接手 only | multi-user, task-delete-archive |
| Workspace detail: sheet tabs 输入 / 输出 / 测试 (`SheetTabs.count` accepts `n/m`), reasons, agent runs; no 运行时产物 | workflow-io-openspec, test-evidence, review-agents |
| Workflow page: OpenSpec switch, `+ 输出`, `+ 输入`, tests, executors / reviewers; section order 输入 → 技能 → 执行者 → 输出 → 评审者 → 门禁 → 退回 | workflow-io-openspec, test-evidence, review-agents |
| Library page (`?view=library`, `ThreeColumns`, rail: agent / 模板 / 资源目录 / 测试方向); shell owned by instruction-templates | review-agents, instruction-templates, design-resources, test-evidence |
| Projects: single 新建项目 button, project instruction files (AGENTS.md, CLAUDE.md, GEMINI.md), user-level files, digest-based 409 + 外部修改 | instruction-templates |
| Skills view (`?view=skills`, nav 技能): source, commit, license, changed since last update | upstream-skills |

## 9. Cross-child resolutions (override child designs)

| # | Topic | Resolution | Rejected positions |
| --- | --- | --- | --- |
| X1 | Agent CLI | `tenon agent next\|prompt\|record` (review-agents §7) | data-driven-runner CCR-1 `start/finish`, `agentRunStatuses` |
| X2 | Test `command` | required; step tests are self-contained | data-driven-runner CCR-2 `unconfigured` / project command resolution |
| X3 | Default document contract | full per-track tables in `default.yaml`; kernel fixed tables deleted (workflow-io-openspec) | data-driven-runner D4 (keep `openspec-v1` matrix), CCR-4 "track may only add project slots"; design-resources "merge onto fixed table" |
| X4 | Living document refresh | slots with `role: update`; `tenon` is an implicit producer for `role: update` slots, OpenSpec living refresh and `applied-spec` (validator change lands in data-driven-runner, wave 4) | `document_contract.updates` |
| X5 | Document scope | kind decides (design-md → project, `DESIGN.md` at repo root) | `scope:` key |
| X6 | Builtin agents | `templates/agents/<name>.md`; ids builder, researcher, architecture, frontend-quality (absorbs the design reviewer; adds GSAP motion checklist), backend-quality, code-size, security, spec-consistency, e2e. Skill ids must exist in `skills/sources.yaml`: `vercel-react-best-practices` (not `react-best-practices`); backend-quality has no skill (`code-review` deleted) | data-driven-runner D19 / CCR-5 `design-quality`, `templates/agents/builtin/` |
| X7 | Freezing | agents only in `.pipeline-frozen/`; test content frozen by the workflow IR | test directions in the lock |
| X8 | Identity storage | multi-user CR-1…CR-7 accepted as written in §2, §3, §5 | new `creator` / `owner` keys, `authority.json`, root `.gitignore` edit |
| X9 | Fingerprint exclusion | whole `.tenon/` (multi-user implements it) | `.tenon/users/` only |
| X10 | Per-user helpers | multi-user names (§2) | test-evidence `tenonUserRoot` / `ensureTenonDir` |
| X11 | Builtin sync | one helper in kernel `infrastructure/` (§3), triggers: activation + lazy read | `kernel/src/library/builtin-sync.ts` |
| X12 | Resource catalog disk path | `config/resources/` | `config/catalog/` |
| X13 | Skills view | top-level `技能` view, not a library tab | |
| X14 | Payload size | payload grows to ≈ 45 MB. upstream-skills measures hook dispatch latency before and after (its implement step 0 / 14); if p50 grows by more than 50 ms, it adds a bootstrap payload-digest cache keyed by file stat in the same branch | |
| X15 | Retired review wire slots | kept reserved, no behavior, no state wire schema bump in this parent | removal by version-reset |
| X16 | Default workflow tests | frontend build `typecheck` + `unit`, verify `playwright`; backend build `unit`, verify `integration`; all required, npm scripts; pm / free / chat none. Other stacks edit the global default or use another workflow | |
| X17 | Default last step | label 完结 | |
| X18 | Real-host acceptance | child branches run unit / integration / local gates only; real Claude Code + Codex runs happen in wave 5 on `main` | per-child real-host runs inside worktrees |

## 10. Release

Final delivery is v0.1.0 through the existing release pipeline (version-reset):

- Wave 1 lands order logic only (1.x ranks below every 0.x; retired numbers 1.0.0–1.1.5 rejected; releases created with
  `--latest`; N-1 gate skipped only for exactly v0.1.0). The version bump happens at the start of wave 5.
- 1.x installs cannot `tenon update` to 0.1.0; each host runs the official v0.1.0 install command once.
- The main session writes the v0.1.0 release notes once.
- Before deleting 1.x releases and tags, back up tags (v1.0.0–v1.0.6 commits are not on main) and assets locally; delete
  only after v0.1.0 public acceptance passes; rerun public acceptance after deletion.
