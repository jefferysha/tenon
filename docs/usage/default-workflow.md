# Default workflow and review gates

## Goal

Operate the governed seven-phase default Workflow, including return edges and
exact review receipts.

## Prerequisites

- an active Change using `workflow=default`
- the single `tenon` skill dispatched by the Tenon entrypoint
- current document evidence for the phase

## Workflow graph

```text
open → explore → spec ⇄ build ⇄ verify → ship → archive
          review   review         review
```

Transitions:

| From | Event | To | Meaning |
| --- | --- | --- | --- |
| open | `open-complete` | explore | framing is recorded |
| explore | `explore-complete` | spec | explored design is approved |
| spec | `spec-complete` | build | specification/plan is approved |
| build | `build-complete` | verify | implementation baseline is frozen |
| build | `requirements-changed` | spec | approved meaning changed |
| verify | `verify-pass` | ship | exact baseline passed review |
| verify | `verify-fail` | build | implementation needs correction |
| ship | `ship-complete` | archive | delivery evidence is applied |

Explore, Spec, and Verify are review-gated.

Tenon ships exactly one skill of its own, `tenon`. It reads the Change's frozen
workflow plan and executes the current step from `tenon status <change> --json`
→ `step.next`. Which skills a step loads is declared per track in
`templates/workflows/default.yaml`; the manifest `mandatory_skills` table is a
routing projection of that same data and only overlays automatically when the
Track matrix is enabled.

Skills declared per step (default, by track):

| Step | pm | frontend | backend | free |
| --- | --- | --- | --- | --- |
| `open` | openspec-propose | openspec-propose | openspec-propose | openspec-propose |
| `explore` | brainstorming · grilling · domain-modeling | openspec-explore · brainstorming · grilling · domain-modeling | openspec-explore · brainstorming · grilling · domain-modeling · codebase-design | brainstorming |
| `spec` | openspec-propose · brainstorming · writing-plans · grilling · domain-modeling | openspec-propose · writing-plans | openspec-propose · writing-plans | openspec-propose · writing-plans |
| `build` | prototype · frontend-design | test-driven-development · frontend-design | test-driven-development | test-driven-development |
| `verify` | browser-qa · web-design-guidelines · design-taste-frontend · verification-before-completion | verification-before-completion · e2e-testing · browser-qa · web-design-guidelines · design-taste-frontend | verification-before-completion | verification-before-completion |
| `ship` | — | finishing-a-development-branch | finishing-a-development-branch | finishing-a-development-branch |
| `archive` | — | — | — | — |

The `chat` track — the default when the Dashboard picks no track — declares no skills. Its document
contract still governs the outputs, but a default resolution without a track needs no upstream skill
bytes, so it also holds on a clean checkout.

The Verify phase also opens exactly one automated Review attempt for the frozen
`build_sha`. Its standards, spec, and E2E lanes share the same attempt ID and
finite Workflow budget. E2E is a Review lane, not an independent Review count.
No Review Skill, reviewer agent, or E2E runner may start before that attempt is
active. Build TDD, unit tests, type checks, lint, and narrow integration tests
remain Build feedback and do not consume the Review budget.

Ship applies the verified delta spec with `tenon spec apply <change>`, which
rehearses `openspec validate`/`archive` in a temporary copy of `openspec/`,
writes only the changed main spec bytes back under a compare-and-swap, and
records `applied-spec.md`.

Ship also has a machine-enforced migration guard. When the Change contains
`migration/spec-application.json`, the managed apply tool must produce a result bound to the
Change, input receipt, delta, target path, and final digest. Both `tenon check` and
`tenon transition ... ship-complete` revalidate that evidence and fail closed on drift.

## Phase operation

### 1. Inspect current truth

```bash
tenon status <change-name> --json
tenon document status <change-name>
```

### 2. Run the step`s declared skills

The coding agent reads the packaged `tenon` skill and the current Change
documents, performs the work, and records its current-visit evidence. Do not
replace real Skill execution with a claim in prose.

### 3. Check the exit

```bash
tenon check <change-name>
```

Exit `0` means current guard checks pass. Exit `2` means the report contains
unmet guards. Check does not transition.

### 4. Handle a review exit

Bind the request to the exact event:

```bash
tenon review request <change-name> --event <event>
```

After the user reviews and confirms:

```bash
tenon review acknowledge <change-name>
tenon transition <change-name> <event>
```

Use `--delegated` only when the user has already granted continuous authority
for this exact Change:

```bash
tenon review acknowledge <change-name> --delegated
```

Delegation records the confirmation fact. It does not remove evidence, guards,
or authority boundaries.

### 5. Use return edges honestly

If approved requirements/design meaning changes during Build:

```bash
tenon transition <change-name> requirements-changed
```

Revise and review in Spec. Do not overwrite an old digest in Build.

If verification fails:

```bash
tenon review request <change-name> --event verify-fail
tenon review acknowledge <change-name>
tenon transition <change-name> verify-fail
```

Fix in Build, freeze a new baseline, and verify again. A `verify-pass` receipt
cannot approve `verify-fail`, or vice versa.

## Expected result

Every transition has the correct Workflow edge, guard evidence, current
documents/reads, and exact review receipt where required.

## Verification

```bash
tenon status <change-name> --json
tenon document status <change-name> --json
tenon check <change-name>
```

At Build completion, `build_sha` contains a canonical `build:v1` token bound to
the revision, physical repository, and physical worktree. Old bare Git SHAs or
workspace baselines are rejected and must be recaptured in Build; the runtime
never backfills them. A missing, malformed, stale, or unproven token blocks
Verify with `verify-build-revision-untrusted` and remediation
`return-to-build-and-capture-current-revision`. The same closed blocker is
used by readiness, HTTP/SSE projections, and AFK settlement.

## Common failures

### Review acknowledged but transition still fails

Confirm the request was bound to the same event and current phase visit.

### Build wants to alter proposal/design meaning

Use `requirements-changed`; do not conceal drift by re-recording approval
documents from Build.

### Verify changed implementation files

Verify must inspect the frozen baseline. A correction belongs on the
`verify-fail → build` return path.

### Verify reports an untrusted build revision

Return to Build and run `build-complete` to capture a fresh `build:v1` token.
Do not set or backfill `build_sha` by hand; the transition record is part of
the provenance proof.

## Next action

Read [documents, Skills, and evidence](documents-skills-and-evidence.md) or
[Dashboard status semantics](dashboard-and-local-api.md).
