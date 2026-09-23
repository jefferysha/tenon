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
either `{ kind: 'document', id, role, scope, producers, consumers }` (governed document, ledger-backed) or
`{ kind: 'field', id, type, producer, consumers }` (change field). The frontend never keeps a copy of
the built-in default (`buildDefaultDef` was deleted) and never merges the document contract itself.

- Document slots carry no `locked` flag. Document IO is editable wherever the workflow declares a
  `document_contract`: `+ 输出` adds a slot (its `role` derived from whether an earlier step already produces the
  kind), `+ 输入` is a checklist over upstream document outputs and project documents, and `×` removes a row.
  Field IO stays YAML-derived and read-only.
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

- Writes are limited to the three task-lifecycle actions: 归档 / 取消归档 / 删除 (plus the existing 接手 and
  review acknowledgement). Everything else is read-only, and all three need a selected project: the
  aggregate view issues only `/api/snapshot` and therefore renders no action menu at all.
- Network: snapshot, `GET /api/workflows/:name` (only when a project is selected — the aggregate view must
  not issue per-root requests; it falls back to `fallbackStepIo` from `change.workflowRules.outputsByStep`),
  `GET /api/documents/read`, `GET /api/change/:name/lifecycle`, `POST …/archive`, `POST …/unarchive`,
  `DELETE /api/change/:name`.
- 归档 hides a task for the acting user only; 完结 / 已完结 is the workflow's last step. Never mix the words:
  the toggle reads 含已完结 (`includeCompleted`, summary kind `completed`), the view reads 已归档.
- `TaskActionDialog` shows only reasons the server returned, disables 确认 while a blocker is present, and
  echoes back exactly the codes it displayed. A 409 replaces the list with the reasons the server re-checked
  under the lock; the dialog never computes a reason itself.
- The card's 归档 / 删除 menu is a **sibling** of the card button, never nested inside it (no interactive
  element inside another). The 已归档 view drops every facet and the action menu: search plus 取消归档 only.
- Task status is derived, never named abstractly (`taskModel.summaryOf`): completed → first unready
  output of the current stage (`缺 <slot>`) → review handshake pending (`评审待确认`) → any forward
  transition ready (`可进入<stage>`) → `进行中`. Facets: workflow → track → stage; the stage row appears only
  when one workflow **and** one track are effective, because each track branch has its own stages.
- Stage IO comes from `def.branches[change.track]?.effectiveIo ?? def.branches._base?.effectiveIo`.
- `MiniPipeline` / `StageRail` colour segments with `bg-seg-done` / `bg-seg-now` / `bg-seg-next` only.
- `taskModel.stagesOf` maps a snapshot `current` segment to `done` when `change.archived === 'true'`: archiving
  leaves the phase on the last visited step, and the rail must not show a finished task as still running there.
  Stages the run never entered stay `todo` (test: `taskModel.test.tsx`
  「已完结的运行没有进行中的阶段：收尾阶段算完成，从未进入的阶段仍是 todo」).
