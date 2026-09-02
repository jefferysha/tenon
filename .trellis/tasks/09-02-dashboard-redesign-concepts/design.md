# Dashboard Redesign Concepts — Technical Design

## Boundary

The prototype lives under `packages/dashboard-app/prototype/dashboard-redesign/`. It is a standalone static review artifact served by Vite, not imported by the production Dashboard bundle and not reachable from the production navigation.

## Files

- `index.html` — semantic shell, review metadata, and mount point.
- `styles.css` — shared review switcher plus three independent visual systems.
- `app.js` — frozen representative data, variant renderers, URL switching, and read-only interactions.
- `README.md` — throwaway warning and one-command launch instructions.

## Shared Data Contract

All variants consume one immutable object with:

- project, workflow, track, change, branch, and connection facts;
- ordered stages with status and progress;
- ordered skills with execution mode, status, duration, and artifact count;
- attention items, artifacts, activity records, and machine/host readiness.

The object is local JavaScript data. No API requests, filesystem writes, commands, or production mutations are allowed.

## Variant Topologies

### A — Task Command

Persistent labeled sidebar + context bar + central current-task surface + right signal rail. The primary axis is information hierarchy and operational density. Color world: graphite with electric azure and semantic green/amber.

### B — Flow Canvas

Project explorer + spatial stage graph + persistent inspector. The primary axis is layout topology and relationship visibility. Color world: neutral white with ink, vermillion, violet, and green state marks.

### C — Guided Build

No permanent sidebar. A compact top context strip, linear journey header, and one-decision-at-a-time main panel with a contextual support rail. The primary axis is structural decomposition/progressive disclosure. Color world: cobalt brand field with true-neutral light surfaces and lime/indigo signals.

## Review Switching

`URLSearchParams` resolves `variant`; invalid values fall back to `a`. `history.replaceState` updates the shareable URL. Fixed previous/next buttons and document-level ArrowLeft/ArrowRight shortcuts cycle variants, excluding input, textarea, select, button, and contenteditable focus.

## Responsive Behavior

- Desktop breakpoint: ≥ 980px.
- Tablet: 720–979px, inspectors move below the main surface.
- Mobile: ≤ 719px, sidebars collapse into context/navigation strips and the review switcher becomes edge-safe.
- No concept relies on horizontal document scrolling.

## Safety and Rollback

The prototype is disconnected from production code and can be removed by deleting its directory. It must not be promoted directly; the selected direction will be rewritten as production components with tests.
