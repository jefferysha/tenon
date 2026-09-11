# Workflow Track Branches and Gates (`workflow/`)

## 1. Scope / Trigger

- Trigger: any change to the workflow YAML schema (`WorkflowDef`), the effective plan, or gate semantics.
- A track is a **branch inside the workflow YAML**, not a separate registry concept. Each branch is a
  complete pipeline written from scratch. `steps` and `tracks` are mutually exclusive: a workflow either has
  one pipeline (`steps`) or one pipeline per track (`tracks.<id>.steps`). The change's track selects the
  branch at plan time; a track without a branch is rejected, never given a fallback pipeline.

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
projectWorkflowNames(repoRoot): string[]          // default ∪ project dir ∪ global dir

// workflow/global-store.ts
globalWorkflowRoot(input?: ProductPathInput): string   // <configRoot>/workflows
workflowFileCandidates(repoRoot, name): string[]        // [project file, global file]
workflowNamesUnder(root): string[]

// tracks/branch-track.ts
resolveTrackForBranch(registry, id, workflowDef): TrackDefinition | undefined
```

## 3. Contracts

- YAML: either top-level `steps:` or `tracks:` (`<track-id>:` → optional `label:` and `steps:`, same step
  schema indented four more spaces). Declaring both → `有 tracks 时不得再声明顶层 steps`. Track ids match
  `TRACK_ID_RE`.
- `compileWorkflow` compiles every branch (`tracks.<id>.steps[i]` error paths) and keeps `tracks` on the IR.
  `planFromIr` selects `tracks[track.id]` and exposes it as `plan.workflow`; the full IR stays on
  `plan.definition`. No track given (fingerprint / document-policy / generator contexts) → the first branch;
  a track without a branch → `WorkflowTrackBranchError('工作流 X 没有轨道 Y 的分支')`, which init and the
  create-change route surface as exit 1 / 404. **The fingerprint hashes the full definition**, so it is identical for every track and
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
- `default.yaml`: `tracks.chat / pm / frontend / backend / free`, each with its own seven stages (`chat` is the
  drivers-only flow and comes first, so it is also the representative branch in track-less contexts; pm has no
  plan artifact, frontend adds e2e). `DEFAULT_ARTIFACT_DECLARATIONS` is keyed by track; `defaultArtifactsForStep(step,
  track)` reads that track's table (unknown track → no artifacts). `DEFAULT_WORKFLOW_STEPS` (todo labels) comes
  from the first branch. `check:default-skill-matrix` compares every branch's non-driver skills with
  `manifest.yaml`. Historical-fingerprint tests reconstruct the pre-branch default from the frontend branch
  (`legacyDefaultWorkflow()` in `workflow/test-support.ts`).

### Registry is policy-only; the branch decides usability

- `.pipeline/tracks.yaml` supplies **policy** for a track id (`reviewSeed`, `automationEligible`,
  `coverageProfile`, routing, skill profile). It does **not** decide which workflow a track may be used with.
  `track.workflow.allowed` is checked first by `assertWorkflowAllowed`, but the branch check that follows
  (`selectTrackBranch` / `planFromIr`) is the one that decides: a workflow declaring `tracks:` accepts only the
  branches it lists, whatever the registry says. A workflow with no `tracks:` node has no branch model and
  accepts any registered track.
- There is therefore **no track registration command**. `tenon tracks` is read-only (`list` / `show`);
  `create` / `update` / `delete` were removed because they could register a track that no `tracks:`-declaring
  workflow would ever accept — the registry said "allowed", `init` still failed with
  `工作流 X 没有轨道 Y 的分支`. To add a track, declare the branch in the workflow YAML.
- Hand-written `tracks.yaml` files still parse (builtin policy overrides keep working); a hand-written custom
  entry is likewise policy-only and gains no usability.
- Known gap: `POST /api/tracks`, `PATCH /api/tracks/:id` and `DELETE /api/tracks/:id` still expose registry
  writes over HTTP. No dashboard component calls them (`postTrackDefinition` / `patchTrackDefinition` /
  `deleteTrackDefinition` are unreferenced), so the same dead promise survives only on the server surface.

### Storage: workflows are global

- Workflows are user-level templates, not project files. The global store is
  `globalWorkflowRoot() = <resolveProductPaths().configRoot>/workflows`, laid out exactly like a project
  (`.pipeline/workflows/<name>.yaml`) so the server's trusted-fs layer anchors on it unchanged. `TENON_RUNTIME_HOME`
  / `TENON_RUNTIME_ROOTS` relocate it (tests, isolated installs); the root vitest config gives every worker a
  throwaway home (`tools/vitest.isolate-runtime-home.mjs`) so a developer's global overrides never leak into tests.
- `loadWorkflow(repoRoot, name)` resolution: built-in (`simple`) → project file `<root>/.pipeline/workflows/<name>.yaml`
  (legacy fallback, still wins when present) → global file → `null`. `default` follows the same chain; the built-in
  template applies when neither file exists. `projectWorkflowNames(repoRoot)` = `default` ∪ project dir ∪ global dir.
- A change picks its pipeline with `tenon init --workflow <name> --track <id>`; nothing about the change is stored
  in the workflow store.

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
- Bad: `init --track simple --workflow default` → rejected: default has no `simple` branch. `gate: confirm` → load error.

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
steps: [...]                       # a shared "base" pipeline the tracks inherit from
tracks:
  pm:
    steps: [...]
```

### Correct

```yaml
tracks:
  pm:
    label: 产品
    steps: [...]                   # every track writes its whole pipeline; nothing is preset
  frontend:
    label: 前端
    steps: [...]
```
