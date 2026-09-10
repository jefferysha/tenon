# Workflow Track Branches and Gates (`workflow/`)

## 1. Scope / Trigger

- Trigger: any change to the workflow YAML schema (`WorkflowDef`), the effective plan, or gate semantics.
- A track is a **branch inside the workflow YAML**, not a separate registry concept. Each branch is a
  complete pipeline. The change's track selects the branch at plan time.

## 2. Signatures

```ts
// workflow/types.ts
interface TrackBranchDef { label?: string; steps: StepDef[] }
interface WorkflowDef { …; steps: StepDef[]; tracks?: Record<TrackId, TrackBranchDef> }
type GateKind = 'review' | 'auto' | null          // 'confirm' removed
interface SkillRef { id; kind?; review_lane?; depends_on? }   // no `when`

// workflow/validate.ts
workflowBranches(def): Array<{ track: '' | TrackId; label?; steps }>
selectTrackBranch(def, track?: string): WorkflowDef          // tracks stripped

// workflow/effective-plan.ts
selectTrackBranchIr(ir, track?: string): WorkflowIR
planFromIr(id, model, compiled, track?) → { definition: compiled, workflow: selected, workflowFingerprint(compiled) }

// workflow/branch-track-lookup.ts
requireTrackForRoot(registry, trackId, repoRoot, workflowName?): TrackDefinition
projectWorkflowNames(repoRoot): string[]

// tracks/branch-track.ts
resolveTrackForBranch(registry, id, workflowDef): TrackDefinition | undefined
```

## 3. Contracts

- YAML: top-level `steps:` is the base branch; `tracks:` holds `<track-id>:` → optional `label:` and
  `steps:` (same step schema, indented four more spaces). Track ids match `TRACK_ID_RE`.
- `compileWorkflow` compiles every branch (`tracks.<id>.steps[i]` error paths) and keeps `tracks` on the IR.
  `planFromIr` selects `tracks[track.id]` or the base and exposes it as `plan.workflow`; the full IR stays on
  `plan.definition`. **The fingerprint hashes the full definition**, so it is identical for every track and
  byte-identical to the pre-branch fingerprint for definitions without `tracks`.
- Frozen snapshots (`workflowPlanSnapshot`) store `plan.definition`; `effectiveWorkflowPlanFromSnapshot(snapshot, track)`
  re-selects the branch. A change's pipeline is therefore stable as long as its `track` field is stable.
- `validateWorkflow` validates each branch with its own step graph rules (errors prefixed `tracks.<id>: `);
  `validateWorkflowForStorage('default', …)` runs the seven-phase skeleton check on every branch.
- Track policy: a registered track keeps its `policyProfile`. An id that exists only as a branch resolves
  through `resolveTrackForBranch` to `BRANCH_TRACK_DEFAULT_POLICY` (pending review seed, matrix off, no routing).
  `requireTrackForRoot` is the runtime lookup for CLI init / transition / afk and server routes; it searches the
  named workflow, else `default` then `.pipeline/workflows/*.yaml`.
- Gates: `review` unchanged (request → acknowledge → transition). `auto` compiles to `nonempty-output` on every
  outgoing transition of the step (one `field-nonempty` / `output-present` per declared output). `null` runs
  only explicit guards. `confirm` is rejected by both the parser and the compiler with a hint naming the two
  replacements.
- `default.yaml`: base branch (drivers only, plan artifact keeps `required_when: track_not_in: [pm]` so historical
  fingerprints stay valid) plus `tracks.pm / frontend / backend / free`. `DEFAULT_ARTIFACT_DECLARATIONS` is
  keyed by branch (`_base` + track ids); `defaultArtifactsForStep(step, track)` reads the branch table only.
  `check:default-skill-matrix` compares every branch's non-driver skills with `manifest.yaml`.

## 4. Validation & Error Matrix

- Unknown key under a branch → compile error `tracks.<id>: 出现该变体不接受的附加键`.
- Branch id violating `TRACK_ID_RE` → parse/compile error.
- `gate: confirm` → `gate 'confirm' 已移除——需要人工停下用 review，输出齐全即放行用 auto`.
- Track neither registered nor a branch → `requireTrack` error (`未知 track`).
- Corrupt workflow YAML while resolving a branch track → the load error propagates; it is never reported as an
  unknown track.

## 5. Good / Base / Bad Cases

- Good: `init --track mobile --workflow branched` where only `branched.yaml` declares `tracks.mobile` → phase = first
  step of the mobile branch.
- Base: `init --track backend` on default → `plan.workflow` is the backend branch, `plan.definition` has all four.
- Bad: `gate: confirm` in a project file → the file fails to load with the replacement hint.

## 6. Tests Required

- `workflow/track-branch.test.ts`: parse/serialize round trip, `selectTrackBranch`, plan selection + shared
  fingerprint, per-branch validation prefix, branch-only track synthesis, `auto` guard expansion, `confirm` error,
  default branches pass the skeleton check.
- `workflow/default-artifacts.test.ts` and `generate-default-workflow.test.ts`: branch-keyed table.
- `packages/cli/src/track-branch.integration.test.ts`: branch-only init, unknown track rejection, `auto` gate blocks
  then passes.

## 7. Wrong vs Correct

### Wrong

```yaml
skills:
  - id: brainstorming
    when:
      track_in: [pm, frontend]     # per-skill track conditions no longer exist
```

### Correct

```yaml
steps: [...]                       # base branch
tracks:
  pm:
    label: 产品
    steps: [...]                   # its own pipeline, including brainstorming where it applies
```
