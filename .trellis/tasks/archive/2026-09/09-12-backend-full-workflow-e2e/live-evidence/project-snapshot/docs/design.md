# Task service design and implementation plan

## Design

Use only Node.js built-ins: `node:http`, `node:fs/promises`, `node:path`, and `node:crypto`. `src/server.mjs` owns routing, bounded request-body collection, JSON parsing, validation, and response formatting. Route matching accepts `/tasks` and one URL-decoded `/tasks/:id` segment; malformed or extra segments are not interpreted as IDs.

At startup, resolve `DATA_FILE`, create its parent directory if needed, and load `{tasks: [...]}`. A missing file means an empty store. Invalid JSON, an invalid top-level shape, or an unreadable existing file is fatal; log the failure and do not print `LISTENING`. Once the HTTP server is bound, print `LISTENING <actual_port>` using `server.address().port`, including when `PORT=0`.

Keep the committed task array in memory. All mutating handlers enqueue one operation on a promise chain, so each operation sees the prior committed state. Persist by serializing the complete store to a same-directory temporary file, closing it, and renaming it over `DATA_FILE`; only then publish the new in-memory array and return success. On any write/rename failure, discard the candidate state, return `500 {"error":"..."}`, and keep serving with the prior committed state. Generate IDs with `crypto.randomUUID()` and return tasks in insertion order.

Responses set `Content-Type: application/json` whenever a body exists. `204` delete responses have no body. Catch handler and persistence errors at the HTTP boundary so malformed input is `400`, missing resources are `404`, unsupported methods are `405`, and unexpected failures are `500`, all with the documented error object.

## Implementation plan

1. Add `package.json` scripts for starting the server and running `node:test`; create `src/server.mjs` with startup loading, routing, validation, queueing, and atomic persistence.
2. Implement request-body limits and strict object validation: non-blank string titles for `POST`, and exactly `pending`/`done` statuses for `PATCH`.
3. Implement CRUD success shapes and status codes, safe ID lookup, unknown-route handling, and consistent JSON errors.
4. Add node:test coverage for health/CRUD, malformed and missing fields, 404/405 behavior, persistence across restart, concurrent creates without lost tasks, and simulated persistence failure.
5. Run the project tests and the supplied acceptance command in later stages; record only actual command output in their reports.
