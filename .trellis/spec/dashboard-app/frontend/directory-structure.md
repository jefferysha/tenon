# Directory Structure

> How frontend code is organized in `packages/dashboard-app/src`.

---

## Overview

The dashboard is one SPA with five top-level views selected by the top bar: 工作台 (read the
inputs / outputs of each stage of a task), 工作流 (edit workflow definitions, default included),
项目 (edit project-level and user-level instruction files, and create projects), 库 (templates, resource
catalog, test directions, agents) and 技能 (local skills). 工作台 / 项目 / 库 are three-column pages
(rail / list / detail) built from `shell/ThreeColumns.tsx`; 工作流 renders `TwoColumns`. The workflow definition served by the
server (with materialized `effectiveIo`) is the single source of truth for the first two pages; the
server's instruction routes are the single source of truth for 项目 and 库.

---

## Directory Layout

```
src/
├── App.tsx                 # routing (view / root / change), dirty-guard for the workflow editor, lazy views
├── index.css               # token truth source: runtime colour tokens + @theme static scales
├── shell/
│   ├── views.ts            # View union 'progress' | 'workbench' | 'projects' | 'library' | 'skills' (stable URL/localStorage keys),
│   │                       # viewNeedsSnapshot, TASK_STATUS_PARAM / NEEDS_YOU_STATUS (the only definition)
│   ├── TopBar.tsx          # project switcher, tabs + 待决策 badge, user, connection, settings (theme / language segments)
│   ├── ThreeColumns.tsx    # ThreeColumns / TwoColumns / RailColumn (lead, headerAction) / RailCard (icon mark) / ListColumn (action) /
│   │                       # DetailColumn / DetailEmpty / StatusPill; re-exports FilterChip / FilterChipGroup
│   ├── Skeleton.tsx        # ThreeColumnsSkeleton (loading placeholder for three-column pages)
│   ├── GlobalSearch.tsx    # matchesQuery only (no global search box)
│   ├── dashboardLocation.ts# URL <-> {view, root, change}; per-view keys (工作台 status/step, 工作流 wf/track/step) dropped on leave
│   └── Onboarding.tsx      # zero-project teaching state (tenon init)
├── shared/
│   ├── Dialog.tsx          # the only modal (Radix Dialog / AlertDialog; destructive confirms are role=alertdialog)
│   ├── Drawer.tsx          # right-side drawer (portal, 560px, Esc, focus trap) — the only overlay besides Dialog
│   ├── Markdown.tsx        # react-markdown + remark-gfm with token styling; isMarkdownPath
│   ├── FacetBar.tsx        # one-line filter bar: FilterChip groups + dropdown facets, overflow into 「更多 N」 (never wraps)
│   ├── FilterChip.tsx      # FilterChip (role=radio) / FilterChipGroup (role=radiogroup), arrow / Home / End keys
│   └── UnsavedDraftDialog.tsx, uiRecipes.ts (BUTTON_* recipes; overrides use enabled:hover:), motion.ts …
├── workspace/              # view 'progress' — 工作台 (read-only)
│   ├── WorkspaceView.tsx, ProjectRail.tsx (RailCard + lead), TaskListPane.tsx, TaskCard.tsx, MiniPipeline.tsx
│   ├── TaskMenu.tsx, useTaskActions.ts # the one ⋯ action list shared by card and detail
│   ├── workspaceLocation.ts # URL status / step (keys from shell/views)
│   ├── taskRef.ts          # URL change: bare name, or <rootTag>:<name> in the aggregate view
│   ├── TaskDetailPane.tsx  # header (H1 + ⋯) + StageRail + skills / agents canvases + IO sheets + DocumentDrawer
│   ├── StageRail.tsx, StageIoPanel.tsx, StageAgentsPanel.tsx, TaskRecords.tsx, DocumentDrawer.tsx
│   ├── taskModel.ts        # rowsOf / stagesOf / summaryOf / statusOf / needsYouCount / labelWithDefinition / filterRows
│   │                       # (status semantics and the 需要你 count live here only)
│   ├── stageIo.ts          # stageOutputs / stageInputs (slot × change → row), fallbackStepIo, readableFiles
│   └── useWorkflowDefinition.ts # cached GET /api/workflows/:name; useWorkflowDefLookup (list) / useWorkflowDefCache (read-only)
├── workflow/               # view 'workbench' — 工作流 (definition CRUD)
│   ├── WorkflowView.tsx    # TwoColumns: WorkflowNav + StageEditorPane; URL wf / track / step
│   ├── WorkflowNav.tsx     # switcher (Radix DropdownMenu) + ⋯ menu, track tabs, numbered stage flow with per-stage ⋯
│   ├── StageEditorPane.tsx # 输入 → 技能 → 执行者 → 输出 → 测试 → 评审者 → 门禁 → 退回; page save bar (未保存 N 处 · 保存 / 放弃)
│   ├── IoTable.tsx         # equal-width 文件 · 来源阶段 · 来源技能 table (inputs and outputs), trailing × column
│   ├── SkillFlow.tsx, skillFlowGraph.ts, skillFlowNodes.tsx # React Flow canvas, layout, GSAP pulse
│   ├── SkillComposer.tsx, AgentComposer.tsx # palette (row = preview, + = add, drag = add at drop) · canvas · detail
│   ├── Hint.tsx            # Radix Tooltip for gate help
│   ├── NewWorkflowDialog.tsx, TrackDialog.tsx, TestsSection.tsx, TestEditorDrawer.tsx, AgentSection.tsx
│   ├── pipelineModel.ts    # forward / back edges
│   └── lint.ts             # lintWorkflow, draftEffectiveIo
├── projects/               # view 'projects' — 项目 (instruction files + 新建项目)
│   ├── ProjectsView.tsx    # rail 用户级 + 各项目 (+ 新建项目 in the rail header); list HostTargetList; detail InstructionEditor
│   ├── InstructionEditor.tsx, HostTargetList.tsx, DiffDrawer.tsx, NewProjectDialog.tsx, TemplatePicker.tsx
│   ├── useInstructionFiles.ts # GET once per root + focus / snapshot digest recheck; preview / apply / delete
│   └── instructionModel.ts # targetsForHosts / fileStatus / firstLoadable / managedCount (pure)
├── library/                # view 'library' — 库 (templates, resource catalog, test directions, agents)
│   ├── LibraryView.tsx, LibraryRail.tsx, TemplateDetail.tsx, NewTemplateDialog.tsx
│   ├── AgentList.tsx (+ NewAgentDialog), AgentDetail.tsx, TestDirectionsPane.tsx, resources/
│   ├── libraryChrome.tsx   # BuiltinLock, DetailTitle (H1 + actions beside it), CopyAsCustomButton, DeleteMenu, ListSkeleton
│   └── useTemplateLibrary.ts, useAgentLibrary.ts, useTestDirections.ts
├── skills/                 # view 'skills' — 技能 (local skills, global)
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
