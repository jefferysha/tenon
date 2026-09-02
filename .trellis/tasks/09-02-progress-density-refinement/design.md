# Design plan

## Direction

Keep the rail and existing IA. Introduce a narrow context row that anchors the active project/change, use a single blue focus for the current orchestration signal, and flatten secondary surfaces. Avoid adding a second sidebar or a new navigation model.

## Hierarchy changes

1. `ProgressToolbar`: compact title/context header; filters share one quiet row and do not read as a second hero.
2. `OrchestrationV2Panel`: become the command strip. Header, status, progress, current task, and next action stay visible. Pipeline is a compact one-line registry. Work-item metadata and technical projections remain in disclosure sections.
3. `WorkflowCanvas`: lower card height and padding, remove decorative weight, and let whitespace separate the workflow group from the command strip.

## Visual language

- Graphite surfaces (`--bg`, `--card`, `--fill`) with cool blue accent only for selection/progress.
- One border treatment and shallow shadows; no new gradients or extra color roles.
- 12–14px product typography, relaxed vertical rhythm, readable line length.
- 150–220ms state transitions; existing reduced-motion behavior remains authoritative.

## Responsive behavior

The context row wraps on mobile. Command controls wrap without clipping. The workflow canvas keeps its intentional horizontal scrolling affordance; all other content stays within the viewport.
