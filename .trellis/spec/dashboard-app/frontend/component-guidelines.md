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

- **Layout.** `ThreeColumns listWidth="narrow"` (middle 380px): the middle column is only the flow skeleton, the
  right column gets the space. Every top-level control lives next to the thing it acts on — there is no footer
  action list in the rail.
- **Rail.** `RailColumn headerAction` = one `+` (`wb-workflow-new`) that opens `NewWorkflowDialog` (copy / blank /
  import YAML). The selected workflow row carries inline actions: `+` (`wb-track-new-<wf>`, new track) and
  `MenuButton` (`wb-wf-menu-<wf>`: export YAML; delete workflow, or 恢复内建 for default — enabled only when a
  project override exists). Track rows (`wb-branch-<id>`, `label ?? id`) each have an inline `×`
  (`wb-track-delete-<id>`) that opens the confirm dialog. Rows of non-selected workflows show no actions:
  select first, then act in place. No branch tabs anywhere else — the rail is the only track switcher.
- **Stage flow (`PipelineList`).** Eyebrow = workflow name, title = track label. A node is the numbered circle on the
  spine (drag handle, `@dnd-kit/sortable`, `useFlipLayout` for the move) plus a card with **only the stage name and
  the gate pill** (`GateMark`: review = shield / amber, auto = bolt / accent). The spine segment below a gated
  stage carries the same mark as a small node (`wb-gate-node`), back edges are dashed pills under the card
  (`wb-back-edge-<from>-<to>`), the trailing `+` on the spine adds a stage. No skill chips in the middle column.
- **Stage pane (`StageEditorPane`).** Header = breadcrumb `wb-crumbs` (workflow › track › stage) and the stage name
  as an editable title input (`wb-lane-name-input-<id>`; the crumb `wb-lane-name-<id>` shows the same text), position
  `n / N`, delete icon with inline confirm. Body sections, in order: 技能 (`SkillWaveCards`: one row per wave, cards
  with `SkillSourceIcon` + mono name + registry `description`, `∥ 并行 · n` when a wave has ≥2; click → `SkillDetailDrawer`;
  编辑 → `SkillComposer`), two summary cards `wb-open-outputs` / `wb-open-inputs` (count + first slot names), 门禁
  (three radio cards `wb-lane-gate-<id>-none|review|auto`, each with `Info` `title` + sr-only help).
- **IO sheets are breadcrumb sheets, not drawers.** Clicking a summary card switches the pane's `view` to
  `outputs` / `inputs`: the breadcrumb grows by one crumb (`wb-crumb-sheet`), the stage crumb becomes a button that
  returns, the title becomes 输出 / 输入 with the count. `SlotList` rows (`slot-<kind>-<id>`) are **read-only**:
  name + lock, then `slot-skills-<id>` (producing skills as chips with source icon) and `slot-stages-<id>`
  (outputs: `→` stages that read it; inputs: `←` the producing stage). The YAML path is the row `title`.
  There is no add / remove / checkbox UI and no `addOutput` / `setInput` in `useWorkflowEditor`; field IO is
  edited in YAML (import / export).
- **Names.** Stages, tracks, skills, workflows render `label ?? id`. No `phases.*` / `documents.*` / `fields.*`
  translation of ids anywhere in `workflow/` or `workspace/`.
- **Composer.** Unchanged from 09-10: palette / `SkillCanvas` / `SkillDetail`; only `DragOverlay` moves; wave changes
  animate with `useFlipLayout`; only 保存 writes `steps[].skills` via `setSkillWaves`.
- Skill order is the **column model** (`workbench/skillWaves.ts`): a column is one execution wave, skills in the same
  column run in parallel, adjacent columns run serially. `wavesToSkills` writes `depends_on = all skills of the
  previous column`; `wavesOf` reads it back. `applyDrop` is the pure reducer — test it, not the drag.
- Save is blocked while `editor.lint` is non-empty or the page has no write credential (`getToken() === ''` → every
  write control disabled, footer shows `wb-no-token`; never fire a request that will 401).
- default is editable: saving writes the project override; the rail shows `内建 / 项目`; the menu action becomes
  `恢复内建` and is enabled only when an override exists. The server rejects overrides that break the seven-stage
  skeleton (`validateWorkflowForStorage`).

### How stage inputs / outputs are derived (and what is *not* detected)

`effectiveIo` (kernel `workflow/effective-io.ts`, mirrored for drafts by `workflow/lint.ts#draftEffectiveIo`) has
two sources and neither reads skill content:

1. **Document slots** come from the kernel's fixed document contract (`workflow/document-contract.ts`). It is a table
   keyed by **step id** (`open / explore / spec / build / verify / ship / archive`): which document kinds a step must
   produce, which skill names may record them (`producerCandidates`, plugin aliases included, e.g.
   `brainstorming` / `superpowers:brainstorming`), and which kinds each later step reads. The table applies to
   `default` and to `openspec_contract: required` workflows, and only to steps whose id matches one of the seven
   phase names. A stage named `explore` therefore lists `superpower-design` produced by `brainstorming` even on a
   branch whose explore stage does not contain `brainstorming`. `SlotList` shows `producerCandidates ∩ stage
   skills` (matched by bare name) and falls back to the bare candidate list when nothing matches.
2. **Field slots** are what the YAML declares by hand: `steps[].outputs` / `inputs` (`design_doc`, `plan`,
   `build_sha`, …). Producer = the nearest upstream stage that lists the field as an output; consumers = downstream
   stages listing it as an input. `artifacts[].producer_policy: effective-phase-skills` does not derive anything —
   it is a runtime check that whoever records the file is one of the stage's effective skills.

`SKILL.md` frontmatter carries only `name` and `description`; the registry has no machine-readable IO per skill, so
"the outputs of a skill / plugin" are not discoverable today. Deriving stage IO from skills would require a skill-side
declaration (frontmatter or a kernel table keyed by skill) and a kernel change — a separate task.

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
