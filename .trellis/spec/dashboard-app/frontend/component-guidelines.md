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

Every top-level view except 工作流 renders exactly `ThreeColumns` with `rail` (RailColumn + RailCard[]), `list`
(ListColumn) and `detail` (DetailColumn | DetailEmpty); 工作流 renders `TwoColumns` (nav + detail). Widths live in the primitive; views never pass
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

- **Layout.** The workflow page is the one view that does **not** use `ThreeColumns`: it renders `TwoColumns`
  (`shell/ThreeColumns.tsx`, nav 300px + detail). There is no middle column and no rail collapse.
- **Nav column (`WorkflowNav`).** Top: the workflow name is the title and a `listbox` switcher (`wb-wf-switch` →
  `wb-wf-item-<name>`), the line under it is `<source> · <n> 轨道`, and one `MenuButton` (`wb-wf-menu`) holds every
  workflow-level action: 新建工作流 (`NewWorkflowDialog`, copy / blank / import), 导出 YAML, 删除工作流 or 恢复内建
  (enabled only when a project override exists), 删除轨道 <label> (only when a track is selected). Tracks are an
  underline `tablist` (`wb-track-<id>`, `label ?? id`) with a trailing `+` (`wb-track-new`); a workflow without
  tracks shows a single `+ 新建轨道` link instead. Below: the stage flow — numbered circle (drag handle,
  `@dnd-kit/sortable`, `useFlipLayout`) + a 40px block (`wb-step-<id>`) that contains **only the stage name and the
  gate icon** (`wb-gate-<id>`: review = shield, auto = bolt; no text). A stage without outputs shows an amber dot
  (`wb-lint-<id>`). Rows are on a fixed pitch (`STEP_PITCH` 54 / `STEP_HEIGHT` 40) so back edges are drawn from
  indices, not measured DOM: `backEdgePath(fromIndex, toIndex)` → dashed arc in a 22px SVG gutter right of the blocks
  (`wb-back-edge-<from>-<to>`). Last row: `wb-add-stage`. No skill chips, no cards, no canvas here.
- **Stage pane (`StageEditorPane`).** Breadcrumb `wb-crumbs` (workflow › track), then the stage name as an editable
  title input (`wb-lane-name-input-<id>`; `wb-lane-name-<id>` is an sr-only copy so existing tests and readers keep
  the text), position `n / N`, delete with inline confirm. Sections are full-width with a one-line head
  (`SectionHead`: title, mono count, right-aligned action) in **data-flow order: 输入 → 技能 → 输出 → 门禁**.
- **IO tables (`IoTable`).** Both tables are the same three equal columns so they align vertically: 文件 · 来源阶段 ·
  来源技能 (wording is 来源, never 产出). Inputs: 来源阶段 = the producing upstream stage; outputs: 来源阶段 = this stage.
  Every row has the same file icon — slots are files, the kind (document / field) is not shown. Source skills are a
  comma list; empty → `—`. Derivation: output document → contract `producerCandidates` ∩ this stage's skills
  (bare-name match, `producerSkills`); output field → all stage skills; input → producing stage label plus that
  stage's matching skills. **Never show a skill that is not in the stage** — an empty cell is the
  honest answer (see the IO section below). No 读取阶段 column: each stage lists what it reads in its own inputs. No
  add / remove / checkbox UI; `useWorkflowEditor` has no IO mutators.
- **Skill flow (`SkillFlow`, `@xyflow/react`).** Nodes = skills (`flow-node-<id>`: source icon + mono name + registry
  description, left target / right source handles), edges = `depends_on` (`edgesOf`), columns = waves
  (`layoutSkills`: x by depth, y by index in wave). Serial / parallel must be visible even when no `depends_on`
  exists: the canvas adds virtual 起点 / 终点 port nodes (`flow-start` / `flow-end`) with edges start → first wave and
  last-in-chain → end, a wave label above each column (`flow-wave-label`: 第 n 步 · 并行 k when k > 1), arrowheads
  (`MarkerType.ArrowClosed`) and animated dashes on every edge. Virtual nodes / edges are derived in render, never
  stored; `data-nodes` / `data-edges` count skills and `depends_on` edges only. Effects key on
  `skillsSignature(skills)` (ids + sorted depends_on), not on array identity, and `onChange` fires only when the
  graph's signature differs from the prop — this is what stops the reopen-after-delete render loop.
  Adding a skill is semantic, not positional: `dropTargetFor(x, columnXs)` maps the pointer to `join` (a column →
  parallel: depends on the previous wave, the next wave depends on it), `after` (right of the last column → serial
  new step depending on the whole last wave) or `before` (left of the first column → new first step); `addSkillAt`
  rewrites `depends_on` accordingly and the graph is re-laid out. The palette `+` is `appendSerial`. While dragging,
  a dashed `flow-ghost` node with the pending mode (并行 n / 串行) and preview edges shows where it will land
  (`dragLabel` comes from the composer because `dataTransfer` is unreadable during dragover); the new node plays
  `flow-in` (`data-entering`), disabled under reduced motion. Ports are solid dots with a caption (起点 accent,
  终点 grey); port edges are static, only `depends_on` edges animate. Read-only in the pane (`editable=false`: no drag / connect /
  pan; click → `SkillDetailDrawer`). Editable inside `SkillComposer`: palette items are HTML5-draggable
  (`dataTransfer 'text/skill'`) and have a `+` (`palette-add-<name>`); `onConnect` refuses cycles (`wouldCycle`);
  `×` on a node (`flow-remove-<id>`) removes it and its edges; Backspace deletes a selected edge. The graph is written
  back as `graphToSkills(nodeIds, edges, existing)` → `depends_on` = incoming edge sources, other fields preserved,
  order = waves flattened with the definition's original order inside a wave. 保存 calls `editor.setSkills(stepId,
  skills)`. Node positions are not persisted (YAML has none); they are re-laid out from waves on open.
- **Skill detail.** `SkillDetail` renders `.md` with `Markdown density="compact"` (h1 20 / h2 16 / h3 14, body 13/24,
  bordered h2, tight lists) because it lives in a narrow column; the default density stays for full-width documents.
  The file tree lists every file under the skill directory — first-party `tenon-*` skills really contain only
  `SKILL.md`, so a one-file tree is correct, not a filter.
- **Tests.** jsdom cannot render React Flow: `test-setup.ts` mocks `@xyflow/react` with
  `workflow/reactFlowTestDouble.tsx`, which renders each node through `nodeTypes` (so node buttons and testids are
  real) and exposes edge ids on `data-edges`. Connection / drag behaviour is React Flow's and is not tested here;
  the pure functions are.
- **Gates.** Three radio cards `wb-lane-gate-<id>-none|review|auto` with icons; each carries `title` + sr-only help
  from `workflow.gate_help_*`.
- **Names.** Stages, tracks, skills, workflows render `label ?? id`; no id translation anywhere.
- Save is blocked while `editor.lint` is non-empty or the page has no write credential (`getToken() === ''` → every
  write control disabled, footer shows `wb-no-token`).
- default is editable: saving writes the project override; the nav meta shows `内建 / 项目`; the menu action becomes
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
- Type scale 7 steps (micro 13 / caption 14 / body 16 / base 17 / title 19 / section 24 / page 34 — scaled ×1.2
  on 2026-09-11 at the user's request), radius 4 steps, 4px spacing grid; `tools/check-design-scale.mjs` blocks
  arbitrary values. Narrow columns must keep labels on one line (`whitespace-nowrap` + `overflow-x-auto`) at this size.
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
