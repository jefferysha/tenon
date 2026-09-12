# Implementation and integration plan

The user explicitly approved creation and execution after reviewing the complete recommendation. The task artifacts consolidate that reviewed scope; implementation proceeds after local artifact/contract review and `task.py start`, without another identical permission question.

## Work map
- [x] Core child: domain records/validation, durable content/event store, scoped catalogs, consumers/impact, providers/checkers and tests.
- [x] Runtime child: production execution wiring, baseline/terminal reconciliation, progressive reads/update boundary, retries/failures and integration tests.
- [x] UI child: runtime API/preview and consumer views, authoring simplification/policy, localization and component/route tests.
- [x] Lead integration: API alignment, change-scoped server wiring, docs/spec updates, final validation and scoped delivery.

## Ordering
1. Record baseline of existing dirty changes and load applicable specs. Read approved research and check no unresolved product decisions.
2. Core publishes public types and exact API before runtime/UI consumers implement imports. Runtime/UI may inspect seams and make independent UI edits first.
3. Implement all children, checking changed areas without clobbering shared files. Notify lead immediately of a real incompatible contract.
4. Integrate and test a real producer→consumer run; cover file creation, publication, consumption, v2 invalidation, deletion, cancel, concurrent/repeated events and restart.
5. Independent Trellis check reviewed the full requirement matrix and repaired publication, visibility, version ordering, and change-root alignment gaps.
6. Update current specs (especially static-I/O assumptions), build artifacts in scope, review final diff, commit only this task's owned changes, archive completed tasks and record journal.

## Required validation
- `npx vitest run` with targeted artifact, runtime, CLI and Server files during implementation.
- `npx tsc -b packages/kernel packages/channel packages/tap packages/automation packages/cli packages/server`.
- `npm run typecheck:web`; focused dashboard Vitest followed by `npm run test:web`.
- `npm run check:architecture`; `npm run test:hooks` and applicable adapter checks when hook/install wiring changes.
- `npm run build:web`, `npm run build:server`, `npm run bundle` after integration, preserving unrelated source changes.
- Full non-web suite once integration is ready if environment permits; classify baseline failures rather than claiming unrelated green.
- Browser check using one shared browser owner: new ordinary workflow, real artifact run list, version preview/impact and mobile layout.
- `git diff --check`; requirement-to-test matrix and known limitations in research/acceptance.md.

## Risks
Existing parallel dirty files include installers, hook helpers, catalog code, generated bundles and Server definition routes. Prefer new isolated files, inspect latest content before patching shared entrypoints, and never stage others' hunks. Unsupported/opaque hosts cannot prove complete read attribution. Arbitrary external systems need providers rather than speculative automatic fetches. Unknown business rules remain unchecked.
