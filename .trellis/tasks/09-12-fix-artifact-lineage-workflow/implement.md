# Implementation plan

1. **Freeze contracts and tests**
   - Add kernel/runtime types for producer identity, consumption declarations, stage identity mapping, bounded catalog entries and event cursors.
   - Add failing tests for same-content adoption, producer/visibility, consume receipts, affected versions, and catalog digest changes.

2. **Fix Artifact Service and StageArtifactRuntime**
   - Make stage observations producer-aware while preserving unknown/external attribution.
   - Add existing-version adoption/observation for a new attempt and retain publisher identity separately.
   - Add `consume`/`consumeRef`, strict version/path/scope validation, idempotent read receipts, and bounded catalog/event helpers.
   - Add restart/concurrency/corrupt-state tests.

3. **Wire production ExecutionRuntimeV2**
   - Resolve pipeline stage id from work item before opening StageArtifactRuntime.
   - Pass skill/actor metadata and dependency stage ids.
   - Normalize bounded consumed declarations, call consume before `end`, and expose catalog metadata to executor/input preparation.
   - Add runtime-v2 integration tests proving artifacts and reads come from production runtime without manual reconcile.

4. **Project attempts and progressive disclosure through server**
   - Add artifact service to snapshot dependencies and project latest attempts using stable stage ids.
   - Add/extend catalog metadata and event-cursor routes with scope, maxEntries and maxBytes enforcement.
   - Add server route/snapshot tests for stage/work-item compatibility and no UI read receipts.

5. **Update Dashboard projection**
   - Display availableFromStage, version, digest/size, disposition, quality, consumed and affected states.
   - Keep configured I/O as fallback, but make runtime catalog the source for observed files.
   - Add component tests for candidates hidden by default, affected versions and stage attempt mapping.

6. **Real workflow validation**
   - Replace task-local manual artifact calls in the validation driver with the production V2 executor/runtime path.
   - Run a seven-stage scenario with a rewritten upstream artifact, unchanged existing package, downstream consumed declaration, restart/reconnect replay, and source/package acceptance.
   - Verify events, attempts, catalogs, read receipts, affected flags, stage mapping and UI/server projections.

7. **Quality gates and finish**
   - `pnpm vitest` targeted automation/kernel/server/dashboard tests.
   - `npx tsc -b packages/kernel packages/automation packages/server packages/dashboard-app --pretty false`.
   - `git diff --check` and architecture/hooks checks.
   - Browser/API E2E for artifact catalog and real workflow; record unrelated pre-existing failures separately.
   - Update `.trellis/spec` with the final artifact lifecycle contract, then commit only this task's files.

## Risk / rollback checkpoints

- After step 2, revert only service/runtime files if storage compatibility tests fail; preserve additive schema fields.
- After step 3, disable artifact service injection to preserve ledger execution while fixing integration.
- Before step 6, require all targeted tests and server projection tests green; do not call the driver evidence complete if it still manually reconciles or consumes.