- `StageIoPanel` rows: document slot → ledger status (`recorded/missing/stale/unread`) + file name +
  last producer + time; field slot → `set/unset`. A row with a path opens `DocumentDrawer`
  (`react-markdown` + `remark-gfm` for `.md`, `<pre>` otherwise; prev / next across the stage's files).
- The stage's skills render with the same `SkillFlow` canvas as the workflow page (read-only, `registry=null`):
  `skillsFromRuns(change.skillRuns[step])` rebuilds the column model (wave k depends on wave k-1) and `statusOf`
  colours each node (`data-status`: idle grey / running info ring / done green) with the run label under the name.
  Nothing renders when the server omits `skillRuns` or the step has no skills.
- The stage's agents render right after the skills canvas (`StageAgentsPanel`, `stage-agents`): the same
  read-only `SkillFlow`, reviewers depending on the executors so the canvas draws the run order rather than
  the literal `depends_on`. Node caption = 执行者 / 评审者; node status = 未运行 / 进行中 / 通过 · 不通过 ·
  完成 · 失败, with 过期 shown as idle and `· 问题 n` appended when the run reported findings. A step that
  declares no agent renders nothing. Clicking a node opens `AgentRunDrawer`: one line of 身份 · 结论 ·
  问题 n · 操作人 · 时间 and the report the agent wrote, read through `GET /api/documents/read`.
- Inputs, outputs and tests are **sheets**, not stacked sections: `SheetTabs` (`task-io-tab-inputs` /
  `task-io-tab-outputs` / `task-io-tab-tests`, counts in the tab) above one panel that shows the active sheet
  only; a file row still opens `DocumentDrawer`. The 测试 tab appears only when the selected step declares
  tests, its count is `通过/总数`, and a row opens `TestRunDrawer` (inputs, outputs, log tail, screenshots,
  history). Status words are one word each — 通过 / 失败 / 过期 / 未运行 / 运行中 — and never a sentence. The project rail card shows the project path only — task counts live in the facet chips, never
  twice. Chips and card pills never wrap internally (`whitespace-nowrap`, truncated titles), but facet rows **do**
  wrap (`flex-wrap`): a horizontally scrolling row clipped chips mid-word at 1440px (「验…」「未提交删除」).
  `ListColumn` header blocks (eyebrow, title, search, chips) are `shrink-0`, so a long list scrolls the column instead
  of squashing the search box.

## 工作流 rules (`workflow/`)

- **Global, not per project.** Workflows are user-level templates: `WorkflowView` is rendered with `root=""` regardless
  of the selected project, every `/api/workflows*` call goes out with an empty `root`, and there is no project gate,
  no per-root draft retention and no root-loss handling on this page. The unsaved-draft guard fires only when the
  user leaves the 工作流 view. `WbWorkflowSource` is `builtin | global | project` (project = legacy file, read-only
  from the dashboard's point of view); the nav shows 内建 / 全局.
- **Layout.** The workflow page is the one view that does **not** use `ThreeColumns`: it renders `TwoColumns`
  (`shell/ThreeColumns.tsx`, nav 300px + detail, `grid-rows-[minmax(0,1fr)]`). There is no middle column and no rail
  collapse. Every column scroll container is `relative overflow-y-auto`: absolutely positioned descendants
  (`sr-only` help text, handles) must take the scroll container as containing block, otherwise they escape the clip
  and give the whole document a scrollbar.
- **No global search.** The top bar has no search box and there is no shared query context; each view filters with
  its own input (`TaskListPane` search). `shell/GlobalSearch.tsx` only exports `matchesQuery`.
- **Nav column (`WorkflowNav`).** Top: the workflow name is the title and a `listbox` switcher (`wb-wf-switch` →
  `wb-wf-item-<name>`), the line under it is `<source> · <n> 轨道`, and one `MenuButton` (`wb-wf-menu`) holds every
  workflow-level action: 新建工作流 (`NewWorkflowDialog`, copy / blank / import), 导出 YAML, 删除工作流 or 恢复内建
  (enabled only when a project override exists), 删除轨道 <label> (only when a track is selected). Tracks are an
  underline `tablist` (`wb-track-<id>`, `label ?? id`) with a trailing `+` (`wb-track-new`); a workflow without
  tracks shows a single `+ 新建轨道` link instead. Below: the stage flow — numbered circle (drag handle,
  `@dnd-kit/sortable`, `useFlipLayout`) + a 40px block (`wb-step-<id>`) that contains **only the stage name and the
  gate icon** (`wb-gate-<id>`: review = shield, auto = bolt; no text). In an OpenSpec workflow a stage without outputs
  shows an amber dot (`wb-lint-<id>`); without OpenSpec no output can be added from the page, so `step-no-output` is
  not reported there. Rows are on a fixed pitch (`STEP_PITCH` 54 / `STEP_HEIGHT` 40) so back edges are drawn from
  indices, not measured DOM: `backEdgePath(fromIndex, toIndex)` → dashed arc in a 22px SVG gutter right of the blocks
  (`wb-back-edge-<from>-<to>`). Last row: `wb-add-stage`. No skill chips, no cards, no canvas here.
- **Stage pane (`StageEditorPane`).** Breadcrumb `wb-crumbs` (workflow › track), then the stage name as an editable
  title input (`wb-lane-name-input-<id>`; `wb-lane-name-<id>` is an sr-only copy so existing tests and readers keep
  the text), position `n / N`, delete with inline confirm. Sections are full-width with a one-line head
  (`SectionHead`: title, mono count, right-aligned action) in **data-flow order: 输入 → 技能 → 输出 → 测试 → 门禁**.
  测试 lists the step's declared tests (名称 · 方向 · 命令 · 必需); `+` copies a test direction into the step and
  a row opens `TestEditorDrawer`, which writes back to the draft only on 应用.
  Document lint issues render once under 输出 (`stage-document-lint`): structural contract problems mirroring the
  kernel are errors that block saving; chain gaps and stages without outputs are warnings that do not.
- **IO tables (`IoTable`).** Both tables are the same three equal columns so they align vertically: 文件 · 来源阶段 ·
  来源技能 (wording is 来源, never 产出). Inputs: 来源阶段 = the producing upstream stage; outputs: 来源阶段 = this stage.
  Every row has the same file icon — slots are files, the kind (document / field) is not shown. Source skills are a
  comma list; empty → `—`. Derivation: output document → contract `producerCandidates` ∩ this stage's skills
  (bare-name match, `producerSkills`); output field → all stage skills; input → producing stage label plus that
  stage's matching skills. **Never show a skill that is not in the stage** — an empty cell is the
  honest answer (see the IO section below). No 读取阶段 column: each stage lists what it reads in its own inputs.
  Document rows are editable through `useWorkflowEditor`'s contract mutators (`workbench/documentContractEdits.ts`);
  field rows are not.
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
  终点 grey); port edges are static, only `depends_on` edges animate.
  **Pulse.** Every edge is the custom `pulse` type (set explicitly on each decorated edge — `defaultEdgeOptions`
  only applies to edges created by `onConnect`): `BaseEdge` plus an accent overlay path whose dash pattern shows one segment
  (`stroke-dasharray = segment + length`); GSAP tweens `stroke-dashoffset` from `length + segment` to `-segment`, so a
  highlighted stretch of the line itself flows from source to target — no travelling dot (rejected as choppy), no
  CSS `offset-path` (inert on SVG). Edges carry `data.order / total` (起点→首波 0, 波 k→汇合 2k+1, 汇合→波 k+1 2k+2, 末波→终点
  2N-1) so one shared timeline sends the pulse from 起点 to 终点 and repeats; reduced motion disables it. React
  Flow's CSS `animated` dashes are not used. Virtual nodes (ports, labels, junctions, ghost) are not in the nodes
  state, so their `dimensions` changes are captured into `virtualMeasured` and written back as `measured` — otherwise
  React Flow treats them as unmeasured, hides the edges attached to them and re-reports sizes every frame.
  **Routing.** `layoutSkills` centres every wave on one midline (the tallest wave sets the height), and port /
  junction y is computed from React Flow's measured node heights (fallback `NODE_HEIGHT`), so single-node links are
  straight. When two adjacent waves form a complete column link (`isColumnLink`: every next-wave node depends on
  exactly the whole previous wave and the previous wave has no other successors) the direct edges are hidden and
  replaced by an invisible junction node `j<k>` on the midline: previous wave → junction (no arrow) → each next-wave
  node (arrow). Non-column DAGs keep their direct edges. Nodes are 260px wide; the name is caption-size mono,
  truncated with the full name on `title` — long skill ids never overflow the box. `fitView` runs ~60ms after a relayout so measured sizes are in. Read-only in the pane (`editable=false`: no drag / connect /
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
- default is editable: saving writes the override into the **global** store; the nav meta shows `内建 / 全局 / 项目`;
  the menu action becomes `恢复内建` and is enabled whenever the source is not `builtin` (global **or** legacy project
  override) — gating it on `project` alone left a globally overridden default unrestorable. The server rejects
  overrides that break the seven-stage skeleton (`validateWorkflowForStorage`).
- `copyWorkflowDef` keeps `openspec: true` and each branch's `document_contract`, but **prunes every slot and
  read down to the skills the copied stages actually declare**. default's contract names producers its own `chat`
  branch deliberately does not contain (drivers only), so copying it verbatim asserted something the copy cannot
  meet and made every 复制 default 400 with `tracks.chat: … 要求 'open' 声明 OpenSpec proposal skill`. Pruning is
  what keeps a copy valid under the same kernel validation the original passes. The copy still rewrites
  `producerPolicy` from `effective-phase-skills` (default-only) to `effective-step-skills`.
- The OpenSpec switch itself is `wb-wf-menu-openspec` in the workflow menu. Turning it off deletes the top-level
  and every branch `document_contract` with it; it is disabled for `default`, which must stay governed.
- `decodeWorkflowIndex` must accept every `WbWorkflowSource`. It once narrowed `defaultSource` to `builtin | project`,
  so a `source: "global"` index response failed shape validation: `useWorkflowEditor` fell into its catch branch and
  the whole page came up with no workflow names and an empty stage rail. Any new source value has to be added in
  `governanceTypes.ts` **and** in this decoder.
- Restoring built-in re-fetches the definition explicitly (`reloadNonce`). `switchTo('default')` alone is a no-op when
  the current workflow is already `default`, so the cleared `defState` would never be refilled and the stage rail
  would stay empty.

### Send-back section (退回)

- The right pane is five sections: 输入 → 技能 → 输出 → 门禁 → **退回**.
- **Forward destinations are never configurable.** Every forward edge in `default` points at the immediately
  following stage, in all five tracks, with no skips — so the forward chain is fully determined by stage order,
  which the user already sets by dragging. Exposing a per-stage 去向 asked them to configure the same thing twice
  and let them author "skip two stages ahead", which the pipeline has no notion of. An earlier revision shipped an
  editable 事件 · 去向 table and was wrong for exactly this reason.
- What *is* configurable is one stage-level property: **does this stage send work back, and how far back**. One
  `<select>`: `不退回` or `退回到「<stage>」`. Options list only stages *before* this one, so a forward jump cannot
  be expressed. The first stage has no earlier stage, so the section renders no `<select>`; it appears there only
  to show a `transition-not-next-or-back` lint message for an imported or hand-edited edge.
- Reordering and removing stages relink edges through one helper (`relinkTransitions`): the edge to the next
  stage keeps its event/guards/actions and follows the new order, a step without one gets `<id>-complete`, and
  any other edge survives only while its target is still earlier. An old send-back can therefore never turn into
  a second forward edge. A send-back dropped this way goes into the same `不退回` memory
  (`displacedBackTransitions`), so dragging a stage away and back and re-picking the target restores
  `verify-fail` with its guards/actions instead of a synthesized `verify-back`. `transition-not-next-or-back` blocks saving any edge that is neither the single edge to
  the next stage nor a send-back (skip, self, missing target, or a second edge to the next stage); `default`
  produces no such issue.
- Send-back is **not** bound to the gate. `实现 → 规格` (`requirements-changed`) hangs off a stage whose gate is
  `无`; its meaning is "requirements changed, go re-do the spec", not "acceptance failed". Gating the control on
  the gate would make that edge inexpressible.
- The nav's dashed arc is this setting rendered: pick a target and the arc appears, pick 不退回 and it goes.
  Configuration and drawing are two views of one fact, not two stores.
- A send-back **is** a transition whose `to` is an earlier stage. `setStageBackInDef` keeps the existing
  `event` / `guards` / `actions` when the target changes, and `useWorkflowEditor` remembers the transition that
  `不退回` removed (keyed by workflow + branch + step) so toggling back restores it whole. Without that memory,
  one round trip silently downgraded `verify-fail` to a synthesized `verify-back` and dropped
  `mark-verification-failed` — and event names carry meaning (`document-record-policy` keys the ADR
  living-document path on `requirements-changed`). A genuinely new edge gets `<stepId>-back`.
- For governed workflows the kernel merges the canonical guards/actions back in by (from, to) pair
  (`governedLifecyclePolicy`), so a governed send-back cannot lose its lifecycle effects even if the YAML omits
  them. The required pairs (`build → spec`, `verify → build`) are still un-removable, enforced by the
  `transition-contract-required` lint before save rather than by a 400 from the server.
- Known sharp edge: the pane needs ~680px of scrolling on a 900px-tall window for a stage with many inputs, so
  门禁 and 退回 sit below the fold. This predates the section (门禁 was already off-screen) and is a property of
  putting two large derived read-only tables above the small editable controls. Not addressed here.

### How stage inputs / outputs are derived (and what is *not* detected)

`effectiveIo` (kernel `workflow/effective-io.ts`, mirrored for drafts by `workflow/lint.ts#draftEffectiveIo`) has
two sources and neither reads skill content:

1. **Document slots** come from the workflow's own `document_contract` (kernel `workflow/document-contract.ts`),
   written beside the steps it references — per branch under `tracks.<id>` when the workflow has tracks. Each slot
   names the kind, its `owner_step`, its allowed producers (plugin aliases included, e.g. `brainstorming` /
   `superpowers:brainstorming`) and a `role` (`produce | update | require`); `reads` say which kinds each later
   step consumes. Nothing is keyed by phase name any more: a stage named `explore` lists `superpower-design` only
   if that branch's contract says so. `SlotList` shows `producers ∩ stage skills` (matched by bare name) and falls
   back to the bare producer list when nothing matches.
2. **Field slots** are what the YAML declares by hand: `steps[].outputs` / `inputs` (`design_doc`, `plan`,
   `build_sha`, …). Producer = the nearest upstream stage that lists the field as an output; consumers = downstream
   stages listing it as an input. `artifacts[].producer_policy: effective-phase-skills` does not derive anything —
   it is a runtime check that whoever records the file is one of the stage's effective skills.

`SKILL.md` frontmatter carries only `name` and `description`; the registry has no machine-readable IO per skill, so
"the outputs of a skill / plugin" are not discoverable today. Deriving stage IO from skills would require a skill-side
declaration (frontmatter or a kernel table keyed by skill) and a kernel change — a separate task.

### Runtime artifacts are not a dashboard surface

Workflow authoring must not ask a model to infer skill input/output files, and the dashboard does not display
runtime artifacts at all: 运行时产物 is gone from both the workflow page and the workspace, together with its
client, the `/api/artifacts/*` routes and the snapshot's `artifactAttempts`. `StageEditorPane` configures declared
workflow slots only. The artifact service itself stays for `tenon orchestration run`, and its unmerged-legacy-scope
compatibility issue still reaches the snapshot.

What a stage produced is read from the document ledger instead: the workspace 输出 sheet counts 已齐/总数, a missing
row names the skills that should produce it, and a stale row carries its one-word reason as hover text.

## 项目 rules (`projects/`)

- Three columns: rail = 用户级 + one card per registered project + `新建项目`; list = `HostTargetList` (12 host rows with
  the two-level label 叠加 / 项目优先 / 个人优先 / 仅项目 / 需配置, plus the file table 文件 · 状态 · 受管块 · 载入);
  detail = `InstructionEditor` (编辑 / 预览 sheets, 应用 / 删除 footer).
- One body writes to every selected target. Files that differ show 不同 with a per-file 载入; the editor never merges
  managed blocks itself — it sends the body and the server re-appends Tenon's blocks.
- Every write carries the digest the UI last read. `应用` always goes through `POST /api/instructions/preview` and the
  `DiffDrawer` (`lineDiff` rows carry `data-op`), so nothing is written before the reader confirms.
- Polling: every 5 s while the document is visible plus on window focus. A changed digest with a clean editor reloads
  silently; with a draft it only raises the 外部修改 banner. 409 from apply raises the same banner.
- `新建项目` selects the three project instruction files directly (CLAUDE.md + AGENTS.md preselected): an unregistered
  directory has no host table yet, and the create API takes file names.
- Server prose is never rendered: `instructionErrorKey` maps the error `code` to `projects.errors.<key>` / `library.errors.<key>`.

### Stage sections and agents

- Stage section order is 输入 → 技能 → 执行者 → 输出 → 评审者 → 门禁 → 退回 (`StageEditorPane`). Executors sit
  after the skills because they produce the outputs; reviewers sit right before the gate as their own
  section, never inside it.
- `stage-executors` / `stage-reviewers` (`AgentSection`) are a section head (title · count · 编辑) plus a
  read-only `SkillFlow` whose registry is mapped from the agent library (builtin → `builtin`, custom →
  `user`). A reviewer node carries one caption line — 必需 / 参考 · 阻断级别 (· 测试 n) — through `SkillFlow`'s
  `captionOf` prop. Empty lists show the noun 无.
- 编辑 opens `AgentComposer`: palette = the agent library (`palette-agent-<name>`, drag or `+`), canvas =
  the editable `SkillFlow` (an edge is `depends_on`), right column = the selected node's settings. Reviewers
  get 必需 / 参考 (`wb-agent-required-<name>`), an 阻断 select (`wb-agent-block-<name>`: 严重 / 高 / 中 / 低)
  and test chips from the step's own `tests[].id` (`wb-agent-tests-<name>`). A newly dropped reviewer takes
  the kernel's parse defaults (必需, 高). Settings are keyed by agent name, so re-laying out the canvas never
  loses them. 保存 writes through `editor.setAgents`; both lists empty removes the `agents` key.
- Wording: the concept is 智能体 everywhere in zh (rail, list title, 新建智能体, palette search 搜索智能体, 选一个智能体);
  the composer canvas says 拖入执行者 / 拖入评审者 by role. `SkillFlow` takes `label` / `emptyText` for that, and passes
  `ariaLabelConfig` so React Flow's zoom / fit controls are labelled in the UI language on every canvas.
- Lint `agent-missing` is an **error** (blocks 保存) when a step names an agent the library does not have.
  While the library is still loading (`editor.agents === null`) the rule does not run: unknowable is not
  reported as missing.

## 库 rules (`library/`)

- Three columns: rail = one card per library kind (模板 / 资源目录 / 测试方向 / 智能体), list = category and 内建 / 自定义 chips + search + rows,
  detail = `TemplateDetail` (预览 / 编辑 sheets, 变量 table, footer 复制 / 保存 / 删除).
- Builtin templates are read-only: the detail footer offers 复制 only. Custom templates save with `If-Match` and delete
  with the digest; a 409 shows the local message plus 重新载入. Every library delete (template / 智能体 / 测试方向) goes
  through `library/ConfirmDeleteDialog` first — nothing is deleted on the first click.
- The builtin library is synced by the server on every read; a failed sync shows one 内建同步失败 line and the list still
  renders whatever is on disk.
- The agent section (`AgentList` / `AgentDetail`) is the same shape: middle column lists the global library
  (builtin rows carry a lock icon), 新建 asks only for a name and writes a valid skeleton, and the detail
  shows a frontmatter table (说明 · 技能 · 工具 · 模型 · 宿主) plus the body, 预览 / 编辑 sheets for custom
  agents and 复制 only for builtin ones. Deleting an agent a workflow references fails with 409 and the
  detail lists every reference (`workflow / track / step · 身份`) instead of guessing.
- `getToken() === ''` disables every write control on both pages.

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

## Library page sections

- The Library page's rail (`LibraryRail`) lists 模板 / 资源目录 / 测试方向 / 智能体; a section owns the middle and right
  columns and nothing else. 资源目录 renders its own `ThreeColumns` with the shared rail passed in, so the rail's
  collapsed state and selection stay with `LibraryView`.
- 资源目录 filtering is client-side through `filterResources` from `@tenon/kernel/resources/query` — the same
  predicate `tenon resources list` uses. Switching a facet chip must not issue a request; the list is fetched once.
- The four facet rows are single-select `role=tablist` rows with a leading 全部 chip. Rows wrap (`flex-wrap`); each
  chip stays on one line (`whitespace-nowrap`), so enum values are never split or clipped.
- Builtin entries are read-only: only 复制 is offered. Custom entries add 编辑 (a YAML drawer validated by the
  server, errors listed verbatim) and 删除 (a `Dialog`). A 409 offers 重新载入 rather than silently overwriting.

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
