# Snapshot `skillRuns` Projection (`skillRuns.ts`)

## 1. Scope / Trigger

- Trigger: `GET /api/snapshot` change assembly (`snapshot.ts`). Adds `ChangeSnapshot.skillRuns`.
- Purpose: tell the dashboard, per workflow step, which skills exist for this change's track, which
  execution wave they belong to, and whether each is idle / running / done.

## 2. Signatures

```ts
resolveSnapshotTrack(root: string, trackId: string): TrackDefinition | undefined
projectSkillRuns(changeDir: string, plan: EffectiveWorkflowPlan, phase: string, track: TrackDefinition | undefined, mandatorySkills?: SkillTable): Promise<SkillRunsSnapshot>

type SkillRunsSnapshot = ReadonlyArray<{ stepId: string; skills: ReadonlyArray<{ id: string; status: 'idle' | 'running' | 'done'; wave: number }> }>
```

## 3. Contracts

- Skill set per step = `capabilities.skills.steps[step].requiredSkillIds` ∪ overlay. Overlay when the plan
  embeds its matrix (`matrixEmbedded`) = `conditional[]` filtered by `skillAppliesToTrack(skill, track)`
  (track id or inherited profile). Overlay for a frozen plan without an embedded matrix
  (`manifest-overlay` policy) = `skillsFor(mandatorySkills, step, track.policyProfile.skills.profile)` — the
  same table the resolver used, injected by `server.ts` from the loaded manifest. No track definition →
  unconditional skills only. Custom tracks resolve through `loadTrackRegistry`; a registry error degrades
  to `undefined`, never fails the snapshot.
- Manifest tokens may be `a|b` alternatives; the token is shown as is and counts as done / running when
  any alternative has evidence.
- `wave` = topological depth over `declared[].dependsOn` (no dependency → 0). Conditional skills → 0.
- Status: step before the current phase → `done`; after → `idle`; current step → read
  `.pipeline-history.jsonl` after the last `transition` whose `to === phase`: `kind:'tool'` naming the
  skill → `done`; only `kind:'tool-start'` → `running`; nothing → `idle`. Each evidence token matches both
  verbatim (`opsx:propose`) and by the segment after its last `:` (`superpowers:brainstorming` → `brainstorming`).
- Older servers omit the field; the dashboard treats it as optional and hides the section.

## 4. Validation & Error Matrix

- Missing history file → treated as empty (all `idle`).
- Damaged JSONL line → skipped; other read errors propagate (same policy as `transitionHistory.ts`).
- Phase not in the plan → all steps `idle`.

## 5. Good / Base / Bad Cases

- Good: backend change at `open`; `tool-start Skill: openspec-propose` → running; `tool Skill: …` → done.
- Base: a `tool` line before the last transition back into the phase → ignored → idle.
- Bad: `handoff` listed for a backend change → wrong, it carries `when: track_in: [pm]`.

## 6. Tests Required

- `skillRuns.test.ts`: idle → running → done on the current step; earlier steps done / later idle; matrix
  skills filtered by track; manifest fallback for non-embedded plans with `a|b` alternatives; records before
  re-entering the step are ignored.

## 7. Wrong vs Correct

### Wrong

```ts
// Reading the manifest mandatory table for the track — the matrix lives in the workflow YAML now.
const skills = manifest.mandatory[track][phase]
```

### Correct

```ts
const track = resolveSnapshotTrack(readRoot, trackId)
const skillRuns = await projectSkillRuns(changeDir, plan, phase, track)
```
