# Research: Real backend workflow execution entrypoints

- Query: Find an honest full-workflow execution path with actual model calls, skill instructions, validation, and runtime artifacts; identify missing production integration.
- Scope: internal
- Date: 2026-09-12

## Findings

### 1. A usable execution library exists; CLI/server do not launch it

`@tenon/automation` exports `createAutonomousOrchestratorV2`, `createExecutionRuntimeV2`, artifact runtime and filesystem resolver (`packages/automation/src/index.ts:91-104`). The orchestrator initializes the real Kernel ledger, freezes the plan, starts the change, then invokes the runtime (`orchestration/autonomous-orchestrator-v2.ts:30-64`). The runtime claims and begins real work items, materializes dependency inputs, invokes a supplied executor, persists output, calls a supplied validator, and records completion/gate commands (`orchestration/runtime-v2.ts:261-299`, `363-418`, `433-466`).

The production tree has no CLI/server caller of the orchestrator/runtime factory. `orchestration start` only appends `start-change`; it does not run a worker (`packages/cli/src/program-orchestration.ts:15`, `commands/orchestration.ts:60-76`). Server `OrchestrationV2Control` only initializes/reads/appends/recovers the ledger (`packages/server/src/orchestrationV2Control.ts:68-85`). Consequently a standalone validation adapter can run the production library, but success must not be described as a shipped UI/CLI-to-model execution flow.

`real-workflow.integration.test.ts` is explicitly a simulation. Its executor starts Node that prints `{ok:true}` and its validator returns a pass directly (`:36-44`, `:85-89`). These tests are state/runtime integration evidence, not proof that an LLM or Markdown skill ran.

### 2. Concrete supported recipe for the current full scenario

Use a task-local verification script, isolated project, and the public `@tenon/automation` library. Implement its explicit `RuntimeExecutorV2` port using an authenticated real `codex exec --json` child process. Bind each graph work item to a fresh concrete skill whose `SKILL.md` is read in that child. Give the child actual backend requirements and a bounded writable project directory; retain stdout JSONL, exit status, the actual changed business files, and independent test results. Do not synthesize native Skill hook receipts.

1. Compute request/context/catalog fingerprints from the real test fixtures; persist the authored workflow and skill files as inputs.
2. Supply seven explicit dependent skills/stages through `request.user_skills`, the catalog and optional `pipeline_blueprint`. Freeze shared context once. Use serial execution for the same backend source tree; `retry: { max_attempts: 1, auto_retry: false, max_parallel: 1 }` keeps failures unambiguous.
3. The executor launches Codex, captures actual events, and returns bounded `{ output, artifacts, diagnostics }`. Runtime accepts only these fields plus optional `raw_output_ref` and `summary` (`runtime-v2-boundary.ts:141-150`). Its built-in JSON output is stored as `.tenon-artifacts/<resultId>/output.json` (`runtime-v2.ts:421-430`).
4. Call `input.artifact_runtime.reconcile()` after actual writes, then explicitly `publish(path, 'deliverable')` for the child-declared, host-checked files. Publication never follows automatically from process exit (`artifact-runtime/stage-runtime.ts:50-82`).
5. Use the shared artifact service's real `catalog/read` to deliver selected upstream files; retain consumption events. Treat this as adapter integration, because automatic V2 input bridging is incomplete (below).
6. The validator runs genuine filesystem/JSON checks and backend tests or HTTP requests. Generate the validation report from their observed results. Do not use a hardcoded pass or model self-report. Runtime blocks completion without a passing normalized report (`runtime-v2.ts:389-418`).
7. Assert all seven work items completed, each has a genuine model invocation/result, all necessary validations pass, and the real Kernel completion gate is present. Preserve failed attempts too.

### 3. Artifact publication and V2 input resolution are separate protocols

The service publishes immutable raw-byte content at `artifact://<scopeId>/<sha>` and hashes raw bytes (`packages/automation/src/artifacts/service.ts:36`, `:66-76`). The default V2 resolver only supports `artifact://<resultId>/output.json` plus ordinary paths below `change_dir`; any other `artifact://` URI yields `missing-resolver` (`orchestration/input-materialization-v2.ts:132-153`). Thus placing a published service URI into the executor's `artifacts` array breaks downstream default materialization.

The digest contracts differ too: V2 parses JSON (or returns text), normalizes it as JSON and hashes the normalized value (`input-materialization-v2.ts:147-149`, `:192-194`; `runtime-v2-boundary.ts:62-71`). A raw file digest is not generally its parsed-object/string digest. Merely adding a URI resolver without adapting the digest/representation contract is insufficient.

The artifact observer/service does not automatically add published files to `SkillResultV2.artifacts`. V2 dependency inputs come from upstream result projections/raw output/result artifact refs (`input-materialization-v2.ts:113-121`). Runtime publisher methods do not expose catalog/read on the injected runtime object; the validation adapter needs the shared full artifact service separately.

### 4. Identity and visibility defects to keep visible during validation

