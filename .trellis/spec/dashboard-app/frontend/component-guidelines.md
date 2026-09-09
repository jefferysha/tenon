# Component Guidelines

> How components are built in this project. Baseline: the workspace template (2026-09) — warm paper
> ground, deep-green accent, hairline borders instead of shadows, mono identifiers, three columns.

## Three-column page contract (`shell/ThreeColumns.tsx`)

Every top-level view renders exactly:

```tsx
<ThreeColumns
  testId="<view>-view"
  railCollapsed={collapsed}
  rail={<RailColumn …>{RailCard[]}</RailColumn>}        // what you are looking at (project / workflow / scope / machine)
  list={<ListColumn eyebrow title note search chips>…</ListColumn>} // the items of the selected rail object
  detail={selected ? <DetailColumn … /> : <DetailEmpty … />}          // one selected item
/>
```

- Widths are fixed in the primitive (296 / 492 / flex; rail collapses to 64 below 1280px; columns stack
  below 900px). Do not pass widths from a view.
- `RailCard` / `FilterChip` / `StatusPill` carry state via `aria-current`, `aria-selected`, `data-tone`;
  tests assert those attributes, never class names.
- Selected list cards use the shared selection tokens (`bg-sel-bg border-sel-border border-l-sel-edge`).

### Right column = header + sheets

`DetailColumn` takes a fixed `header` (eyebrow / H1 / mono slug / `StatusPill` + one-sentence lead /
optional `PhaseRail`), a `sheets` slot and one visible body. Use `SheetTabs` + `useSheetState`:

```tsx
const sheets: SheetDef<SheetId>[] = [{ id: 'stages', label: t('workspace.sheet_stages'), count: n }, …]
const [sheet, setSheet] = useSheetState<SheetId>('tenon-dashboard-sheet:<page>', sheets, 'stages')
<DetailColumn sheets={<SheetTabs sheets={sheets} active={sheet} onChange={setSheet} idPrefix="task-detail" ariaLabel=… />}>
  {sheet === 'stages' && …}
</DetailColumn>
```

- One sheet visible at a time; each sheet owns its empty state. Never stack all sheets vertically.
- Memory key is `tenon-dashboard-sheet:<page>`; a stored id outside the current sheet set falls back to
  the default. Tests preset the key with `localStorage.setItem` to open a specific sheet on first render.
- Tab test ids are `${idPrefix}-tab-${id}`; the panel is `${idPrefix}-panel`.

### Global search

The top bar owns the query (`GlobalSearchProvider`); a view filters its own list with
`matchesQuery(query, …fields)`. Any component that calls `useGlobalSearch()` must be rendered under the
provider — component tests wrap with `<I18nProvider><GlobalSearchProvider>…`.

## Read-only boundary

- `workspace/` (工作台) is read-only: no write endpoint (`postTransition`, `postAfk*`, `postWorkflowDef`,
  `/api/tracks` …) may be imported there. Copying text / links is the only "action".
- Write capability lives in `workflow/` (definition CRUD via `useWorkflowEditor`), `afk/` (enqueue / retry /
  settings) and `machine/` (host install plans). These views mount only when `isProjectWritable(project)`;
  otherwise `ProjectGate` renders in place — never silently redirect.
- The top-bar pill says 只读视图 for the reading surface and switches to 项目不可写 when the selected
  project is not writable.

## Workflow editor rules (`workflow/`)

- Stage inputs / outputs are **derived, never typed**: `DerivedIoPanel` reads `WbStepDef.inputs`,
  `outputs`, `artifacts[].producerPolicy` / `requiredWhen` and resolves producer / consumer stages from the
  step order. Adding a text input for outputs is a regression.
- Skill order inside a stage is expressed only through `depends_on`; the UI shows waves computed by
  `skillExecutionWaves` (same wave = parallel, waves serial). Stage `mode` in the pipeline preview is the
  same derivation.
- All draft mutations go through `useWorkflowEditor` (`editLane`, `replaceStep`, `addSkill`, `moveSkill`,
  `setSkillDependency`, `setLaneGuard`, `reorderStages`, `removeStage`); the footer bar is the only
  save / discard entry, and `default` is read-only (copy first).
- hooks.json toggles (阶段 → 钩子 sheet, `TimelineHookNodes`) are per-root runtime config: they write
  immediately and ignore the workflow read-only state.

## Styling patterns

- Tokens only: colours via semantic classes (`text-text-2`, `bg-accent-t`, `border-border`, `bg-info-t`,
  `bg-seg-now` …) defined in `src/index.css`; no hex in components.
- Type scale is 7 steps (`text-micro … text-page`), radius 4 steps (`rounded-xs … rounded-lg`, `rounded-full`),
  spacing on the 4px grid; `tools/check-design-scale.mjs` blocks arbitrary values.
- Cards separate by border and ground colour; shadows are reserved for floating layers.
- `[hidden]` must beat a component's own `display` (the primitive styles use `hidden` attributes for
  inactive sheets); never rely on `display:none` from the UA stylesheet when a class sets `display`.

## Accessibility

- Dialogs keep accessible title, `aria-modal`, Escape, focus capture / restore.
- Sheet tabs are a `role=tablist` with roving tabindex and arrow-key movement.
- Status is text + tone, never colour alone; `/` focuses global search, Escape clears it.

## Common mistakes

- **Flex child without `min-height: 0`** inside the fixed-height grid pushes the detail footer off-screen;
  `DetailColumn` already sets it — keep it when adding wrappers.
- **Grid card with long content** (`grid w-full`) overflows its column; add `min-w-0 grid-cols-[minmax(0,1fr)]`
  and `truncate` on the text spans (see `TaskCard`).
- **Rendering `TaskDetail` surfaces** inside a sheet duplicates its own small header — wrap with
  `[&_[data-testid=dt-head]]:hidden` as `TaskDetailPane` does.
- **Testing a sheet** without presetting `tenon-dashboard-sheet:<page>` looks for content that is not
  mounted; preset the key or click `${idPrefix}-tab-${id}` first.
- **Deriving task stage status twice**: middle-column cards and the right-column rail both read
  `workspace/workspaceModel.ts` (`stageExecution`, `nextStepLabel`) — do not re-map `ProgressState` in a view.
