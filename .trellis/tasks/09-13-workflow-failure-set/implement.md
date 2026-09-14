# Implement

## Completed

- Fixed the PM `spec/plan` dead end by making explicit `artifacts: []` suppress derived artifacts while preserving non-empty field overlays.
- Added compiler round-trip coverage and real CLI PM/backend integration coverage; existing frozen snapshots remain immutable.
- Fixed the stable-hook repository-relative document path conversion and corrected the registry-only Track fixture.
- Full-suite follow-up isolated one intermittent `runtime-v2` concurrency observation; the focused runtime suite and automation suite pass, with no reproducible production or fixture defect found.

1. 隔离复跑全部失败集并记录分类。
2. 修 branch fixture 与必要的产品逻辑。
3. 补同 workflow/跨 workflow/escalated 回归。
4. 单独与并行运行 transition-effects，记录超时策略。

## Stable-hook implementation evidence (2026-09-13)

- Updated `packages/automation/src/submission/adapters.ts` so document submissions resolve the
  Change-relative path against `changeDir`, then pass a repository-relative path to Kernel.
- `npx vitest run packages/automation/src/submission/service.test.ts` passed (3 tests).
- The first stable-hook rerun still used the tracked CLI bundle and failed with the old diagnostic.
  After `npm run build:packages && npm run bundle`,
  `npx vitest run packages/cli/src/runtime/stable-hook.integration.test.ts` passed all 4 tests.
- No assertion or document path policy was relaxed; the combined focused run covered both suites.

## Final verification evidence (2026-09-13)

- `npm test -- --reporter=dot`: **437 files passed; 7129 passed, 15 skipped, 0 failed**.
- The repository-wide Vitest timeout is now 30 seconds (hooks 60 seconds) in `vitest.config.ts`;
  this removes false 5-second failures from real CLI, server, and transition integration suites.
- Runtime v2 concurrency remains covered by a 100ms executor window so setup/migration I/O cannot
  make the overlap assertion timing-dependent; the focused suite passes 12/12.
- `npm run bundle`, `npm run build:server`, typecheck, docs/OpenSpec/identity/hygiene/design-scale/
  dashboard freshness checks, and `git diff --check` all pass.
- `npm run check:architecture` still reports 35 pre-existing violations in unrelated kernel,
  dashboard, automation, and server modules; this remains explicitly deferred rather than hidden.
