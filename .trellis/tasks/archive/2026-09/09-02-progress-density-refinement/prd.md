# Progress dashboard density refinement

## Problem

The current Progress view exposes workflow filters, orchestration controls, pipeline metadata, work-item cards, technical details, blockers, and the workflow canvas at the same visual weight. The result is trustworthy but hard to scan. The user prefers the dark graphite “task command” language from the first concept, with a calmer information hierarchy.

## Goal

Make the existing production Progress view feel like a quiet command deck: the default viewport answers only “what needs attention, where is it, and what do I do next?”. Keep secondary evidence available on demand, but remove repeated context, empty controls, decorative status copy, and per-card metadata from the default surface. Preserve the existing information architecture, state semantics, actions, test IDs, and responsive behavior.

## Non-goals

- No schema, API, workflow state-machine, or persistence changes.
- No removal of orchestration controls or evidence; only move secondary detail behind clear disclosure.
- No redesign of other primary views in this task.
- No loss of traceability: project/workflow/track/change identifiers remain available in breadcrumbs, the task drawer, URLs, or detail surfaces.

## Acceptance Criteria

- [x] Existing `ProgressView`, `OrchestrationV2Panel`, `ProgressToolbar`, and `WorkflowCanvas` contracts remain intact.
- [x] The first viewport has a single dominant hierarchy: page context → current execution signal/next action → workflow canvas.
- [x] Pipeline, work-item, run/result/validation/gate detail remain available and discoverable, but no longer compete equally with the current action.
- [ ] The default Progress viewport contains only page location, status filters with non-zero counts, an optional workflow filter when more than one workflow exists, the workflow track, and concise task cards (name, state, open action).
- [ ] Repeated project/workflow/track/change context, realtime copy, empty status filters, and per-card stage/workflow metadata are removed from the default viewport; their authoritative detail remains available elsewhere.
- [x] Dark mode retains the first concept’s graphite/azure command-deck tone; active, warning, success, and error colors stay semantic and restrained.
- [x] At 390px and desktop widths, there is no horizontal overflow outside intentional canvas scrolling; controls remain keyboard and screen-reader accessible.
- [x] Existing unit, typecheck, build, and e2e coverage pass; visual browser checks confirm the dashboard renders without console errors.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
