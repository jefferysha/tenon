# Directory Structure

> How frontend code is organized in `packages/dashboard-app/src`.

---

## Overview

The dashboard is one SPA with four top-level views selected by the top bar: 工作台 (read the
inputs / outputs of each stage of a task), 工作流 (edit workflow definitions, default included),
项目 (edit project-level and user-level instruction files, and create projects) and 库 (the
instruction template library). All except 工作流 are three-column pages (rail / list / detail) built
from `shell/ThreeColumns.tsx`; 工作流 renders `TwoColumns`. The workflow definition served by the
server (with materialized `effectiveIo`) is the single source of truth for the first two pages; the
server's instruction routes are the single source of truth for 项目 and 库.

---

## Directory Layout

```
src/
├── App.tsx                 # routing (view / root / change), dirty-guard for the workflow editor, lazy views
├── index.css               # token truth source: runtime colour tokens + @theme static scales
├── shell/
│   ├── views.ts            # View union: 'progress' | 'workbench' | 'projects' | 'library' (stable URL/localStorage keys)
│   ├── TopBar.tsx          # project switcher, tabs + 待决策 badge, user, connection, settings (theme / language segments)
│   ├── ThreeColumns.tsx    # ThreeColumns / RailColumn / RailCard / RailFootLink / ListColumn / FilterChipGroup / FilterChip / DetailColumn / DetailEmpty / StatusPill
│   ├── Skeleton.tsx        # ThreeColumnsSkeleton (loading placeholder for three-column pages)
│   ├── GlobalSearch.tsx    # GlobalSearchProvider + useGlobalSearch
│   ├── ProjectGate.tsx     # "choose a project" gate for the workflow page
│   ├── dashboardLocation.ts# URL <-> {view, root, change}
│   └── Onboarding.tsx      # zero-project teaching state (tenon init)
├── shared/
│   ├── Drawer.tsx          # right-side drawer (portal, 560px, Esc, focus trap) — the only overlay besides Dialog
│   ├── Markdown.tsx        # react-markdown + remark-gfm with token styling; isMarkdownPath
│   ├── FacetBar.tsx        # one-line filter bar: radio chips + dropdown facets, overflow into 「更多 N」 (never wraps)
│   └── Dialog.tsx, UnsavedDraftDialog.tsx, uiRecipes.ts, motion.ts …
├── workspace/              # view 'progress' — 工作台 (read-only)
│   ├── WorkspaceView.tsx, ProjectRail.tsx, TaskListPane.tsx, TaskCard.tsx, MiniPipeline.tsx
│   ├── TaskMenu.tsx, useTaskActions.ts # the one ⋯ action list shared by card and detail
│   ├── workspaceLocation.ts # URL status / step
│   ├── TaskDetailPane.tsx  # header + StageRail + StageIoPanel + DocumentDrawer
│   ├── StageRail.tsx, StageIoPanel.tsx, DocumentDrawer.tsx
│   ├── taskModel.ts        # rowsOf / stagesOf / summaryOf / filterRows / stageChips / slotLabel (status semantics live here only)
│   ├── stageIo.ts          # stageOutputs / stageInputs (slot × change → row), fallbackStepIo, readableFiles
│   └── useWorkflowDefinition.ts # cached GET /api/workflows/:name (+ useWorkflowIoLookup for the list)
├── workflow/               # view 'workbench' — 工作流 (definition CRUD)
│   ├── WorkflowView.tsx, WorkflowRail.tsx, PipelineList.tsx
│   ├── StageEditorPane.tsx # SkillDag · OutputsSection · InputsSection · gate radio; footer save/discard
│   ├── SkillDag.tsx        # column-model DAG canvas + track badges/filter + local skill palette (dnd-kit); applyDrop / skillAppliesTo / whenFromSelection
│   ├── IoSections.tsx, NewWorkflowDialog.tsx
│   ├── pipelineModel.ts    # forward / back edges
│   ├── lint.ts             # lintWorkflow (step-no-output, input-not-upstream), draftEffectiveIo
│   └── slotCatalog.ts      # FIELD_CATALOG, DOCUMENT_KINDS, availableOutputSlots, upstreamOutputs
├── projects/               # view 'projects' — 项目 (instruction files + 新建项目)
│   ├── ProjectsView.tsx    # rail 用户级 + 各项目 + 新建项目; list HostTargetList; detail InstructionEditor
│   ├── InstructionEditor.tsx, HostTargetList.tsx, DiffDrawer.tsx, NewProjectDialog.tsx, TemplatePicker.tsx
│   ├── useInstructionFiles.ts # GET + 5s polling / focus recheck; preview / apply / delete
│   └── instructionModel.ts # targetsForHosts / fileStatus / firstLoadable / managedCount (pure)
├── library/                # view 'library' — 库 (instruction template library)
│   ├── LibraryView.tsx, TemplateDetail.tsx, NewTemplateDialog.tsx
│   └── useTemplateLibrary.ts # list + selected document; save / create / copy / delete
├── workbench/              # workflow domain logic
│   ├── useWorkflowEditor.ts# load / draft / save / create(copy|blank|import) / delete|restore / lint / canWrite
│   ├── workbenchDefinition.ts # pure definition transforms (skills waves, outputs, inputs, document contract, stages, clone, blank)
│   ├── skillWaves.ts       # wavesOf / wavesToSkills / placeSkillInWave / insertWaveBefore
│   ├── mandatoryState.ts   # track list + local skill registry (read-only for the editor)
│   └── WorkbenchDialogs.tsx, useStageDraftEditor.ts, useWorkbenchDirtyState.ts, workbenchStyles.ts
├── progress/               # CanonicalStateVersionNotice, SnapshotInlineError (banners in the task list)
├── model/, api/, state/    # snapshot projections, typed API clients (documentsClient, workflowYamlClient), project selection
└── i18n/translations.ts    # zh/en dictionaries; namespaces shell / workspace / workflow / documents / fields / workbench / nav / common …
```

Server counterparts: `serverGetRoutes.ts` (`GET /api/workflows` with `default.source`,
`GET /api/workflows/:name` with `source` + `effectiveIo`), `serverWorkflowYamlRoutes.ts`
(`GET/PUT /api/workflows/:name/yaml`), `serverGetDocumentRoutes.ts` (`GET /api/documents/read`).
Kernel: `workflow/effective-io.ts` (`materializeWorkflowIo`), `validate.ts`
(`validateWorkflowForStorage` — default override skeleton check), `SkillRef.when` (track condition;
`effective-plan.skillAppliesToTrack` filters the per-track capability; a definition with any `when`
runs `step-declared`, legacy ones stay `manifest-overlay`), `tools/check-default-skill-matrix.mjs`
(template ⇔ manifest drift gate).

---

## Module Organization

- A view directory owns its assembly component (`*View.tsx`), its column components and its pure
  model files. Data-fetching hooks stay in the domain directory (`workbench/`, `workspace/`).
- `shell/` never imports a view directory; `shared/` holds presentation primitives only.
- Adding a page means adding a `View` id in `shell/views.ts`, an i18n `nav.<id>` label and a
  three-column view — and a product reason. Default answer is no.
