# Project Design System (`design-system/`, `DESIGN.md`)

## 1. Scope / Trigger

- Trigger: any change to `DESIGN.md`'s structure, the `tenon design` commands, the creation precondition, or the
  `design-system` template workflow.
- A project has exactly one design system: `DESIGN.md` at the repository root plus `design/` (the hue model, the
  confirmed direction and four preview pages). Every frontend task in that project follows it.

## 2. Signatures

```ts
// design-system/check.ts (pure; the reader port is implemented in infrastructure/design-system-fs.ts)
DESIGN_SCHEMA = 'tenon-design/v1'; DESIGN_MD_PATH = 'DESIGN.md'; DESIGN_MODEL_PATH = 'design/design-model.yaml'
DESIGN_SECTIONS = ['Philosophy','Craft Rules','Anti-Patterns','Tokens','Iconography','Hero Stage','Components','Voice','Platform Mapping','Previews']
DESIGN_PREVIEWS = ['design/preview.html','design/component-library.html','design/landing-page.html','design/app-screen.html']
type DesignSystemStatus = 'missing' | 'seed' | 'incomplete' | 'ready'
checkDesignSystem(reader: DesignFileReader, iconIds: ReadonlySet<string>): { status; problems[] }

// design-system/proposal.ts (pure)
designProposalPath(change): string                       // openspec/changes/<change>/design-system.md
designBaseDigest(designMd, model): string                // sha256(DESIGN.md ‖ design-model.yaml)
renderDesignProposal(change, base) / designProposalBase(text)

// design-system/precondition.ts (pure) + infrastructure/design-precondition.ts (fs)
assertCreationPreconditions({ workflow, track, firstStep, policy, repoRoot }, specs): void   // throws ProjectDocumentPreconditionError
designSystemPrecondition({ repoRoot, payloadRoot, configRoot, workflow, track, firstStep, policy }): Promise<string | null>
```

## 3. Contracts

- `DESIGN.md` carries front matter `schema: tenon-design/v1`, `model: design/design-model.yaml` and
  `icons: <resource id>`, then the ten fixed sections `## <n>. <Section>` in order. Headings stay English (they
  are hue's own vocabulary and the checker is locale-free); the body language is free.
- Status: `missing` (no file) → `seed` (a file without the schema marker, for example a brand file just fetched
  by `POST /api/design/seed`) → `incomplete` (marker present, problems remain) → `ready`. Problems are exact
  strings: a wrong `model`, a missing model file or model top-level key, an `icons` value that is not an id in the
  resource catalog's `icons` category, a missing or out-of-order section, a missing preview file or an unlinked
  preview, placeholder text, or an em-dash (hue's hard rule).
- `tenon design check` is the fast structural judgement (exit 0 only when `ready`). `tenon design validate` runs
  only after `ready`: it spawns the upstream hue `scripts/validate.mjs` against `design/` and then refuses when a
  design proposal exists whose `base` digest still equals the current one — that means the change was never
  merged back. The validator is injected through `CliDeps.designValidator`, so tests never spawn anything.
- `tenon design propose <change>` writes the proposal skeleton with the digest at propose time. The digest proves
  the design system moved, not that the proposal's content was merged; that judgement stays with the human spec
  review and the ship record.
- **Creation precondition**: when the selected branch's first step declares a project-scoped document with
  `role: require`, that document must be `ready` before the change directory is created. Both creation paths
  (`cmdInit`, `POST /api/changes`) call the same `designSystemPrecondition` right after the plan is loaded and
  before any write, so the refusal message is identical. The catalog is read only when the requirement exists.
- The requirement is **data**, not a hard-coded track name: `default`'s frontend branch declares
  `design-md` `require` at `open` / `build` / `verify` and `update` at `ship`. A product track can instead declare
  `produce` at its own build step and is then not gated at creation.
- `design-system` is a template workflow (`templates/workflows/design-system.yaml`), not a TS builtin: 方向
  (review, hue phases 1–6, two human confirmations) → 生成 (auto, hue phases 7–14, `tenon design validate`,
  `document record design-md`) → 预览 (review, loops back to 生成 and ends through the implicit completion edge).
  hue itself is never patched; it is steered by step `prompt` data only.

## 4. Failure Modes

| Condition | Result |
| --- | --- |
| Frontend task creation with `DESIGN.md` not ready | CLI exit 1 / HTTP 400 `工作流 <w> 轨道 <t> 要求项目 DESIGN.md 就绪（当前：缺失\|起步\|不完整）；先完成设计体系任务…` plus up to five problems; no change directory |
| `tenon design check` not ready | exit 1 with the status word and the problems |
| hue validator not installed | exit 1 `hue 技能未安装；运行 tenon update 同步上游技能` |
| Proposal exists and the digest is unchanged | exit 1 `设计变更未合并：按 openspec/changes/<c>/design-system.md 更新 …` |

## 5. Rationale

- Two checks with different costs: creation happens constantly and must stay fast and offline, so it uses the
  structural check; the full hue validation is a required test that runs where a test belongs.
- The precondition reads the document policy rather than a track name, so a workflow author can move the
  requirement without touching Tenon's code.
- Merging hue's four Markdown outputs into one root `DESIGN.md` gives agents and other tools a single file to
  read, while `design/` keeps hue's own model and previews intact so hue iteration and its validator still work.

## 6. Test Fixtures

`@tenon/kernel/design-system/test-support` writes and removes a ready design system. CLI and server temporary
project fixtures seed one by default, because any frontend task in `default` now needs it; tests that exercise
the precondition remove it explicitly.

## 7. Related

- [Resource Catalog](./resource-catalog.md) — the `icons` ids and the brand `DESIGN.md` entries.
- [Workflow Track Branches and Gates](./workflow-track-branches.md) — `role: require` slots and template workflows.
