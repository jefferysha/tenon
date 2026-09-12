# Runtime artifacts and workflow UI

## Goal
Let users compose arbitrary installed or newly installed skills without predicting their file I/O. During execution, discover and publish real artifacts, retain exact content versions, make upstream material available progressively, show actual consumption and change impact, and select applicable checks.

## Authorization and source
The user approved the research recommendation, requested all features, and explicitly said “创建并执行”. This authorizes task creation and implementation of the already reviewed design. Do not repeat the same scope approval. Authoritative source: `docs/research/2026-09-12-runtime-artifact-lineage-and-workflow-ui.md`; companion code/protocol findings are evidence, not proof of runtime behavior.

## Requirements
- R1: Workflow authoring only selects stages, skills, ordering/dependencies and operational policies. No model calls or required speculative I/O manifests; preserve explicit governed contracts as advanced information.
- R2: Capture observed file creation/change/deletion, tool/call/attempt identity, baseline reconciliation on terminal outcomes, and uncertain attribution. Loading SKILL.md never proves artifact production or completion.
- R3: Separate candidate discovery, intermediate files, published delivery and stage success. Provide a common execution-time publication surface usable by any skill; no per-skill edits required. Failed/cancelled execution can leave candidates without satisfying gates.
- R4: Persist logical artifact identity, immutable actual bytes/content digest, versions and durable ordered events with idempotency, concurrency protection and restart/reconnect recovery. Same content does not create redundant versions. Preserve old versions across replacement/deletion; only explicit rename evidence preserves identity.
- R5: Support files/documents, text/JSON/value outputs, change sets and externally supplied immutable content through a provider boundary. Unknown content schemas remain valid generic resources. Register data instances under fixed APIs, not new tools per file.
- R6: Filter upstream published resources by dependencies, run/attempt and policy. Supply a bounded directory, inspect/structure/optional cached summary and version-bound read. No eager full-skill parsing or blanket full-content injection.
- R7: Record metadata delivery separately from content/summary consumption. Freeze selected versions while a consumer runs; pending consumers refresh on start. Record new-version notifications at supported execution boundaries and mark affected completed results without automatic broad reruns. Unobserved reads remain explicit coverage gaps.
- R8: Run deterministic resource/format checks and pluggable trusted content-schema checks against exact content and rule versions. Preserve failed/unavailable/not-applicable distinctions; existing business validation remains authoritative. Optional semantic summaries/checks use explicit adapters, only on demand.
- R9: Production API and runtime UI show actual collections, versions, previews, checks, reads and affected stages, independent of defined output slots. Default authoring UI needs no repeated per-stage settings; advanced resource policies remain ordinary controls.
- R10: Preserve existing lifecycle/governance evidence and supported host compatibility. Independent immutable checks may run in parallel; unknown shared writes serialize or use existing isolation. Hook queues/terminal barriers must not lose records silently.

## Acceptance criteria
1. Add a skill without I/O metadata to a new workflow, save without model interaction or missing-output warning, and execute through a supported runtime.
2. A real execution writes a previously undeclared file; it appears as a candidate, is published via the shared interface, becomes visible to an allowed downstream stage and is read at a fixed version.
3. A rewritten source retains readable v1 and v2; unchanged content does not duplicate versions. A v1 consumer remains on v1 and is marked affected by v2; unrelated consumers are not.
4. Shell writes and failed/cancelled writes reconcile within declared scope; external/unattributed changes do not acquire fabricated producer identity. SKILL.md load alone produces no delivery.
5. Repeated/late events, process restart, competing writes and reconnect do not duplicate accepted changes or replace a newer attempt. Corrupt/incomplete data is explicit.
6. Structure/summary/content reads obey budgets and versions. UI previews do not create model-consumption receipts. Scope and path boundaries reject cross-project reads.
7. Checks and schema adapters are selected dynamically by actual content/metadata and stage policy. Old checks do not certify new bytes, and unknown business requirements are not considered passed.
8. Existing governed workflows, forward order and send-back behavior still work. Arbitrary runtime files display alongside explicit governed documents without becoming false governance evidence.
9. Targeted tests, package typechecks, architecture/hooks checks, production builds and representative UI/browser/end-to-end verification pass, or any pre-existing external failures are isolated with evidence.

## Scope boundary
Implement all functional mechanisms above and extension interfaces. Installing external cloud providers, buying model services, deploying/releasing to external environments, and changing unrelated adapter/dashboard work are outside this request. No unsupported host is described as fully observed. Preserve the existing workspace; do not restore deleted AGENTS.md or remove concurrent changes.
