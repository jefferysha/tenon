# Research: Tenon core cross-layer architecture audit

- Query: Audit Tenon as a packaged plugin across kernel/CLI/server/automation/channel/tap, focusing on data flow, state consistency, errors, performance, test blind spots, and real-runtime gaps.
- Scope: mixed (internal source, specs, README, BACKLOG)
- Date: 2026-09-06

## Findings

### P0 — tap trace session metadata is not cross-process safe

`FileTraceStore.appendRecord` appends the JSONL record and then reads/modifies/atomically replaces the session sidecar, but has no lock or compare-and-swap around the sequence (`packages/tap/src/trace-store.ts:179-192`). Two proxy requests or two daemon processes can both read `record_count=n`, append both records, then each write `n+1`; the records remain present while the count, updated timestamp, and later `finalizeSession` view are inconsistent. `getOrCreateSession` has the same check-then-create race (`:160-176`). The window reader explicitly reports `count-mismatch` (`:300-328`), so this is observable as degraded integrity rather than merely theoretical. This crosses tap → server/dashboard because server exposes trace sessions and windows through its trace routes.

**Validation:** run two worker processes sharing `TENON_TAP_DIR`, each calling `appendRecord` 1,000 times for one session; compare JSONL line count, sidecar `record_count`, and `/api/traces` integrity. Add a crash test between append and sidecar replacement.

### P1 — channel event log is serialized per channel, but projections and liveness are not one snapshot

`append` correctly locks the event append and sidecar update (`packages/channel/src/store.ts:104-120`), while `list` independently reads events and scans `.pid` files (`:142-174`). A worker can exit or be spawned between those reads, producing `events`, `workersTotal`, `workersAlive`, and reduced worker state from different instants. The list path also counts every `*.pid` file before validating it with the full liveness rules used by `liveness.ts`; it can over-report workers when stale PID files or reservations are present. This can mislead dashboard capacity and spawn-budget decisions even though the event append itself is safe.

**Validation:** concurrently run `spawn/kill/prune` while polling `list({allProjects:true})`; compare each row against a fresh `scanLiveWorkers` result and inspect stale `.pid`/reservation cases. Decide whether the UI contract permits eventually-consistent counters or requires a single scan snapshot.

### P1 — scheduler shutdown can persist failure before settlement completes

On interruption, the scheduler aborts in-flight work and immediately calls `state.markFailedSync` while the actual completion promises are only awaited afterward (`packages/automation/src/scheduler/scheduler-service.ts:62-77`). The normal terminal path settles reservations and ledger outcomes through `settleLost`/`settleWon` (`:95-112`). If an abort races with terminal settlement, the state file can say failed while the reservation/ledger records say won or lost; errors from `markFailedSync` are deliberately swallowed (`:70-74`). This is a cross-layer consistency risk for automation → kernel state and dashboard AFK status.

**Validation:** inject a runner blocked at the commit/settlement boundary, call `interruptInFlight`, and assert state, reservation, ledger, and round report converge. Repeat with a failing state writer and verify the report is non-OK and includes a durable recovery signal.

### P1 — server turns unexpected route failures into generic 500 without correlation or operation state

The top-level HTTP handler catches any rejected route promise and sends only `{ok:false,error:errMsg(e)}` with status 500 (`packages/server/src/server.ts:304-319`). Route modules do contain more specific validation and conflict handling, but an uncaught kernel/automation error loses operation identity and phase context at this boundary. For asynchronous AFK/cadence/orchestration work, clients therefore cannot reliably distinguish a transient backend failure, a durable ledger degradation, or a partially committed mutation from a safe retry. The server does construct one orchestration ledger and one run repository per server instance (`:98-103`), so a restart or a second server process is a separate in-memory authority unless the underlying repositories are explicitly shared.

**Validation:** force failures in each route dependency (`runPipelineCli`, ledger write, state store, trace reader); record response body, status, server logs, and persisted state. Define an error envelope with operation/correlation id and test retry semantics for each mutation route.

### P2 — real provider/runtime coverage remains narrower than the packaged surface

The channel supervisor's default adapter path explicitly supports only `echo`/`cat` and throws for other providers (`packages/channel/src/supervisor.ts:451`). Tests document that real Claude/Codex stdio framing, readiness, and event parsing are not covered by the kernel module (`packages/channel/src/supervisor.test.ts:74-90`). Tap has honest skips for local CA/TLS and WebSocket relay when the environment cannot perform the handshake (`packages/tap/src/{tls-mitm,ws-proxy,daemon}.test.ts`), and automation Docker tests similarly gate on daemon availability (`packages/automation/src/runner/docker.ts:1-35`). These are honest test semantics, but the shipped plugin can report green CI while provider adapters, TLS MITM, or Docker execution remain unverified on the actual host.

**Validation:** run the package integration suites with Docker, local CA generation, and real provider credentials separately; publish a capability matrix containing pass/skip/reason. Keep token/provider failures distinct from code failures.

### P2 — synchronous filesystem scans can block the dashboard and proxy hot paths

Several user-facing paths use synchronous filesystem enumeration and reads: channel list (`packages/channel/src/store.ts:131-151`), tap session listing (`packages/tap/src/trace-store.ts:334-341`), and trace record reads (`:217-224`). The server is a single Node HTTP process, so a large trace directory or many project buckets can block all requests while a dashboard refresh is in progress. The trace window has an 8 MiB/200-record bound, but `readRecords` and `listSessions` have no equivalent global count or byte bound.

**Validation:** benchmark `/api/traces` and channel list with 10k sessions / 100 MB records; capture event-loop delay and p95 latency. Add bounded pagination/indexing requirements before claiming production scale.

## Related specs and documents

- `.trellis/spec/kernel/backend/orchestration.md` — kernel orchestration schemas, reducer, and routing contracts.
- `.trellis/spec/kernel/backend/error-handling.md`, `.trellis/spec/automation/backend/error-handling.md`, `.trellis/spec/server/backend/error-handling.md`, `.trellis/spec/channel/backend/error-handling.md`, `.trellis/spec/tap/backend/error-handling.md` — layer error guidance (mostly templates; verify any new contract against actual code).
- `.trellis/spec/guides/cross-layer-thinking-guide.md` — required cross-layer ownership and consistency review.
- `README.en.md:11-14, 222-241` — packaged plugin boundary and CLI/automation/dashboard responsibilities.
- `BACKLOG.md:59-83` — claimed channel, tap, automation, Docker, and real-token milestones; these claims should be reconciled with current host capability runs.

## Caveats / Not Found

- This is a static audit; no code or tests were modified and no git operations were performed.
- The server route dispatcher likely performs token/host checks in `serverTransport`/route dependencies; this report does not claim an authentication bypass, only loss of structured context for uncaught errors.
- No external documentation was needed; primary sources were repository code, tests, specs, README, and BACKLOG. Full provider credentials and Docker/CA runtime state were not available for this audit.
