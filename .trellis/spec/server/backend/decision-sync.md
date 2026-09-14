# Decision Synchronization Adapter Contract

## Scope and boundary

The terminal is the only model-interaction surface. Dashboard reads pending
projections and may acknowledge an existing review receipt through the shared
application; it never calls a model, creates a prompt, starts a Skill, answers
a Skill question, or writes an AFK decision.

## A. Terminal acknowledgement

The terminal command keeps its user-facing syntax without revision/key flags.
Inside the Change lock the CLI reads the current canonical revision and derives
an idempotency key from `change + phase + event + requestedAt +
decisionStateDigest + runId + channel`. The derived key is recorded in the
ledger inside the same locked command, after the canonical write (see D). This is the sole terminal
exception to explicit request fields; hooks without a Change lock may write an
observation only. Replay is prevented by the durable key and exact receipt
binding, not by the hook marker.

## B. Accepted HTTP command

`POST /api/change/:name/decisions` accepts **review acknowledge only**. Skill
questions and AFK decisions use their existing terminal/automation producers.
The server calls the shared review-acknowledge application in-process with
`channel=dashboard` and never imports CLI code.

## C. Durable idempotency

There is one store: the Change-owned `.pipeline-decision-idempotency.jsonl`,
with one implementation in the kernel shared application
(`createReviewDecisionLedger` + `reviewDecisionPayloadDigest`). CLI and server
inject only the filesystem port (`nodeReviewDecisionLedgerFs`). The former
`packages/server/src/decisionIdempotency.ts`, the server-local ledger reader,
the CLI `review-idempotency.ts`, and any process-local or second ledger store
are forbidden. The ledger stores successful outcomes only; records written
earlier with `outcome: "rejected"` stay decodable and are ignored by lookups.

## D. Locked ordering and replay

`executeReviewAcknowledge` runs entirely inside the Change lock:

1. read the ledger for the command key (Dashboard sends it; the terminal
   derives it from the locked state and a matching binding);
2. for a stored key, return the stored success code with `idempotent: true`
   when the payload digest matches, or `idempotency-conflict` when it differs;
3. for a new key, read the exact receipt and verify `phase == review_gate_phase`,
   that the event is still an outgoing edge of the review-gated step in the
   effective workflow (the server resolves the Change's bound workflow and
   passes it in), the binding, and for Dashboard that the ref is live in the
   shared projection;
4. compare the expected revision (Dashboard CAS);
5. write canonical state, then the ledger record.

Only successes are persisted. A failure is never stored: retrying the same
command re-evaluates the current state deterministically. Interaction, history
and marker cleanup follow the canonical write as best-effort effects; a failure
(including a ledger append failure) is returned in `deferred` and the command
still succeeds, so an approval is never reported as an error. Replay and
already-approved paths also clear the marker. Marker cleanup has one
implementation, `clearReviewMarkerFor`, used by both channels; its failure
yields `marker-warning`. CLI and server write the same history line,
`review:acknowledge via=<channel> phase=<phase> event=<event>` (delegated
acknowledgements append the authority reference).

## E. Rejection and errors

`review-approval-required`, `revision-conflict`, `idempotency-conflict` and
`invalid-command` are intentional client outcomes with zero writes: missing,
late, not-pending, binding-mismatched, stale-revision and invalid commands write
no canonical field, revision, TransitionRecord, history line, interaction event
or ledger record, in both the server and the CLI. An unknown or missing ref
returns `review-approval-required`; the server emits no other 409 code
(`decision-not-pending` and `decision-ref-mismatch` no longer exist). An
unexpected exception before commit is HTTP 500 with a fixed generic message, no
`code` field and no filesystem path, and zero writes. `marker-warning` is a
successful acknowledgement with a non-fatal deferred cleanup warning, never a
failure.

## F. Anchors and projection identity

The request anchor is exactly `requestedAt|decisionStateDigest|runId`. The
digest comes from the review binding sidecar when it names the same phase,
event and requestedAt; otherwise it is the digest of the current canonical
decision state, which excludes receipt fields, so pending and approved share
the anchor. The sidecar survives the transition, so a consumed receipt keeps
its anchor. `ref.id` is derived from `change + kind + phase/event + anchor`
(`reviewDecisionRef`) or `change + kind + invocation/question`; it never
embeds a revision and is unchanged across pending, answered and consumed.
`expected_revision` remains a separate CAS check. GET and POST read projection
input through `readPendingDecisionProjection`, and the application derives the
ref with the same kernel functions.

## G. AFK and mode-switch provenance (deferred, not implemented)

The durable `afk-decision-recorded` event (written by `afk-producer.ts`, joined
by `invocationId` to `invocation-started.adapter.kind=afk`) and the append-only
`mode-switched` event (`from`, `to`, principal, channel, effective-at, policy
revision, pending anchors) are deferred. No producer exists and the kernel
carries no builder for either; the unused `modeSwitchEvent` and
`pendingAccessAlert` helpers were removed. Until they exist, AFK attribution is
derived only from `invocation-started.adapter.kind=afk`, and projections must
not present either event as recorded. Review channel and Skill decision mode
remain separate.

## H. Result union

The shared application returns:

```ts
type DecisionCommandResult =
  | { ok: true; code: 'approved' | 'idempotent-replay' | 'marker-warning'; changed: boolean; idempotent: boolean; ref: DecisionRef }
  | { ok: false; code: 'review-approval-required' | 'revision-conflict' | 'idempotency-conflict' | 'invalid-command'; message: string; ref?: DecisionRef }
```

`executeReviewAcknowledge` adds `deferred`, `phase` and `event` for adapters.
Adapters own only the transport mapping:

