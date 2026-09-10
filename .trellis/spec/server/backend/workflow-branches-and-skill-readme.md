# Workflow GET `branches` and `GET /api/skills/:name/readme`

## 1. Scope / Trigger

- Trigger: the dashboard needs per-branch effective IO for a workflow and the SKILL.md text of a local skill.

## 2. Signatures

```ts
// workflows.ts
workflowBranchesForApi(def: WorkflowDef): Record<'_base' | TrackId, { label?: string; effectiveIo: WorkflowEffectiveIo }>

// skillsRegistry.ts
readSkillReadme(name, repoRoot, claudeDir): { name; source: SkillSource; origin: string; path: string; markdown: string } | undefined

// snapshot.ts / changeSnapshot.ts
resolveSnapshotEffectivePlan(root, name, binding, loadDefinition?, track?: TrackDefinition)
resolveSnapshotTrack(root, trackId, workflowName?): TrackDefinition | undefined
```

## 3. Contracts

- `GET /api/workflows/:name` response = definition (with `tracks`) + `source` + `effectiveIo` (base) +
  `branches` (`_base` plus one entry per track, each with its own `effectiveIo` materialised from
  `selectTrackBranch`). `branches`, `effectiveIo`, `source` are read-only projections; the POST decoder still
  rejects them, so clients strip them before writing (the dashboard client does).
- `GET /api/skills/:name/readme`: name must match `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$` (400 otherwise). Search
  order = repo `skills/` (`local-plugin`, origin `tenon`) → `~/.claude/skills`, `~/.agents/skills` (`user`) →
  installed Claude plugin roots and the Codex plugin cache (`external-marketplace`, origin = plugin dir or
  `marketplace/plugin@version`). First existing `SKILL.md` wins; none → 404. Read-only, loopback GET, no token.
- Snapshot plans resolve with the change's track (`resolveSnapshotTrack`, which falls back to a workflow branch
  when the registry does not know the id) so a legacy change without a frozen snapshot still gets its branch.

## 4. Validation & Error Matrix

- Invalid skill name → 400; missing SKILL.md → 404; filesystem error → 500 with `errMsg`.
- Branch materialisation never throws for a valid definition; an invalid one already failed `readWorkflowForApi`.

## 5. Good / Base / Bad Cases

- Good: `GET /api/workflows/default` → `branches` keys `_base, pm, frontend, backend, free`.
- Base: custom workflow without tracks → `branches` = `{ _base }` only.
- Bad: `GET /api/skills/../etc/readme` → 400.

## 6. Tests Required

- `server.test.ts`: default GET exposes the five branch keys; custom GET exposes `_base`; readme 200 / 404 / 400.

## 7. Wrong vs Correct

### Wrong

```ts
// Reading skill descriptions from the registry entry and calling that the skill's documentation.
```

### Correct

```ts
const readme = readSkillReadme(name, repoRootForSkills(), join(hostHome, '.claude'))  // full SKILL.md + origin
```
