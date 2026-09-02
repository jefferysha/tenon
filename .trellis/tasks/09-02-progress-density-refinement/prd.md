# Progress dashboard density refinement

## Problem

The current Progress view exposes workflow filters, orchestration controls, pipeline metadata, work-item cards, technical details, blockers, and the workflow canvas at the same visual weight. The result is trustworthy but hard to scan. The user prefers the dark graphite “task command” language from the first concept, with a calmer information hierarchy.

## Goal

Make the existing production Progress view feel like a quiet command deck: one clear next action, one compact execution signal, and progressive disclosure for implementation details. Preserve the existing information architecture, state semantics, actions, test IDs, and responsive behavior.

## Non-goals

- No schema, API, workflow state-machine, or persistence changes.
- No removal of orchestration controls or evidence; only move secondary detail behind clear disclosure.
- No redesign of other primary views in this task.

## Acceptance Criteria

- [x] Existing `ProgressView`, `OrchestrationV2Panel`, `ProgressToolbar`, and `WorkflowCanvas` contracts remain intact.
- [x] The first viewport has a single dominant hierarchy: page context → current execution signal/next action → workflow canvas.
- [x] Pipeline, work-item, run/result/validation/gate detail remain available and discoverable, but no longer compete equally with the current action.
- [x] Dark mode retains the first concept’s graphite/azure command-deck tone; active, warning, success, and error colors stay semantic and restrained.
- [x] At 390px and desktop widths, there is no horizontal overflow outside intentional canvas scrolling; controls remain keyboard and screen-reader accessible.
- [x] Existing unit, typecheck, build, and e2e coverage pass; visual browser checks confirm the dashboard renders without console errors.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
