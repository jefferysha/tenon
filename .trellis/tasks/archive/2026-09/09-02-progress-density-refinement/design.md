# Design plan

## Direction

Keep the rail and existing IA. Make the page itself the context anchor through breadcrumbs and the selected drawer, then remove the extra context strip. Use a single blue focus for the current orchestration signal and flatten secondary surfaces. Avoid adding a second sidebar or a new navigation model.

## Hierarchy changes

1. `ProgressToolbar`: compact title plus one primary action; status filters show only useful categories and the workflow filter appears only when there is a choice.
2. `OrchestrationV2Panel`: become the command strip. Header, status, progress, current task, and next action stay visible. Pipeline is a compact one-line registry. Work-item metadata and technical projections remain in disclosure sections.
3. `WorkflowCanvas`: lower card height and padding, remove project/process/step-count repetition, per-card metadata, execution-source labels, and visible scroll coaching; keep the stage track, task name, state, and open affordance.

The default information budget is intentionally small:

- Page: breadcrumb, title, one primary action.
- Controls: “all” plus only non-empty status categories; workflow selection only for multiple workflows.
- Canvas: one compact group identity, stage track, and concise task cards.
- Drawer: overview first; evidence, terminal, history, and orchestration detail remain in sheets.

## Visual language

- Graphite surfaces (`--bg`, `--card`, `--fill`) with cool blue accent only for selection/progress.
- One border treatment and shallow shadows; no new gradients or extra color roles.
- 12–14px product typography, relaxed vertical rhythm, readable line length.
- 150–220ms state transitions; existing reduced-motion behavior remains authoritative.

## Responsive behavior

The context row wraps on mobile. Command controls wrap without clipping. The workflow canvas keeps its intentional horizontal scrolling affordance; all other content stays within the viewport.
