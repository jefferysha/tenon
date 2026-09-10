# Component Guidelines

> How components are built in this project. Baseline: the workspace template (2026-09) — warm paper
> ground, deep-green accent, hairline borders instead of shadows, mono identifiers, three columns.
> Scope rule: the dashboard does two things — read a task's per-stage inputs / outputs, and edit
> workflow definitions. Do not add features because "the old version had them".

## Single source of truth: the workflow definition

Everything a page shows about "what a stage produces / reads / runs" comes from **one** definition
returned by `GET /api/workflows/:name?root=` (default included — the project override file
`.pipeline/workflows/default.yaml` wins over the built-in template; the response says `source`).
The server materializes each step's IO into `effectiveIo[stepId] = { inputs, outputs }` where a slot is
either `{ kind: 'document', id, producers, consumers, locked }` (governed document, ledger-backed) or
`{ kind: 'field', id, type, producer, consumers }` (change field). The frontend never keeps a copy of
the built-in default (`buildDefaultDef` was deleted) and never merges the document contract itself.

- Document slots are `locked` on `default` and `openspec_contract: required` copies; the editor shows
  a lock icon, never a sentence.
- Labels: document kinds → `t('documents.<kind>')`, fields → `t('fields.<field>')`
  (`workspace/taskModel.slotLabel`). Raw ids like `file_path` / `build_sha` never reach the screen.

## Three-column page contract (`shell/ThreeColumns.tsx`)

Every top-level view renders exactly `ThreeColumns` with `rail` (RailColumn + RailCard[]), `list`
(ListColumn) and `detail` (DetailColumn | DetailEmpty). Widths live in the primitive; views never pass
widths. State is carried by `aria-current` / `aria-selected` / `aria-pressed` / `data-*`; tests assert
those, never class names.

### Right column

`DetailColumn` = fixed header (eyebrow / H1 / mono slug / one `StatusPill`) + vertically stacked
sections with **noun headers only** + optional footer. No tab groups: the 2026-09 redesign removed the
last one. Anything that needs its own surface opens the shared right-side `shared/Drawer.tsx`
(portal, 560px, Esc, focus capture / restore, `aria-modal`).

### Wording rules (R4.3 of the 09-10 task)

- One word per concept, everywhere: 阶段 / 技能 / 输入 / 输出 / 门禁 / 轨道 / 工作流. No `step`, `lane`,
  产出物, 登记者, 来自上游, 推导 in the dictionary.
- No sentences on the page except error text. Section titles are nouns; empty states are one noun
  phrase plus at most one action.
- No dictionary keys named `*_note`, `*_desc`, `*_lead`, `*_hint` in `workspace` / `workflow`.

## 工作台 rules (`workspace/`)

- Read-only. Network: snapshot, `GET /api/workflows/:name` (only when a project is selected — the
  aggregate view must not issue per-root requests; it falls back to `fallbackStepIo` from
  `change.workflowRules.outputsByStep`), `GET /api/documents/read`.
- Task status is derived, never named abstractly (`taskModel.summaryOf`): archived → first unready
  output of the current stage (`缺 <slot>`) → review handshake pending (`评审待确认`) → any forward
  transition ready (`可进入<stage>`) → `进行中`. Facets: workflow → track → stage; the stage row appears only
  when one workflow **and** one track are effective, because each track branch has its own stages.
