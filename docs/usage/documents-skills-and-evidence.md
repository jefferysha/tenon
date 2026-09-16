# Documents, Skills, and evidence

## Goal

Understand which documents are required, who may author them, how later steps
prove they read them, and why file existence alone is insufficient.

## Prerequisites

- an active governed Change
- the current packaged phase Skill
- document paths under the Change's `openspec/` or approved `docs/` scope

## Default document chain

| Phase | Creates/registers | Must read |
| --- | --- | --- |
| Open | proposal, OpenSpec design, tasks | none |
| Explore | Superpowers design, ADR | Open documents |
| Spec | delta spec, Superpowers plan, plan | Open + Explore documents |
| Build | tasks may be updated | all planning/design documents |
| Verify | verification report; tasks may be updated | all planning/design documents |
| Ship | applied spec; tasks may be updated | planning/design + verification report |
| Archive | tasks may be updated | all prior documents including applied spec |

The state machine does not write substantive product documents by itself. The
active coding agent executes the required phase Skill, authors the content, and
records it with current provenance.

## Ledger model

Governed Changes store `.pipeline-documents.json`. A valid record binds:

- document kind and repository-relative path;
- SHA-256 content digest;
- allowed producer Skill identity;
- current Change and phase visit;
- later-phase read receipts bound to the digest.

Editing a recorded file changes its digest and invalidates stale reads. A copy
of the same path is not equivalent to the recorded content.

## Record an output

```bash
tenon document record <change-name> <kind> <path> \
  --producer <skill-id>
```

The command accepts only document kinds/steps/producers allowed by the current
contract and actual Skill evidence. It does not accept a same-named untrusted
Skill or old evidence from another visit/Change.

Living `tasks` may be updated in later phases only by a producer authorized for
that phase. Re-record the new digest and then read it for the phase.

## Record reads

```bash
tenon document read <change-name> <kind>
tenon document read <change-name> all
```

`all` records the current phase's declared required reads; it is not permission
to invent documents.

Inspect:

```bash
tenon document status <change-name>
tenon document status <change-name> --json
```

Incomplete required evidence exits with code `2`.

## Skill resolution and trust

Mandatory default Skills are bundled with the immutable release. Resolution
uses the bundled trust tier first. External sources are considered only for a
true not-found case; a damaged bundled Skill fails closed rather than silently
substituting a same-named external copy.

The `pipeline` Skill is the orchestration entrypoint. Phase and supporting
Skills still need real current-visit evidence.

## Review evidence

Documents and Skill receipts do not replace human review. Review is a separate,
exact event receipt:

```bash
tenon review request <change-name> --event <event>
tenon review acknowledge <change-name>
```

Deleting a pending marker does not create approval.

## Short/custom Workflow behavior

- `openspec: true` enables document governance; the declared
  `document_contract.version: v1` maps document kinds and reads to the actual
  steps of that Workflow or Track branch.
- no contract means no document governance.

A three-step Workflow therefore creates only what it declares. It does not
automatically inherit proposal, Superpowers, ADR, plan, verification, and
applied-spec documents.

## Expected result

`tenon document status` shows current records and the reads required for the
current phase; transition checks reject missing, stale, or unauthorized
evidence.

## Verification

```bash
tenon document status <change-name> --json
tenon check <change-name>
```

## Common failures

### File exists but status is incomplete

Record it through an allowed current-phase producer with actual Skill evidence.

### Read receipt became stale

The file changed after it was read. Re-read the current approved content in the
current phase and record the new receipt.

### Producer rejected

Confirm the selected plugin Skill identity, current phase visit, and contract
producer list. Do not backfill with unrelated historical evidence.

### Build discovered changed requirements

Return to Spec with `requirements-changed`; revise and review there.

## Next action

Read [default workflow](default-workflow.md) or
[custom Workflows and Tracks](custom-workflows-and-tracks.md).

