# Acceptance matrix

| Requirement | Evidence | Result |
| --- | --- | --- |
| New or custom skills need no authoring-time I/O declaration | `StageEditorPane`/`lint.ts` no longer reject missing outputs; runtime discovery is stage-boundary reconciliation | pass |
| Actual files are discovered and versioned | `StageArtifactRuntime` + durable `ArtifactService`; created/changed/deleted snapshots and SHA-256 blobs | pass |
| Candidate and deliverable are distinct | `observe` defaults to candidate; `publish` requires same-attempt observation and records publisher | pass |
| Downstream visibility is scoped | dependency-chain catalog exposes own attempt and declared dependency stages only | pass |
| Versions and consumption are explainable | immutable `v1/v2`, read receipts, affected markers, event cursor | pass |
| Checks/schema/summary are dynamic | checker/schema/summary registration plus on-demand `runChecks`/`inspect` | pass |
| Runtime UI shows real state | server catalog/inspect/read/events routes, change-scoped service lookup, 5-second refresh and preview | pass |
| Existing governed document flow remains authoritative | runtime protocol is additive; canonical document registration and validation are unchanged | pass |

## Validation run

- `npx tsc -b packages/kernel packages/channel packages/tap packages/automation packages/cli packages/server --pretty false`
- `npx tsc --noEmit -p packages/dashboard-app --pretty false`
- Artifact/runtime/server Vitest: 4 files, 10 tests passed in the final run.
- Dashboard targeted Vitest: 6 files, 40 tests passed before the final route prop change; the final dashboard typecheck and the affected workspace/workflow suites passed (26 tests).
- `npm run build:web` and `npm run build:server` passed.
- `git diff --check` passed for owned files.
- `npm run check:architecture` still reports pre-existing repository violations outside the new artifact modules; the new artifact service/runtime files are clear.

## Known boundary

The common V2 runtime is fully wired and auto-opens a change-scoped service. Legacy execution paths still need to opt into
`StageArtifactRuntime`; they cannot be inferred safely from arbitrary host processes. The server accepts `change` and
resolves `openspec/changes/<change>` so the dashboard reads the same change-scoped store.