| Finding | Code evidence | Consequence |
| --- | --- | --- |
| Skill run ID is used as workflow run ID | `runtime-v2.ts:342-350` uses `workflowRunId: run.run_id` | Different stages of one workflow have different workflowRunIds. |
| Work item ID is used as stage ID | `runtime-v2.ts:346` | Custom blueprint stage IDs can differ from runtime attempt IDs; Dashboard queries by selected workflow step cannot find them. |
| Observer always supplies unknown origin | `stage-runtime.ts:68` | Observed files have no producer, intentionally preserving unknown-writer provenance. |
| Publication writes publisher, catalog only inspects producer | `service.ts:87-90` | An automatically observed then published file has no `availableFromStage` and is visible to every attempt because `!v.producer` passes visibility. Dependency-chain filtering is therefore not demonstrated by a successful linear run. |
| Run/project visibility are not implemented as separate scopes | `service.ts:90` checks only `a.visibility !== 'dependency-chain'` | Cross-run boundaries are not checked even for known producers. |
| Content reads do not check catalog visibility | `service.ts:92` | A caller with an artifact ID/version can read it despite dependency filtering. |
| Runtime passes only graph work-item dependencies to artifact observer | `runtime-v2.ts:350` vs `input-materialization-v2.ts:78-100` | Pipeline stage/skill/input-ref dependencies can be delivered by V2 yet absent from artifact dependency metadata. |
| UI silently treats missing attempt as an empty catalog | `packages/dashboard-app/src/workspace/ArtifactCatalogPanel.tsx:18` | Custom stage identity mismatch can look like no artifacts; route resolves attempts by exact stageId (`serverArtifactRoutes.ts:50-58`). |

None of these static findings was modified or runtime-tested by this research agent. A parent validation adapter must not silently replace these semantics and call the replacement production behavior.

### 5. AFK is the real existing Codex process path, but is a different flow

`tenon afk enqueue <change>`/`afk run` use the legacy automation scheduler and Docker worktree path (`packages/cli/src/commands/afk.ts:44-88`, `:128-158`). Requirements include permitted/ready workflow policy, available Docker, named Git branch, bundled CLI digest matching the sandbox image, frozen skill bundle, and valid authentication (`afk-executor.ts:200-216`, `:243-289`). `runner.ts:284-296` launches `TENON_RUNNER=codex tenon-afk-run`.

The sandbox wrapper really executes Codex via the Tap proxy (`tools/sandcastle/tenon-afk-run.sh:472-511`), instructs it to read frozen `SKILL.md` guidance (`:381`), and requires genuine business-tree changes before committing (`:628-667`). It does not invoke V2's StageArtifactRuntime. Native Skill receipts only trigger canonical document auto-registration (`packages/cli/src/nativeSkillReceipt.ts:32-51`), a separate protocol that cannot be substituted with fabricated hook input.

## Files Found

- `packages/automation/src/orchestration/autonomous-orchestrator-v2.ts` — production orchestration library and durable lifecycle entrypoint.
- `packages/automation/src/orchestration/runtime-v2.ts` — injected executor/validator ports, artifact observer lifetime, dependency delivery and completion gate.
- `packages/automation/src/orchestration/input-materialization-v2.ts` — structured result inputs, supported refs, normalization and digest contract.
- `packages/automation/src/orchestration/runtime-v2-scheduler.ts` — pipeline/skill ordering and resource-conflict serialization (`:78-114`).
- `packages/automation/src/orchestration/workflow-pipeline-v2.ts` — custom stage/skill blueprint validation and frozen identity.
- `packages/automation/src/artifact-runtime/stage-runtime.ts` — file snapshots, explicit reconciliation/publication, candidate provenance.
- `packages/automation/src/artifacts/service.ts` — durable immutable versions, catalog, reads and checker/schema registrations.
- `packages/cli/src/commands/orchestration.ts` — ledger-only CLI controls.
- `packages/server/src/orchestrationV2Control.ts` — ledger-only server control service.
- `packages/cli/src/commands/afk.ts`, `afk-executor.ts` — real Docker automation entrypoint and configuration.
- `tools/sandcastle/tenon-afk-run.sh` — actual Codex invocation and business-change requirement.
- `packages/cli/src/nativeSkillReceipt.ts` — genuine native Skill receipts and canonical document registration.

## Related Specs

- `.trellis/workflow.md` — task and research persistence boundaries.
- `.trellis/spec/automation/backend/index.md` — automation spec index.
- `.trellis/spec/automation/backend/orchestration.md` — injected execution/validation ownership and artifact claims.
- `.trellis/spec/kernel/backend/skill-output-registration.md` — distinction between canonical document hooks and runtime artifact observation/publication.
- `.trellis/spec/server/backend/index.md` — server boundary index.

## External References

No external source was necessary for this code-only research. Repository package version observed: `@tenon/automation` 1.0.9; declares Node >=22 (`packages/automation/package.json`). The parent is independently checking installed Codex CLI options/version before execution.

## Caveats / Not Found

- No process, model invocation, Docker run, endpoint mutation, code edit, config edit or Git operation was performed by this researcher.
- The runnable recipe is an adapter-level E2E of production libraries. A packaged CLI/UI full-workflow Codex executor and automatic artifact-service-to-V2-input bridge were not found in current production callers.
- Skill catalog metadata is supplied explicitly by the adapter. This does not establish general inference of arbitrary third-party skill input/output contracts.
- Prior memory was consulted only for evidence discipline: a documented/local check is not runtime completion, and missing host evidence must not be backfilled (`MEMORY.md:274-278`, `:337-346`). All repository findings above were verified from current source.
