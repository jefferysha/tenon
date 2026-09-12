# Implementation Checklist

- [ ] Add `src/server.mjs` Node.js HTTP entrypoint and startup `LISTENING` output.
- [ ] Implement health, task CRUD routes and exact status codes/body shapes.
- [ ] Validate JSON bodies, non-blank titles, and allowed statuses; return JSON error strings.
- [ ] Implement safe task ID lookup and 404 behavior.
- [ ] Persist task data through `DATA_FILE`, including restart recovery.
- [ ] Serialize concurrent writes without lost tasks; handle persistence errors safely.
- [ ] Add package metadata and meaningful unit/integration tests for all contract cases.
- [ ] Run source acceptance/tests, then package a release archive with `src/server.mjs` at archive root.
