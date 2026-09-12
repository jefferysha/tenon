# Backend code review

Reviewed `docs/contract.md`, `docs/design.md`, `tasks.md`, `src/server.mjs`, `test/server.test.mjs`, `package.json`, and recorded test evidence.

## Findings and fixes

- **Fixed concurrency correctness defect in PATCH/DELETE.** The original handlers resolved the task index before entering the serialized write queue. A preceding queued delete could shift indices, causing a later operation to mutate/delete the wrong task. Lookup now occurs inside the queue by stable ID (`src/server.mjs`).
- **Fixed malformed path handling.** `decodeURIComponent` could throw for an invalid percent escape and produce a 500. IDs are now decoded through a guarded helper and malformed IDs return the documented 404 JSON error.
- **Fixed temporary-file cleanup.** Persistence failures previously left temporary files behind. The atomic writer now closes handles and removes its temporary file in `finally`; state is still published only after rename.

Request bodies remain bounded to 1 MiB, JSON and field validation return 400, writes are serialized, and responses use JSON error objects where bodies exist. Route matching rejects extra path segments and startup loading remains fatal for malformed/unreadable stores.

## Verification evidence

`npm test` was attempted. It could not run to completion in this sandbox because child processes are forbidden from binding TCP sockets (`listen EPERM`), leaving the test waiting for `LISTENING`. Direct evidence was: `DATA_FILE=/tmp/x-task.json PORT=0 node src/server.mjs` -> `Error: listen EPERM: operation not permitted 0.0.0.0`.

No acceptance result is claimed in this review stage.
