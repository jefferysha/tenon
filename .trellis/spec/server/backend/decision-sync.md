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
decisionStateDigest + runId + channel`. The derived key is persisted before
the acknowledgement side effects are exposed. This is the sole terminal
exception to explicit request fields; hooks without a Change lock may write an
observation only. Replay is prevented by the durable key and exact receipt
binding, not by the hook marker.

## B. Accepted HTTP command

`POST /api/change/:name/decisions` accepts **review acknowledge only**. Skill
questions and AFK decisions use their existing terminal/automation producers.
The server calls the shared review-acknowledge application in-process with
`channel=dashboard` and never imports CLI code.

## C. Durable idempotency

There is one store: the Change-owned `.pipeline-decision-idempotency.jsonl`.
The server and shared application are its only writers/readers. The former
`packages/server/src/decisionIdempotency.ts` and any process-local or second
ledger store are forbidden.

## D. Locked ordering and replay

Within the Change lock, processing is always: (1) read idempotency; (2) return
the stored result for the same full payload or `idempotency-conflict` for a
different payload; (3) for a new key, read the exact pending receipt and verify
binding; (4) compare expected revision; (5) commit canonical fields, records,
interaction and idempotency atomically. A replay after consumption or rejection
returns the original stored code and does not re-run side effects.

## E. Rejection and errors

`review-approval-required`, `revision-conflict`, and `idempotency-conflict` are
intentional client outcomes. Missing, late, not-pending, or binding-mismatched
requests do not create a new rejected receipt; characterization tests preserve
zero canonical writes and stable 409 responses. An unexpected exception is
HTTP 500 with no `code` field and zero writes. `marker-warning` is a successful
acknowledgement with a non-fatal deferred cleanup warning, never a failure.

## F. Anchors and projection identity

The request anchor is exactly `requestedAt + decisionStateDigest + runId`.
`ref.id` is derived from `change + kind + phase/event or invocation/question +
that anchor`; it does not independently embed a revision. `expected_revision`
remains a separate CAS check. GET and POST build the same projection input and
therefore the same ref.

## G. AFK and mode-switch provenance

AFK attribution is stored as an independent durable `afk-decision-recorded`
event written by `afk-producer.ts`; its `invocationId` joins to
`invocation-started.adapter.kind=afk`. `mode-switched` is an append-only event
written by the mode command with `from`, `to`, principal, channel, effective-at,
policy revision, and pending anchors. These are separate from review channel
and Skill decision mode.

## H. Result union

The shared application returns:

```ts
type DecisionCommandResult =
  | { ok: true; code: 'approved' | 'idempotent-replay' | 'marker-warning'; changed: boolean; idempotent: boolean; ref: DecisionRef }
  | { ok: false; code: 'review-approval-required' | 'revision-conflict' | 'idempotency-conflict' | 'invalid-command'; message: string; ref?: DecisionRef }
```

The server owns HTTP mapping: all listed failures are 409 except unexpected
exceptions, which are 500. `marker-warning` remains HTTP 200.

## I. Source and status vocabulary

`source` uses `terminal | dashboard | automation | delegated | unknown`;
`source=host` is not a valid value. `DecisionStatus.expired` is retained for
backward codec compatibility but this system never produces it; TTL remains
deferred until canonical expiry evidence exists. `actor` is an opaque
principal, never the strings `human` or `user`.

## J. Host resume

Host resume/new-turn capability is `unverified` until each adapter declares a
concrete API. A capable host receives a resume signal after durable commit; an
incapable host observes the result at the next hook, tool call, or transition
boundary. No adapter may claim wake-up success without that capability.

## K. Canonical fields and attribution

`review_acknowledged_via` is a canonical field appended at the end of
`FIELD_ORDER`, with `terminal | dashboard | automation | delegated | unknown`.
It must be synchronized across codecs, `.pipeline.yaml`, fixtures and writers.
It identifies the route, not a human. Receipt consumption is derived by joining
the exact receipt to a successful TransitionRecord and review interaction;
clearing receipt fields alone never proves `consumed`. `superseded` and late
answers are derived from appended stale/rejected events. `expired` is deferred.

## Modes and security observation

HITL maps to `interactive` or frozen `recommended-defaults` for routine hidden
questions only. AFK maps to `afk` and records an independent AFK decision. A
mode switch affects only later requests; existing pending requests retain their
frozen strategy or are explicitly superseded.

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
