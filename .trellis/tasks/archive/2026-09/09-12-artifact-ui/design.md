# Design

Follow the reviewed parent design at `.trellis/tasks/09-12-runtime-artifact-workflow/design.md` and the approved research report.

## Ownership
Server artifact routes and snapshots, Dashboard components/locales/tests and additive workflow resource policy codec. Depend on core API.

## Contracts
Use the core worker’s published `research/artifact-api.md`; no copied local types or casts across API boundaries. Runtime state and content versions never rewrite workflow definitions or fabricate governance receipts.

## Compatibility
Keep existing public APIs additive where practical. Resolve outdated spec premises using the parent PRD and update implementation notes.
