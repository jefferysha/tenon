# Workflow IO and runtime artifacts (evidence)

## 运行时产物 vs 输出

- 运行时产物 = `ArtifactCatalogPanel` (`dashboard-app/src/workspace/ArtifactCatalogPanel.tsx:23-41`, mounted
  `TaskDetailPane.tsx:110`), polls `/api/artifacts/catalog` every 5 s; "0 · r0" = entries · catalog revision.
- Server returns an empty catalog when a stage has no attempt, which is every host-driven Change
  (`server/src/serverArtifactRoutes.ts:72-83`).
- Attempts are created only by `StageArtifactRuntime.open` (`automation/src/artifact-runtime/stage-runtime.ts:73-76`),
  whose only production caller is `ExecutionRuntimeV2` (`automation/src/orchestration/runtime-v2.ts:283`), reached from
  `tenon orchestration run` or the server orchestration route. No Dashboard control starts it.
- `tenon artifact register` writes a field + subject record; `tenon document record` writes the document ledger + subject
  record. Neither touches `.pipeline-artifacts/<ns>/state.json`.
- 输出 = `effectiveIo[step]` for the Change's track (`TaskDetailPane.tsx:45-48`, `kernel/src/workflow/effective-io.ts:72-100`),
  status from the ledger (`workspace/stageIo.ts:34-57`) or field set/unset.

## How IO is declared

- Field slots: step `inputs`/`outputs` in YAML (`kernel/src/workflow/types.ts:180-184`, `templates/workflows/default.yaml:26-32`).
- Document slots: never per step.
  - `default` or `openspec_contract: required` → fixed tables keyed by canonical phase ids
    (`kernel/src/workflow/document-contract.ts:32-123`, selected at `:139-143`). A custom workflow with other step ids
    gets no matching owner steps.
  - Custom workflows → top-level `document_contract: {version: v1, slots: [{kind, owner_step, producers}], reads}`
    (`parse-document-contract.ts:85-124`, mapped `document-contract.ts:144-165`); kinds are a closed list
    (`document-contract-model.ts:7-18`).
- Skills declare no outputs; allowed producers live in the contract (`document-contract.ts:310-319`).
  `templates/documents/registry.v1.yaml` gives path pattern + layout per kind.
- `effectiveIo` built by `materializeWorkflowIo` (`effective-io.ts:44-103`), display-only; `locked` for default/required.

## Editing

- Editor IO is read-only (`workflow/StageEditorPane.tsx:48-51`, `IoTable.tsx:20-43`); new stages get `inputs: [], outputs: []`
  (`workbench/useStageDraftEditor.ts:79`, `workbenchDefinition.ts:366`); copying `default` drops document governance
  (`workbenchDefinition.ts:340-348`). IO changes only via YAML import (`serverWorkflowYamlRoutes.ts:95,131`).
- Evidence from C1 (custom `feature-flow` built in the UI): stage-1 recorded only field `plan`, no documents
  (`.trellis/tasks/archive/2026-09/09-15-v1-1-0-release-e2e/research/e2e-custom-workflow.md:33`).

## Runtime use

- Document evidence blocks forward transitions, `tenon check`, review request (`state/document-evidence.ts:176-260`,
  `transition-application.ts:330-360`, `check.ts:230-238`, `review.ts:107`).
- Recording only in owner step by listed producer (`document-ledger.ts:290-340`); reads only declared kinds (`:447-463`).
- `handoff --bundle` ignores custom contracts (`ledger-context-bundle.ts:117-124`).
- `gate: auto` = declared outputs non-empty (`compile.ts:232-234`, `compile-guards.ts:91-96`).

## Gaps

UI stages have no IO (gates check nothing, no lint warning); IO not editable and no hint; default tracks share document
slots so skills show "—"; handoff ignores custom contracts; tooltip points at a YAML path default does not have.
