# Dashboard Redesign Concepts — Implementation Plan

## Checklist

- [ ] Create isolated static prototype shell and frozen representative data.
- [ ] Implement A — Task Command with persistent context and next-action hierarchy.
- [ ] Implement B — Flow Canvas with Stage/Skill dependency visualization and inspector.
- [ ] Implement C — Guided Build with progressive disclosure and beginner-focused copy.
- [ ] Add URL-stable floating variant switcher and keyboard cycling.
- [ ] Add responsive layouts for 1440x900 and 390x844.
- [ ] Start one-command local server and open the review page in the in-app browser.
- [ ] Inspect all variants at desktop/mobile; check console, requests, overflow, focus, and switcher behavior.
- [ ] Leave production Dashboard files untouched and hand off variant URLs for review.

## Validation

```bash
npx vite packages/dashboard-app/prototype/dashboard-redesign --host 127.0.0.1 --port 4180
```

Browser checks:

- `?variant=a|b|c` render and update URL.
- Arrow keys and switcher controls wrap correctly.
- `document.documentElement.scrollWidth <= window.innerWidth` at 1440x900 and 390x844.
- No browser console errors or failed network requests.
- Primary task, current context, blockers, and skill order remain visible or reachable in every variant.

## Risk and Rollback

- Risk: concepts drift into three color skins. Guard by enforcing different topologies and primary affordances.
- Risk: review controls look like product UI. Guard by using a separately styled floating bar labeled `PROTOTYPE`.
- Risk: prototype accidentally ships. Guard by keeping it outside `src/` and documenting throwaway status.
- Rollback: delete `packages/dashboard-app/prototype/dashboard-redesign/`.
