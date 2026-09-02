# Dashboard redesign concept review

## Goal

Build three isolated, read-only Tenon Dashboard UI concepts that let the user compare fundamentally different product-shell and task-flow directions before any production redesign begins.

## Background

- The current Dashboard is functional but scored 25/40 in the 2026-09-02 Impeccable critique.
- The highest-impact issues are missing persistent project/workflow/track context, weak first-run closure, excessive card/pill treatment, mobile HostPlan discontinuity, and an overloaded Workbench.
- The user explicitly asked for several redesigns based on the assistant's judgment and will review the alternatives.

## Requirements

- Produce exactly three structurally different concepts on one review route:
  - A — Task Command: dense, operator-oriented, current task and next action first.
  - B — Flow Canvas: spatial Pipeline/Stage/Skill map with an inspector.
  - C — Guided Build: beginner-first, one decision at a time with progressive disclosure.
- Use the same representative project data in every concept so differences are attributable to design rather than content.
- Keep project, workflow, track, change, connection, and run status visible in every concept.
- Show Stage order, Skill execution mode/status, evidence/artifacts, and decisions requiring attention.
- Provide a floating review switcher controlled by click, keyboard left/right arrows, and a shareable `?variant=a|b|c` URL.
- Make each concept responsive at desktop and 390px mobile widths.
- Keep the prototype read-only and isolated from production API calls, storage, and mutations.
- Mark the artifact as a throwaway prototype and document one command to run it.

## Acceptance Criteria

- [ ] `?variant=a`, `?variant=b`, and `?variant=c` render three visibly and structurally different concepts.
- [ ] The fixed switcher cycles with buttons and left/right arrow keys without intercepting editable controls.
- [ ] Reloading preserves the selected variant through the URL.
- [ ] Each concept exposes the same representative project/workflow/track/change facts and execution state.
- [ ] Each concept presents a clear primary action and the current blocker/decision.
- [ ] All concepts remain legible and usable at 1440x900 and 390x844.
- [ ] Browser inspection shows no console errors, failed requests, horizontal page overflow, or inaccessible primary controls.
- [ ] The existing production Dashboard source and runtime behavior remain unchanged.

## Out of Scope

- Connecting concepts to real APIs or executing commands.
- Rewriting production React components before the user selects a direction.
- Pixel-perfect coverage of every existing Dashboard page.
- Persisting prototype UI state beyond the `variant` URL parameter.

## Key Decisions

- This is a whole-shell design experiment, so an isolated prototype route is safer than embedding throwaway alternatives in production `App.tsx`.
- The three concepts intentionally use different layout topologies and color worlds because the user rejected the current overall direction.
- Comparison data is frozen and identical across variants.

## Open Questions

- None. The user delegated direction selection to the assistant and will review the rendered concepts.
