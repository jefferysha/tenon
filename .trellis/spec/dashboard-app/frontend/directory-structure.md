# Directory Structure

> How frontend code is organized in `packages/dashboard-app/src`.

---

## Overview

The dashboard is one SPA with two top-level views selected by the top bar: 工作台 (read the
inputs / outputs of each stage of a task) and 工作流 (edit workflow definitions). Both are
three-column pages (rail / list / detail) built from `shell/ThreeColumns.tsx`. Nothing else is
shipped on purpose — the product decision (2026-09) is "only what is needed, everything simple".

---

## Directory Layout

```
src/
├── App.tsx                 # routing (view / root / change), dirty-guard for the workflow editor, lazy views
├── index.css               # token truth source: runtime colour tokens + @theme static scales
├── shell/
│   ├── views.ts            # View union: 'progress' | 'workbench' (ids are stable URL/localStorage keys)
│   ├── TopBar.tsx          # breadcrumb, project switcher, two tabs, global search, read-only pill, connection, settings
│   ├── ThreeColumns.tsx    # ThreeColumns / RailColumn / RailCard / RailFootLink / ListColumn / FilterChip / DetailColumn / DetailEmpty / StatusPill
│   ├── GlobalSearch.tsx    # GlobalSearchProvider + useGlobalSearch (query owned by TopBar, filtered by each view)
│   ├── ProjectGate.tsx     # "choose a project" gate for the workflow page
│   ├── dashboardLocation.ts# URL <-> {view, root, change}
│   └── Onboarding.tsx      # zero-project teaching state (tenon init)
├── shared/
│   ├── DetailSheets.tsx    # SheetTabs (used only for the 输入 / 输出 switch of the file workbench)
│   └── Dialog.tsx, UnsavedDraftDialog.tsx, uiRecipes.ts, motion.ts …
├── workspace/              # view 'progress' — 工作台 (read-only)
│   ├── WorkspaceView.tsx, ProjectRail.tsx, TaskListPane.tsx, TaskCard.tsx
│   ├── TaskDetailPane.tsx  # header + PhaseRail + FileWorkbench
│   ├── FileWorkbench.tsx   # 输入 / 输出 file rows + change documents + click-to-read preview
│   ├── stageFiles.ts       # stageIo(step, change): definition fields -> change field paths
│   ├── useWorkflowDefinition.ts # default -> buildDefaultDef; custom -> GET /api/workflows/<name>
│   ├── workspaceModel.ts   # filters, stageExecution(), railStages(), nextStepLabel()
│   └── taskRows.ts         # FlatRow / rowBadgeOf / stepLabel (single source for task status semantics)
├── workflow/               # view 'workbench' — 工作流 (definition CRUD)
│   ├── WorkflowView.tsx, WorkflowRail.tsx, StageListPane.tsx
│   ├── StageEditorPane.tsx # skills (serial / parallel) · gate · derived inputs/outputs — no sheets
│   └── DerivedIoPanel.tsx  # inputs/outputs derived from the definition — read-only by design
├── workbench/              # workflow domain logic
│   ├── useWorkflowEditor.ts# load / draft / save / create / delete state machine
│   ├── workbenchDefinition.ts, useWorkbenchBoard.ts, boardLane.ts, skillWaves.ts
│   ├── mandatoryState.ts   # skill registry + tracks + default-workflow skill matrix (read)
│   ├── WorkbenchDialogs.tsx, useStageDraftEditor.ts, useWorkbenchDirtyState.ts
│   └── WorkbenchView.tsx   # re-exports only (kept for import stability)
├── progress/               # CanonicalStateVersionNotice, SnapshotInlineError (banners in the task list)
├── model/, api/, state/    # snapshot projections, typed API clients (incl. documentsClient), project selection
└── i18n/translations.ts    # zh/en dictionaries; namespaces shell / workspace / workflow / workbench / nav / common …
```

Server counterpart for the file workbench: `packages/server/src/serverGetDocumentRoutes.ts`
(`GET /api/documents/read?root&path`, read-only, root-anchored, 256KB cap).

---

## Module Organization

- A view directory owns its assembly component (`*View.tsx`), its column components and a
  `*Model.ts` / `*.ts` with pure functions. Data-fetching hooks stay in the domain directory.
- `shell/` never imports a view directory; `shared/` holds presentation primitives only.
- Adding a page means adding a `View` id in `shell/views.ts`, an i18n `nav.<id>` label and a
  three-column view — and a product reason. Default answer is no.
