# Task Management API Contract

## Runtime

- Node.js HTTP server starts from `src/server.mjs` with no external runtime dependencies.
- `PORT` selects the listening port; `PORT=0` is valid. On startup, stdout contains `LISTENING <actual_port>`.
- `DATA_FILE` selects the persistent JSON store. The service must preserve tasks across restart and serialize concurrent writes so no successful task creation is lost.

## Resource

A task is `{ id, title, status }`, where `id` is a server-generated stable identifier, `title` is a non-blank string, and `status` is `pending` or `done`.

## Endpoints

| Method | Path | Success response |
|---|---|---|
| GET | `/health` | `200 {"status":"ok"}` |
| POST | `/tasks` | `201` with created task from `{title}`; status is `pending` |
| GET | `/tasks` | `200 {"tasks":[...]}` |
| GET | `/tasks/:id` | `200` task, or `404` |
| PATCH | `/tasks/:id` | `200` updated task from `{status}`; or `404` |
| DELETE | `/tasks/:id` | `204` empty body, or `404` |

Unknown routes and unsupported methods may return `404`/`405` with the same JSON error format.

## Errors

Every error response with a body is `application/json` and has exactly the shape `{ "error": "<non-empty human-readable string>" }`; clients must not depend on the wording. Malformed JSON, blank or missing `title`, and invalid or missing `status` are client errors and return `400`. Missing task IDs, including syntactically safe but unknown IDs, return `404`. Unknown routes return `404`; a known path with an unsupported method may return `405`, using the same error shape.

The service must never report a successful mutation until its updated state has been durably written. A persistence failure returns `500` with the same JSON error shape and leaves the in-memory state unchanged for that operation. The process may continue serving requests after a failed write; startup/read failures are fatal and must prevent `LISTENING` from being announced.

Mutations are serialized in arrival order through one write queue. Each successful `POST`, `PATCH`, or `DELETE` reads the current state, applies its change, and atomically replaces `DATA_FILE` (write a temporary file in the same directory, flush/close it, then rename). Concurrent requests therefore cannot lose updates. Reads observe the most recently committed state. The JSON store is an object containing a `tasks` array; a missing file initializes an empty store, while malformed or unreadable existing data is a startup failure. IDs remain stable across restarts.
