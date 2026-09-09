# Directory Structure

> How frontend code is organized in `packages/dashboard-app/src`.

---

## Overview

The dashboard is one SPA with four top-level views selected by the top bar. Every view is a
three-column page (rail / list / detail) built from the shared primitives in `shell/ThreeColumns.tsx`.
Domain logic (API clients, models, hooks) lives beside the view that owns it; cross-view primitives
live in `shell/` and `shared/`.

---

## Directory Layout

```
src/
├── App.tsx                 # routing (view / root / change), dirty-guard for the workflow editor, lazy views
├── index.css               # token truth source: runtime colour tokens + @theme static scales
├── shell/
│   ├── views.ts            # View union: 'progress' | 'workbench' | 'afk' | 'machine' (ids are stable URL/localStorage keys)
│   ├── TopBar.tsx          # breadcrumb, project switcher, four tabs, global search, read-only pill, connection, settings
│   ├── ThreeColumns.tsx    # ThreeColumns / RailColumn / RailCard / RailFootLink / ListColumn / FilterChip / DetailColumn / DetailEmpty / StatusPill
│   ├── GlobalSearch.tsx    # GlobalSearchProvider + useGlobalSearch (query owned by TopBar, filtered by each view)
│   ├── ProjectGate.tsx     # "choose a project" gate for views that require a writable project
│   ├── dashboardLocation.ts# URL <-> {view, root, change}
│   └── Onboarding.tsx      # zero-project teaching state
├── shared/
│   ├── DetailSheets.tsx    # SheetTabs + useSheetState (right-column sheet switching, localStorage memory)
│   ├── TaskDetail.tsx      # legacy task detail surfaces reused inside workspace sheets (outputs / terminal / history)
│   └── ...                 # dialogs, motion, recipes, evidence cards
├── workspace/              # view 'progress' — 工作台: project rail / task list / per-stage execution detail (read-only)
│   ├── WorkspaceView.tsx, ProjectRail.tsx, TaskListPane.tsx, TaskCard.tsx
│   ├── TaskDetailPane.tsx, PhaseRail.tsx, StageExecutionList.tsx
│   ├── workspaceModel.ts   # filters, stageExecution(), nextStepLabel(), producedCount()
│   └── taskRows.ts         # FlatRow / rowBadgeOf / stepLabel (single source for task status semantics)
├── workflow/               # view 'workbench' — 工作流: definition editor (CRUD) for workflows / tracks / stages / skills
│   ├── WorkflowView.tsx, WorkflowRail.tsx, StageListPane.tsx
│   ├── StageEditorPane.tsx # sheets: skills / io / gate / prompt / hooks / settings
│   ├── DerivedIoPanel.tsx  # inputs/outputs derived from the definition — read-only by design
│   ├── TrackPane.tsx, WorkflowSettingsPane.tsx
├── workbench/              # workflow domain logic kept from the previous editor
│   ├── useWorkflowEditor.ts# the whole load / draft / save / create / delete state machine
│   ├── workbenchDefinition.ts, useWorkbenchBoard.ts, boardLane.ts, mandatoryState.ts, hooksConfig.ts …
│   └── WorkbenchView.tsx   # re-exports only (kept for import stability)
├── afk/                    # view 'afk' — 自动化: AutomationRail / RunListPane / RunDetailPane / AutomationSettingsPane
├── machine/                # view 'machine' — 机器: MachineRail / HostListPane / HostDetailPane / HostSheets / MachineSheets
├── hostPlan/               # host target catalog + install plan (useHostTargetPlan, HostOperationPlanPanel)
├── progress/               # change-level panels still consumed by workspace sheets (ContextBundlePreview, RunLogPane, notices)
├── model/, api/, state/    # snapshot projections, typed API clients, project selection / snapshot hooks
└── i18n/translations.ts    # zh/en dictionaries; namespaces shell / workspace / workflow / automation / machines
```

---

## Module Organization

- A view directory owns its assembly component (`*View.tsx`), its column components and a `*Model.ts`
  with pure functions. Data fetching hooks stay in the domain directory (`workbench/`, `hostPlan/`, `api/`).
- New right-column content is added as a **sheet** of the owning detail pane, never as another stacked
  section (see component guidelines).
- Anything the top bar or two or more views share goes to `shell/` (layout, navigation) or `shared/`
  (presentation primitives); nothing in `shell/` may import a view directory.
