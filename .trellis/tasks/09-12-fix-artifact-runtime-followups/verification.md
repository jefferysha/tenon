# Verification

- Real backend run: `production-runtime-e2e.json` — completed seven serial stages, 36 artifact events, nine catalog entries, six attempts with pinned versions, one affected v1 contract entry, zero `.orchestration-v2` catalog entries.
- Targeted Vitest: 12 files, 66 tests passed.
- Package build/typecheck: `tsc -b packages/kernel packages/channel packages/tap packages/automation packages/cli packages/server` passed.
- `git diff --check` passed.
- Architecture checks: import graph passed; repository architecture checker reports pre-existing unrelated violations in workflow/dashboard modules.
- Dashboard typecheck/build remains blocked by pre-existing generated automation declarations using `ErrorOptions` unavailable to the repository TypeScript lib (`packages/automation/dist/triage/*.d.ts`).
- Real Codex run emitted no explicit path-bearing managed completion; artifact observations were bounded `reconcile` events. Decoder fixtures cover path-bearing managed-tool envelopes and reject unknown/out-of-scope paths.
