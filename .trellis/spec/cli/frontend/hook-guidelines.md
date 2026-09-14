# Hook Guidelines

> How hooks are used in this project.

---

## Overview

<!--
Document your project's hook conventions here.

Questions to answer:
- What custom hooks do you have?
- How do you handle data fetching?
- What are the naming conventions?
- How do you share stateful logic?
-->

(To be filled by the team)

---

## Custom Hook Patterns

<!-- How to create and structure custom hooks -->

(To be filled by the team)

---

## Data Fetching

<!-- How data fetching is handled (React Query, SWR, etc.) -->

(To be filled by the team)

---

## Naming Conventions

<!-- Hook naming rules (use*, etc.) -->

(To be filled by the team)

---

## Common Mistakes

<!-- Hook-related mistakes your team has made -->

(To be filled by the team)

## Review and automation decisions

The terminal is the only model-interaction surface. CLI review acknowledgement
uses the shared review application and supplies `channel=terminal`; Dashboard
uses the same application with `channel=dashboard` and never starts a model or
Skill question.

HITL maps to `interactive` or the narrowly scoped
`recommended-defaults` policy (routine, hidden, frozen rule match). AFK maps to
`afk` and writes an independent decision/source record. Invocation
`adapter.kind`, decision mode, and review channel are orthogonal and must not be
collapsed into one enum.

A channel identifies the entry route, not the operator's identity. Bearer-token
requests and `actor` values must never be labelled `human` without an
independently trusted identity provider.

| User mode | Internal strategy | Adapter boundary |
|---|---|---|
| HITL | `interactive` | Terminal asks and records the answer; Dashboard may only invoke the review adapter for an existing exact pending receipt. |
| HITL | `recommended-defaults` | Frozen routine/hidden policy only; it cannot satisfy a hard gate. |
| AFK | `afk` | Attributed only through `invocation-started.adapter.kind=afk`; the independent AFK decision event is deferred (`decision-sync.md` G). |

### Self-approval detection (`gate.sh` → `internal-self-approval`)

- **Order.** Candidate detection and the recorder call run **before** the
  `TENON_AFK=1` exit. AFK skips blocking only; it never skips recording. Outside
  AFK, a token-file candidate with a fresh relevant v2 review marker still exits
  2 with the existing message, and loopback API calls fall through to the
  ordinary non-read-only block.
- **Hook = broad recall, pure bash.** A raw-input `case` pre-filter
  (`dashboard-token.json`, or a loopback host together with `/api/`) runs right
  after stdin is read; under `TENON_AFK=1` a non-candidate exits there, before
  any JSON parsing or project-root resolution. Non-candidates (including
  `src/api/…` paths and remote `/api/` URLs) never spawn node or parse the
  candidate. Candidates: Read/Grep/Glob/Search `file_path` / `path` / `pattern`
  / `glob` containing `dashboard-token.json`; command text containing
  `dashboard-token.json`, or a loopback host (`localhost`, `127.0.0.1`,
  `[::1]`) together with `/api/`. No curl argument parsing, no skipping of
  `$(` / `|` / wrappers, no runtime-root environment variable, no marker
  freshness condition.
- **CLI = precision.** `tenon internal-self-approval <payload> [change]` reads a
  closed 0600 temp payload (`candidate`, `tool_name`, `tool_use_id`,
  `process_or_host_identity`; the hook runs node in the background and `wait`s
  under a HUP/INT/TERM trap, so the file is deleted after the call and also when
  the host kills the hook during a lock wait; SIGKILL remains uncovered), classifies
  with kernel `classifySelfApprovalCandidate` against `resolveProductPaths()`,
  scans all Changes when no change is given, and re-reads the canonical pending
  receipt + binding under each Change lock. No pending receipt → zero writes
  (no lock artifact, no identity key).
- **Record.** `channel=terminal`, `kind`, `observation_key` dedupe,
  `hmac-sha256` identity digest keyed by the per-install
  `decisionObservationKeyPath` (created exclusively, 0600, symlink refused),
  1 MiB cap with a single overflow marker. Never token text, Authorization
  values, raw command, tool ids or raw identity. The record is a detection
  signal and never proof of human identity.
