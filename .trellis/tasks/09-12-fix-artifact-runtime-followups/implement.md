# Implementation plan

1. **Freeze contracts**
   - Extend kernel artifact attempt/catalog types for persisted pin snapshots and `pendingUpdate`.
   - Add shared scan policy and visibility helper contracts.
   - Add decoder fixture types for Codex JSONL event variants.

2. **Fix runtime observation**
   - Exclude `.orchestration-v2` through the shared scan policy.
   - Improve Codex event path extraction, bounded event diagnostics, and managed-tool tests using captured JSONL fixtures.
   - Preserve reconcile fallback and explicit producer adoption.

3. **Fix service semantics**
   - Persist pins at attempt creation and implement `catalog({ pinned: true })`.
   - Reuse one visibility predicate in catalog/read.
   - Add `pendingUpdate` calculation and tests for running vs completed consumers.
   - Add checker registration/default conservative checks and exact-version quality tests.

4. **Wire production entry points**
   - Add shared production runtime factory.
   - Add CLI `orchestration run` and server protected run route with idempotent run identity.
   - Verify both paths use `createCodexRuntimeExecutor` and the same artifact service.

5. **UI and snapshot projection**
   - Hide ignored/system entries by server policy and show pending-update/affected/quality states.
   - Add cursor/pinned requests where needed without making workflow editing depend on file declarations.

6. **Validation and evidence**
   - Run kernel/automation/server/dashboard/cli type checks.
   - Run focused service/runtime/route/UI tests and architecture check, recording baseline failures separately.
   - Run a real seven-stage backend workflow through the shared production entry; assert no ledger noise, at least one managed-tool observation, pins after restart, checker result, pending-update and affected transitions, and CLI/server run evidence.
   - Update the relevant kernel/automation specs, then commit only task-owned files.

## Risky files / rollback points

- `packages/automation/src/artifacts/service.ts`: state migration and visibility/pinning semantics. Roll back by disabling pinned/pending projections while retaining legacy state decode.
- `packages/automation/src/orchestration/codex-skill-executor-v2.ts`: event decoder can over-claim paths. Keep strict scope validation and fall back to reconcile.
- `packages/cli/src/commands/orchestration.ts` and server run routes: preserve existing control command behavior; route can be disabled without changing ledger data.
- `packages/kernel/src/artifacts/types.ts`: add optional fields only for backward-compatible decoding.

## Validation commands

```bash
node_modules/.bin/tsc -p packages/kernel/tsconfig.json --noEmit --pretty false
node_modules/.bin/tsc -p packages/automation/tsconfig.json --noEmit --pretty false
node_modules/.bin/tsc -p packages/server/tsconfig.json --noEmit --pretty false
node_modules/.bin/tsc -p packages/dashboard-app/tsconfig.json --noEmit --pretty false
node_modules/.bin/tsc -p packages/cli/tsconfig.json --noEmit --pretty false
node_modules/.bin/vitest run packages/automation/src/artifact-runtime packages/automation/src/artifacts packages/automation/src/orchestration packages/server/src/serverArtifactRoutes.test.ts packages/server/src/snapshot.test.ts packages/cli/src/commands/orchestration.test.ts
node_modules/.bin/vitest run .trellis/tasks/09-12-fix-artifact-runtime-followups/live-evidence/*.test.ts
git diff --check
```
