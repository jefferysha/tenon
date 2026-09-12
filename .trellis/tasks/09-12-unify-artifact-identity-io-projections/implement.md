# Implementation plan

1. Add Kernel subject/ref types, codecs, migration receipt shape, and projection-safe equality helpers. Add tests for namespace, version, digest, legacy alias, and ambiguous mapping behavior.
2. Add the automation submission boundary and subject mapping persistence. Route explicit publish and declared executor artifacts through it while retaining old APIs as adapters.
3. Replace path-hash identity for new writes. Make rename update source metadata, add idempotency, and classify ambiguous matches as diagnostics.
4. Change reconciliation to produce intermediate/undeclared candidates and declaration mismatch events. Preserve system-directory policy and existing pending-update/affected projections.
5. Extend workflow pipeline contracts and runtime input/catalog metadata with bounded subject refs and declaration status. Keep file bodies and summaries progressive/on-demand.
6. Add server and Dashboard grouping/projection support. Keep document, field, and runtime read permissions separate and preserve current API fields.
7. Add compatibility migration tests: restart, old state read, old id alias read, rename, duplicate digest, projection failure, and rollback flag.
8. Run a real multi-stage backend workflow containing a canonical document, a field output, an explicitly declared runtime file, a reconcile-only file, and a rename. Capture subject mappings, events, catalog projections, and UI/API responses.
9. Run quality gates: kernel/automation/server/dashboard type checks, targeted Vitest, architecture checks, `git diff --check`, and the Trellis check. Record unrelated baseline failures without claiming them green.
10. Update the canonical artifact/document specs, commit only task-owned and implementation-owned files, and finish the Trellis task.

Risky boundaries: Kernel codecs/types, `packages/automation/src/artifacts/service.ts`, `StageArtifactRuntime`, document recording, workflow pipeline types, server artifact routes, and Dashboard catalog grouping. Make each migration additive and keep a scoped rollback point before changing default identity behavior.
