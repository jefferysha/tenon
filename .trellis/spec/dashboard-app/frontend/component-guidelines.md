# Component Guidelines

> How components are built in this project. Baseline: the workspace template (2026-09) — warm paper
> ground, deep-green accent, hairline borders instead of shadows, mono identifiers, three columns.
> Scope rule: the dashboard does only two things — read a task's per-stage inputs / outputs, and edit
> workflow definitions. Do not add features because "the old version had them".

## Three-column page contract (`shell/ThreeColumns.tsx`)

Every top-level view renders exactly:

```tsx
<ThreeColumns
  testId="<view>-view"
  railCollapsed={collapsed}
  rail={<RailColumn …>{RailCard[]}</RailColumn>}        // what you are looking at (project / workflow)
  list={<ListColumn eyebrow title note search chips>…</ListColumn>} // the items of the selected rail object
  detail={selected ? <DetailColumn … /> : <DetailEmpty … />}          // one selected item
/>
```

- Widths are fixed in the primitive (296 / 492 / flex; rail collapses to 64 below 1280px; columns stack
  below 900px where the rail becomes a horizontal card row). Views never pass widths.
- `RailCard` / `FilterChip` / `StatusPill` carry state via `aria-current`, `aria-selected`, `data-tone`;
  tests assert those attributes, never class names.
- Selected list cards use the shared selection tokens (`bg-sel-bg border-sel-border border-l-sel-edge`).

### Right column: header + at most one tab group

`DetailColumn` takes a fixed `header` (eyebrow / H1 / mono slug / `StatusPill` + one-sentence lead /
optional `PhaseRail`) and one body. The body may contain **at most one** `SheetTabs` group (the file
workbench's 输入 / 输出). Sections stack vertically otherwise; if a right column needs more than one tab
group the page has too many functions — remove some.

### Global search

The top bar owns the query (`GlobalSearchProvider`); a view filters its own list with
`matchesQuery(query, …fields)`. Components calling `useGlobalSearch()` must be rendered under the
provider — tests wrap with `<I18nProvider><GlobalSearchProvider>…`.

## 工作台 rules (`workspace/`)

- Read-only. No write endpoint may be imported; the only network call besides the snapshot is
  `GET /api/documents/read` (`api/documentsClient.ts`) and, for custom workflows, `GET /api/workflows/<name>`.
- Stage inputs / outputs come from the workflow definition (`WbStepDef.inputs/outputs` → `stageFiles.stageIo`)
  resolved against `change.fields`: `file_path` fields become readable / missing file rows, other
  fields become value chips. `change.documents.items` render as a separate 变更文档 group.
- Status semantics (badge text, stage status, next step) come only from `workspace/taskRows.ts` and
  `workspace/workspaceModel.ts`; never re-map `ProgressState` in a component.

## 工作流 rules (`workflow/`)

- The stage editor has three sections and no tabs: 技能 (order + serial / parallel), 门禁, 输入 / 输出.
- Inputs / outputs are **derived, never typed** (`DerivedIoPanel` reads `inputs`, `outputs`,
  `artifacts[].producerPolicy/requiredWhen` and resolves producer / consumer stages by step order).
  Adding a text input for outputs is a regression.
- Serial / parallel is expressed only through `depends_on`: skill *i* is "parallel" when it does not
  depend on skill *i-1* (`skillWaves.isParallelWithPrevious`); the toggle calls
  `useWorkflowEditor.setSkillDependency`. New skills default to serial (depend on the last one).
- All draft mutations go through `useWorkflowEditor`; the footer bar is the only save / discard entry;
  `default` is read-only (copy first). Tracks are shown only as "被 X 轨道默认使用" on the rail card.

## Styling patterns

- Tokens only: colours via semantic classes (`text-text-2`, `bg-accent-t`, `border-border`, `bg-info-t`,
  `bg-seg-now` …) defined in `src/index.css`; no hex in components.
- Type scale is 7 steps (`text-micro … text-page`), radius 4 steps (`rounded-xs … rounded-lg`, `rounded-full`),
  spacing on the 4px grid; `tools/check-design-scale.mjs` blocks arbitrary values.
- Cards separate by border and ground colour; shadows are reserved for floating layers.
- `[hidden]` must beat a component's own `display` (index.css does this globally).

## Accessibility

- Dialogs keep accessible title, `aria-modal`, Escape, focus capture / restore.
- Tab groups are `role=tablist` with roving tabindex and arrow-key movement.
- Status is text + tone, never colour alone; `/` focuses global search, Escape clears it.

## Common mistakes

- **Flex child without `min-height: 0`** inside the fixed-height grid pushes the detail footer off-screen;
  `DetailColumn` already sets it — keep it when adding wrappers.
- **Grid card with long content** overflows its column; add `min-w-0 grid-cols-[minmax(0,1fr)]` and
  `truncate` on the text spans (see `TaskCard`).
- **Rendering `Error.message` or a field named `message`** in TSX trips the i18n leak gate; format through
  `formatApiError` and store it under another name (`detail`).
- **Bringing a feature back** (per-stage skills/hook toggles, run logs, automation, machine readiness,
  track panels) needs a product decision first; the 2026-09 minimal rebuild deleted them deliberately.