| Result | HTTP | CLI exit |
|---|---|---|
| `approved`, `idempotent-replay`, `marker-warning` | 200 | 0 |
| `review-approval-required` | 409 | 2 |
| `revision-conflict` | 409 | 3 (Dashboard CAS; the terminal sends no revision) |
| `idempotency-conflict` | 409 | 4 |
| `invalid-command` | 409 | 1 |
| unexpected exception | 500, no `code` | 1 |

## I. Source and status vocabulary

`source` and `channel` use `terminal | dashboard | automation | delegated |
unknown`; `source=host`, `user` and `afk` are not valid values. Decision
strategy (AFK, recommended defaults) stays in invocation evidence.
`DecisionStatus.expired` is retained for backward codec compatibility but this
system never produces it; TTL remains deferred until canonical expiry evidence
exists. `actor` is an opaque principal, never the strings `human` or `user`:
review request, acknowledgement and resume interaction events use `system`.
`human` remains in the interaction codec enum only so older events stay
decodable.

## J. Host resume

Host resume/new-turn capability is `unverified` until each adapter declares a
concrete API. A capable host receives a resume signal after durable commit; an
incapable host observes the result at the next hook, tool call, or transition
boundary. No adapter may claim wake-up success without that capability.

## K. Canonical fields and attribution

`review_acknowledged_via` is a logical canonical field appended at the end of
`FIELD_ORDER`, with `terminal | dashboard | automation | delegated | unknown`.
It identifies the route, not a human. Like `pre_verify_review_result` it is
companion-backed: the schemaVersion=1 wire (`current.json` and immutable
revisions), mutation and TransitionRecord effects, and the `.pipeline.yaml`
projection never contain it, so earlier runtimes keep their closed field set
(the frozen N-1 reader, and the v1.0.7–v1.0.9 pre-Verify companion reader).
The value lives in `.pipeline-run/review-acknowledged-via/<revision>-<revisionId>.json`
(`schemaVersion`, `revision`, `revisionId`, `stateDigest`, `via`), published
before the revision only when it is not `unknown`, and restored by every
canonical reader; identity/digest mismatch fails loud. A missing record reads
as `unknown`, including revisions an earlier runtime writes after an
acknowledgement. Revisions from unreleased development builds that still carry
the field inside wire `state.fields` (and its effect entry) decode with that
value and are rewritten in the companion shape on the next write.

Attribution sources: a live receipt uses the restored logical field; a consumed
receipt, whose fields are cleared, uses the linked `review.acknowledged`
interaction event (`surface`) and the `review:acknowledge via=<channel>` history
line. No consumer derives the channel from TransitionRecord effects.

Receipt consumption is derived by joining
the exact receipt to a successful TransitionRecord and review interaction;
clearing receipt fields alone never proves `consumed`. New code never appends
rejected acknowledgement events. `superseded` is derived only from rejected
acknowledgement events that already exist in historical interaction logs, or
from an unconsumed request replaced by a newer request. `expired` is deferred.

`tenon state import-legacy` never changes transition-controlled fields
(`phase`, `phase_status`, `branch_status`, `build_sha`,
`pre_verify_review_result`, review receipt fields). Protected fields whose YAML
value differed are reported: the CLI prints a warning listing them and the
server operations response returns `ignored_protected_fields`.

## Human gate

A loop `human_gates` entry denies any transition whose target it names unless
the caller supplies `humanGateSatisfied=true`. The Dashboard/local HTTP entry
(`POST /api/change/:name/transition`) always supplies `false`: a bearer token
is not human evidence, and the long-running server process env does not
describe the caller. A gated target therefore returns 409
`{ code: 'constraint-denied', reason: 'human-gate-required' }` with zero writes
(fields, transition sequence, history, TransitionRecords); non-gated targets
are unaffected. The CLI treats `TENON_AFK=1` as a mode signal that must deny;
an unset variable allows, which is a same-OS-user limitation, not proof of a
human.

## Modes and security observation

HITL maps to `interactive` or frozen `recommended-defaults` for routine hidden
questions only. AFK maps to `afk`; its attribution currently comes only from
`invocation-started.adapter.kind=afk`, and the independent AFK decision event
and mode-switch semantics are deferred (see G).

During a pending review, a redacted `pending-decision-self-approval-suspected`
observation is appended for dashboard token-file reads (`token-file-read`) and
any loopback `/api/` call (`local-control-api-call`). Detection is split:
`hooks/gate.sh` recalls broad candidates (Read/Grep/Glob inputs or command text
naming the token file, or a loopback host plus `/api/`) **before** the
`TENON_AFK=1` exit, and `internal-self-approval` classifies the candidate
against the product-resolved token path, then re-reads the canonical pending
receipt and binding under each Change lock. The hook marker is never the
condition; no pending receipt means zero writes. Records carry change, phase,
event, anchor, `channel=terminal`, kind, `observation_key` (sha256 of change +
anchor + kind + tool_use_id or candidate digest, deduped under the lock),
observed-at and an `hmac-sha256` identity digest keyed by the per-install 0600
`decisionObservationKeyPath`; never token text, Authorization values, raw
command or tool ids. The file is capped at 1 MiB: one overflow marker is
appended and later observations are dropped. AFK only skips blocking, never
recording. The observation detects a capability risk; it cannot approve or
reject a review by itself. Detection is text-based recall, not containment:
paths or hosts that never appear literally (encoded or assembled strings, globs
such as `dashboard-tok*`, other loopback spellings like `0.0.0.0`, `127.1` or
the machine hostname, or a script file that reads the token internally) are
accepted misses. HITL blocking of token reads still follows the review marker
TTL; recording does not.
