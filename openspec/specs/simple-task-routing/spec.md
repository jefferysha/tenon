# Simple Task Routing Specification

## Purpose

Define the bounded, exclusion-first simple-task route and its lightweight Workflow so narrow local
changes can run with proportionate governance without capturing broader or risky work.

## Requirements

### Requirement: The router SHALL provide a first-party simple task track
The system SHALL expose a built-in `simple` Track for clearly bounded, low-risk local changes. The
Track SHALL bind to a packaged lightweight workflow and SHALL remain available after
`tenon setup --codex` without requiring a project-authored workflow file or an external skill.

#### Scenario: A bounded text correction uses the lightweight workflow
- **WHEN** a user asks to correct a typo, comment, copy string, unused import, or other explicitly
  bounded local value and no exclusion signal is present
- **THEN** the router dispatches `track=simple` and `workflow=simple`
- **AND** the Change begins at the lightweight `change` step rather than default `open`

#### Scenario: A normal developer request still triggers governance
- **WHEN** a user asks to implement, fix, or modify code without the strict simple-task evidence
- **THEN** the request is routed to the applicable full PM/frontend/backend Track
- **AND** it is not silently dropped merely because no narrow technology keyword matched

### Requirement: Simple classification SHALL be fail-closed and exclusion-first
The simple Track SHALL require a positive bounded-change match. Its routing definition SHALL also
carry exclusion criteria for cross-module work, features/refactors, public APIs, schema/migrations,
databases, authentication/authorization/security, concurrency/transactions, dependencies,
production data, deployment, publishing, and external side effects. Any exclusion match SHALL set
the simple candidate score to zero before winner selection, regardless of priority.

#### Scenario: A generic tweak with no target is not simple
- **WHEN** a prompt only says “微调一下” or names a version change without a concrete local file,
  UI element, field, or line target
- **THEN** the simple positive matcher does not qualify it
- **AND** the applicable full Track or normal clarification path handles the request

#### Scenario: A one-line API contract change is not simple
- **WHEN** a prompt says that only one line changes but the line alters an API or public contract
- **THEN** the exclusion match defeats the simple positive match
- **AND** the full engineering Track wins

#### Scenario: A TSX copy typo remains simple
- **WHEN** a prompt identifies one copy typo in a `.tsx` file and contains no exclusion signal
- **THEN** simple may win over the frontend domain keyword by priority

### Requirement: The simple workflow SHALL verify changes without the governed document chain
The packaged simple workflow SHALL expose `change`, `verify`, `done`, and `escalated` steps. It
It SHALL declare no skill for the change step, carrying the boundary rules in that step's
`prompt` instead, and `verification-before-completion` for the verify step. It SHALL not declare
`openspec_contract: required`, create OpenSpec/Superpower/ADR requirements, or add review gates.
The Dashboard and native Todo projection SHALL show the actual lightweight steps rather than the
default seven phases.

Every non-terminal step exit SHALL be rejected until the current visit's declared skills have
host-completed evidence. A previous visit's receipt SHALL not satisfy a later loop back into the
same step, and CLI and HTTP transitions SHALL enforce the same rule.

#### Scenario: A simple task completes
- **WHEN** the local change stays inside the simple boundary and focused verification passes
- **THEN** `change-complete` advances to verify and `verify-pass` advances to done
- **AND** the canonical Change records a passed verification result

#### Scenario: Focused verification fails
- **WHEN** the simple verify step fails
- **THEN** `verify-fail` returns to change for a bounded correction
- **AND** the workflow does not falsely mark the task complete

#### Scenario: Direct transition cannot skip a declared skill
- **WHEN** a caller sends `verify-pass` without current-visit `verification-before-completion` evidence
- **THEN** the state remains at `verify` and the adapter reports `step-skills-incomplete`
- **AND** the same event succeeds only after trusted evidence is present

#### Scenario: Escalation does not fabricate completion
- **WHEN** `scope-expanded` reaches `escalated`
- **THEN** Todo and Dashboard mark only graph-dominating visited stages as complete
- **AND** they do not mark `verify` or `done` complete merely because those nodes precede
  `escalated` in a display array

### Requirement: Scope expansion SHALL escalate rather than bypass governance
The `tenon` skill SHALL inspect the requested and actual change boundary, as stated by the change
step's `prompt`, before and after editing. If it detects any simple exclusion or an unbounded expansion, it SHALL stop lightweight
execution, transition through `scope-expanded` to `escalated`, and hand off to a newly created
default workflow Change with the appropriate full Track. It SHALL preserve an auditable link
between the lightweight attempt and the governed Change.

#### Scenario: A local edit reveals a schema migration
- **WHEN** a requested local fix requires a schema migration after inspection
- **THEN** no schema mutation is performed under the simple workflow
- **AND** the lightweight Change is marked escalated before the full default Change starts
