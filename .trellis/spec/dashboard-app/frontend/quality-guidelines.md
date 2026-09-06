# Quality Guidelines

> Code quality standards for frontend development.

## Required patterns

- Keep canonical state and mutations in existing API/snapshot layers; UI components must not edit pipeline files directly.
- Async writes expose pending, success/refresh, and failure/retry states. Refresh snapshot/SSE after a successful mutation.
- Shared visual behavior is expressed through semantic/component tokens and shared recipes.
- Changes affecting navigation, responsive layout, or focus semantics require component tests and a 375/768/1440 browser check.
- Run npm run typecheck:web, the relevant Vitest suites, and git diff --check before reporting completion.

## Forbidden patterns

- Do not use the Host Plan preview as an installation mutation surface.
- Do not introduce a second canonical status model in the UI.
- Do not use color-only state indicators or remove visible focus styles.
- Do not force the primary workflow surface to overflow horizontally with fixed-width tracks.
- Do not claim visual/browser validation from unit tests alone.

## Testing requirements

At minimum, cover:
- primary and secondary navigation, including aria-expanded, aria-controls, and deep-link views;
- empty, loading, error, disabled, selected, and retry states for controls;
- drawer/dialog open, Escape close, focus restoration, and async action feedback;
- workflow list/track behavior at desktop and mobile widths.

Existing Vitest suites may still print React act(...) warnings from asynchronous drawer/evidence updates. A green result proves assertions passed but does not erase that follow-up cleanup item.

## Code review checklist

- [ ] New colors, surfaces, spacing, radii, and shadows reuse semantic/component tokens.
- [ ] Shared button/select/card/dialog recipes are reused before adding local styles.
- [ ] Main action remains visible at 375px and 768px without horizontal overflow.
- [ ] Keyboard focus and accessible names remain intact after layout changes.
- [ ] Host Plan remains read-only and mutation boundaries remain explicit.
- [ ] Typecheck, focused tests, full web tests where practical, and diff check are recorded separately.
