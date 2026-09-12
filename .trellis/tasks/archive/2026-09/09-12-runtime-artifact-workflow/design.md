# Runtime artifact design

## Architectural decision
The approved report owns behavior. Workflow definitions hold execution/resource policy; runtime artifact state holds observed data. Kernel owns pure public records/decoders/projections. Automation owns filesystem snapshots, persistence, hashing, provider/checker integration and execution adapters. Server translates validated requests and projects runtime state; Dashboard renders those views using current components and i18n.

## Core contracts
Use a versioned public module `packages/kernel/src/artifacts/` and application module `packages/automation/src/artifacts/`, exported through package roots. The core implementer must publish the exact public API early in `research/artifact-api.md` and notify other workers before they depend on it. The agreed conceptual operations are:
- Open/create artifact service scoped to an anchored repository and change directory.
- beginAttempt with workflow run, stage and attempt identity, dependencies and resource visibility policy; terminal completion/cancellation closes attempts explicitly.
- observe file/value with stable host event identity, origin and optional known producer; publication is separate and tied to actual immutable version.
- snapshot / events-after-cursor / stage catalog; directories include revision and status in their digest.
- inspect/read version with requested representation/range/budget; consumption is recorded only for a host-bound execution consumer, never a UI preview.
- register trusted provider/checker/schema/summary adapters with deterministic lifecycle/unregister; checks attach to version and rule version.
- baseline/reconcile and explicit delete/rename handling; inspection of external references never fetches arbitrary URLs without an enabled provider.

Records need logical artifact ID; content version/digest/size/media type; immutable storage reference; optional known producer; distinct observer/publisher; candidate/deliverable/intermediate disposition; version-specific checks; change events; consumer attempt and exact consumed versions. A stage is not successful merely because a file exists or was published.

## Storage and reliability
Use repository patterns for locks and atomic writes instead of a second ad hoc sidecar race. Store artifact state/content in the change-scoped coordination area, separate from legacy canonical document slots. Hold a cross-process lock over metadata revision and event sequencing. Write stable immutable content before metadata references; use atomic publication with recovery handling for interrupted writes. Durable cursors deduplicate notifications. Content identity is SHA-256 of bytes, never SHA-256 of a path string. Read snapshots, not mutable source paths, for published-version consumption. Verify path containment and symlink behavior at the adapter boundary.

## Runtime integration
Existing v2 runtime and legacy admitted/CLI stage paths must reach the common service; an unused library is not delivery. Tool hooks capture known changes; stage baseline/reconciliation covers eligible shell/terminal changes; candidate attribution stays unknown where source cannot be proved. Universal publication and list/inspect/read commands are available through existing CLI/host capabilities. Runtime inputs include a resource directory and fixed read handles, while current governed completion/validation remains intact. Finish/abort must wait for required reconciliation. Supported next-step boundaries refresh changed catalogs; unsupported hosts guarantee the next stage only and expose that limit.

## Data flow and change semantics
Published versions from allowed predecessor stages form the stage resource view. A consumer records selected/read versions and never silently switches them. New versions update pending-stage views and generate update notices for active consumers. Completed consumers are affected only through known consumption/derived edges; opaque-read coverage uses conservative declared input scope. Old content/check records remain valid for their old versions. Default rerun behavior is operator review, not recursive execution.

## UI
The authoring page defaults to skills and operational controls. Resource inheritance uses defaults with optional advanced restrictions (source stages/types/check policy); no LLM analysis, missing speculative output markers, or editable schema blobs. Explicit governed I/O can remain collapsed advanced detail. The runtime page lists actual outputs and inputs by stage/attempt, with candidates in detail, multiple files, versions, preview/diff, quality, consumption and affected status. Existing read-only workspace behavior is preserved; use established rerun/review command surfaces where available.

## Compatibility and ownership
- Core worker: `packages/kernel/src/artifacts/**`, Kernel public exports; `packages/automation/src/artifacts/**`, Automation public exports.
- Runtime worker: `packages/automation/src/artifact-runtime/**`, existing admission/orchestration/lifecycle integration, CLI artifact commands/registration and host hook wiring. Coordinate before touching already dirty hooks/installers.
- UI worker: Server artifact routes/snapshot integration, Dashboard views/client/locales/tests; workflow policy schema/codec changes if needed, excluding Kernel root exports (coordinate with core).
- Lead: task artifacts, updated specifications, integration coordination, final validation, scoped commit and wrap-up. Implementation/check tasks use Trellis agents.

Do not weaken legacy canonical artifact-binding gates or rewrite old producer receipts to backfill new runtime facts. Bridge existing verified records explicitly; retain history and unknown origin. No new dependency is required unless repository primitives cannot meet the behavior and the reason is recorded.

## Validation and rollback
Validate real two-stage executions, version changes and restart/reconnect before visual polish. New artifact state is additive and separated; disabling the integration leaves governed document behavior readable. Deployment and automatic destructive cleanup are not part of this task. Existing shared dirty files must retain all prior edits.