- Stage IO comes from `def.branches[change.track]?.effectiveIo ?? def.branches._base?.effectiveIo`.
- `MiniPipeline` / `StageRail` colour segments with `bg-seg-done` / `bg-seg-now` / `bg-seg-next` only.
- `StageIoPanel` rows: document slot → ledger status (`recorded/missing/stale/unread`) + file name +
  last producer + time; field slot → `set/unset`. A row with a path opens `DocumentDrawer`
  (`react-markdown` + `remark-gfm` for `.md`, `<pre>` otherwise; prev / next across the stage's files).
- `StageSkills` sits above the IO panel and renders `change.skillRuns[step]`: one column per wave
  (same column = parallel), one `StatusPill` per skill (`idle` neutral / `running` info / `done` done).
  It renders nothing when the server omits `skillRuns` or the step has no skills — no placeholder text.

## 工作流 rules (`workflow/`)

- **Branches.** The rail shows the current workflow expanded into `通用` (base, id `''`) plus one row per
  `tracks.<id>` (`label ?? id`). `useWorkflowEditor` keeps `fullDef` and a `branch`; every read path uses
  `def = selectBranchDef(fullDef, branch)` and every mutation goes through `writeBranchDef`. `addTrack` copies the
  base steps; `removeTrack` drops the branch. Save is blocked when any branch has a lint issue (`lintBlocked`).
- **Names.** Stages, tracks, skills, workflows render `label ?? id`. No `phases.*` / `documents.*` / `fields.*`
  translation of ids anywhere in `workflow/` or `workspace/`.
- **Skills.** The stage pane shows a read-only `SkillWavesView` and an 编辑 button that opens `SkillComposer`
  (full-screen `Dialog`): left = `/api/skills/registry` palette (search, source badge, expandable origin +
  description, eye → `Drawer` with the SKILL.md `Markdown` from `/api/skills/:name/readme`), right =
  `SkillCanvas` (drop on a column = parallel, on a gap = new wave, back on the palette = remove) with a
  `DragOverlay`. Only 保存 writes `steps[].skills` via `setSkillWaves`.
- **IO.** Two entry rows (输出 / 输入 + count) open `Drawer` sheets that host `OutputsSection` / `InputsSection`
  with a `provenance` line per slot: producing skills or `来自 <stage> · <skills>` plus the YAML path
  (`tracks.<id>.steps[<step>].outputs[<field>]`, `document_contract.slots[<kind>]`).
- **Gates.** Radio `无 / 评审 / 自动`; each option carries an `Info` icon with `title` + sr-only text from
  `workflow.gate_help_*`. `confirm` no longer exists in the type.


- Middle column is a pipeline (`PipelineList`): numbered nodes on a vertical connector, solid when the
  next stage is a direct forward edge, dashed otherwise; back edges render under the node as
  `回到<stage>`; a stage without outputs gets the `缺输出` badge from `lint.ts`.
- Skill order is the **column model** (`workbench/skillWaves.ts`): a column is one execution wave,
  skills in the same column run in parallel, adjacent columns run serially. `wavesToSkills` writes
  `depends_on = all skills of the previous column`; `wavesOf` reads it back. `SkillDag` is the only UI
  for it: dnd-kit Pointer + Keyboard sensors; drop targets `wave:<k>` (join column), `gap:<k>`
  (insert new column before k), `palette` (remove). `applyDrop` is the pure reducer — test it, not
  the drag.
- **One skill system.** Track-specific skills are not a separate list: a skill node carries an
  optional track condition (`WbSkillRef.when = { kind: 'track-in' | 'track-not-in', values }`;
  none = every track). The node shows a track badge (`skill-tracks-<id>`); clicking it opens a chip
  picker (`skill-track-<id>-<track>`) that writes `when` through `editor.setSkillWhen`. The chips above
  the canvas (`dag-track-all` / `dag-track-<track>`) only filter the view; editing is enabled in the
  "all tracks" view. The manifest matrix (`/api/config`) is read-only data for track names — never
  write `mandatory-skills` from the dashboard again.
- Outputs / inputs (`IoSections`): slots from `editor.effectiveIo` (draft recomputed by
  `lint.draftEffectiveIo`); add from `slotCatalog.availableOutputSlots`; inputs are a checklist of
  `upstreamOutputs`. Locked document slots are shown with a lock and cannot be removed / unchecked.
- Gate is a three-way radio group (`wb-lane-gate-<id>-none|review|confirm`).
- Save is blocked while `editor.lint` is non-empty or the page has no write credential
  (`getToken() === ''` → every write control disabled, footer shows `wb-no-token`; never fire a request
  that will 401).
- default is editable: saving writes the project override; the rail shows `内建 / 项目`; the delete
  action becomes `恢复内建` and is enabled only when an override exists. The server rejects overrides
  that break the seven-stage skeleton (`validateWorkflowForStorage`).
- New workflow = one dialog with three modes (copy current / blank / import YAML). Import goes through
  `PUT /api/workflows/:name/yaml`; export through `GET …/yaml` (download + clipboard).

## Styling patterns

- Tokens only (`text-text-2`, `bg-accent-t`, `border-border`, `bg-seg-now` …); no hex in components.
- Type scale 7 steps, radius 4 steps, 4px spacing grid; `tools/check-design-scale.mjs` blocks arbitrary
  values.
- Cards separate by border and ground colour; shadows only on floating layers (drawer, dialogs, drag
  overlay).

## Accessibility

- Dialogs and the drawer keep accessible title, `aria-modal`, Escape, focus capture / restore.
- Chips are `role=tab` inside a `role=tablist`; the gate switch is `role=radiogroup`.
- Status is text + tone, never colour alone; `/` focuses global search.

## Common mistakes

- **Reading IO from `WbStepDef.inputs/outputs` directly** in a page component: that skips document
  slots. Always go through `effectiveIo` (server) or `draftEffectiveIo` (editor draft).
- **Posting `source` / `effectiveIo` back**: the server's closed decoder rejects unknown keys;
  `postWorkflowDef` / `definitionForWrite` strip them — keep it that way.
- **Per-root fetch in the aggregate view** (`currentRoot === ''`): forbidden; tests assert the only
  request is `/api/snapshot`.
- **Rendering `Error.message` or a field named `message`** in TSX trips the i18n leak gate; format
  through `formatApiError` and store it under `detail`.
- **Dropping `when` in a skill transform**: every function that rebuilds `skills[]` must spread the
  existing ref (`wavesToSkills` does); losing `when` silently widens a skill to all tracks.
- **Adding explanatory copy**: if a label needs a sentence to be understood, the component is wrong,
  not the copy.
