# Component Guidelines

> How components are built in this project.

## Shared recipes

Dashboard components use shared class recipes from packages/dashboard-app/src/shared/uiRecipes.ts for repeated surfaces and controls. Reuse BUTTON_SOLID, BUTTON_GHOST, BUTTON_DANGER, BUTTON_ICON, CARD, INPUT, SELECT, TEXTAREA, EMPTY_STATE, and PAGE_FRAME before adding page-local variants.

The recipe layer is intentionally presentational. State, labels, disabled/loading behavior, and mutation calls remain in the owning component.

## Styling patterns

- Use Tailwind utility classes with semantic CSS variables from src/index.css.
- Use semantic surface/control tokens for new styles; do not add a new raw color for a component state.
- Keep focus-visible rings on every keyboard action and preserve reduced-motion behavior.
- Prefer fluid grid/flex layouts. Do not add fixed min-width tracks that force the primary page to scroll horizontally.
- Use data-slot on shared primitives when the global interaction contract should apply.

## Accessibility

- Every dialog has an accessible title, aria-modal, an explicit close control, Escape handling, focus capture, and focus restoration.
- Settings and secondary navigation panels use a stable id paired with aria-controls; the trigger exposes aria-expanded.
- Inputs and selects require visible labels or an equivalent accessible name. Error state uses aria-invalid and adjacent help text.
- Status must be communicated with text or an icon plus text; color alone is insufficient.
- Mobile controls keep at least the shared 40px target height unless a documented compact control is required.

## Common mistakes

- Recreating button/card/input strings in each page causes state and focus drift; import a recipe instead.
- Rendering the full workflow DAG as a fixed-width first-screen canvas creates horizontal scrolling; show a fluid stage list/track and keep deep detail in the drawer.
- Hiding a low-frequency destination only by removing its rail item makes deep links undiscoverable; place it in the settings/secondary panel and retain a stable route.
