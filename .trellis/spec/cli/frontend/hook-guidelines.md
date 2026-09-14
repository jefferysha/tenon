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
| AFK | `afk` | Automation records an independent decision/source and is attributed through the invocation join. |

During a pending review gate, hooks may emit a redacted
`review-self-approval-signal` when the token file is read or a localhost control
API is called. The signal contains change/phase/event/request, channel,
process-or-host hash, timestamp, and signal kind; it never contains the token
or claims to prove human identity. C consumes and displays the signal, or a
separate P1 security task owns hook emission if it cannot ship with C.
