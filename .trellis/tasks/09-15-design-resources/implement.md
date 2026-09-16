# Implementation plan: design-resources

Wave 2 (parent `implement.md`). Branch `feat/design-resources` in its own worktree. Read `design.md` first; every step
below cites its section.

## 0. Preconditions (check before C1, stop and report if missing)

| Needed | From | Check |
| --- | --- | --- |
| Slot fields `scope` / `role`, per-track `document_contract`, `design-md` kind, ledger path exception (CR-1) | workflow-io-openspec (wave 1) | `grep -n "scope\|role" packages/kernel/src/workflow/parse-document-contract.ts` |
| Library page shell + optional shared builtin sync helper (CR-5) | instruction-templates (wave 1) | `ls packages/dashboard-app/src/library` |
| Upstream `skills/hue/scripts/validate.mjs`, `gsap-*` skills in payload (CR-4) | upstream-skills (wave 1) | `ls skills/hue/scripts skills/gsap-core` after `npm run build` |
| `tests:` step key, `tenon test run`, direction store (CR-2) | test-evidence (wave 2) | merge test-evidence before C11/C12 of this branch |

C1–C10 and C13 do not depend on test-evidence and can be implemented while it is in flight.

## 1. Commits

Run after every commit: `npm run build` (only when TS changed) and the listed commands.

### C1 kernel resource types, parser, serializer, validator, query — design §2, §5

- Add `packages/kernel/src/resources/{types,parse,serialize,validate,query,index}.ts`.
- Export from `packages/kernel/src/index.ts`; add `"./resources/query": "./dist/resources/query.js"` to
  `packages/kernel/package.json` exports; mirror the resolution used for `@tenon/kernel/workflow/identifier` in
  `packages/dashboard-app/{vite.config.ts,vitest.config.ts,tsconfig.json}` (grep `workflow/identifier` first).
- `query.ts` imports types only (kernel runtime import graph).
- Tests: `parse.test.ts`, `validate.test.ts`, `query.test.ts`.
- Validate: `npx vitest run packages/kernel/src/resources && npm run check:architecture && npm run check:comments`.

### C2 builtin catalog content (non design-md) — design §4.1–4.7, §4.8 first two rows

- Add `templates/catalog/builtin/<id>.yaml` for every row; open each `license.url` and confirm SPDX, redistribution,
  attribution and paid tiers before writing; drop entries that cannot be verified and note them in the commit body.
- Test: `packages/kernel/src/resources/builtin-catalog.test.ts` (design §13 row, minus the design-md count).
- Validate: `npx vitest run packages/kernel/src/resources/builtin-catalog.test.ts`.

### C3 awesome-design-md brand entries — design §4.8

- Add `tools/generate-design-md-catalog.mjs` (node built-ins only, GitHub contents API + HEAD per raw file, one retry per
  request, writes `templates/catalog/builtin/design-md-<slug>.yaml`, idempotent sorted output).
- Run it once, commit generated files; enable the `≥ 100 design-md-*` assertion.
- Validate: `node tools/generate-design-md-catalog.mjs && git diff --stat templates/catalog && npx vitest run packages/kernel/src/resources/builtin-catalog.test.ts`.

### C4 global store and builtin sync — design §3

- Add `packages/kernel/src/infrastructure/resource-catalog-store.ts` (use instruction-templates' shared helper if merged;
  otherwise implement with `withLock` + tmp/rename as in `packages/kernel/src/state/projectRegistry.ts:45-57`).
- Test: `resource-catalog-store.test.ts` (runs under the isolated runtime home, `tools/vitest.isolate-runtime-home.mjs`).
- Validate: `npx vitest run packages/kernel/src/infrastructure/resource-catalog-store.test.ts && npm run check:architecture`.

### C5 CLI `tenon resources` — design §6.1

- Add `packages/cli/src/program-resources.ts`, `packages/cli/src/commands/resources.ts`; register in `packages/cli/src/program.ts`.
- Payload dir resolved like `packages/cli/src/skillSources.ts:30-32`.
- Test: `packages/cli/src/resources.integration.test.ts`.
- Validate: `npm run build && npx vitest run packages/cli/src/resources.integration.test.ts && npx vitest run packages/cli/src/program.test.ts`.

### C6 server routes — design §6.2 (seed route lands in C8)

- Add `packages/server/src/serverResourceRoutes.ts`; dispatch in `serverGetRoutes.ts`, `serverMutationRoutes.ts`,
  `serverPostRoutes.ts`.
- Test: `packages/server/src/serverResourceRoutes.test.ts`.
- Validate: `npm run build && npx vitest run packages/server/src/serverResourceRoutes.test.ts packages/server/src/server.test.ts`.

### C7 Dashboard 资源目录 — design §6.3

- Add `packages/dashboard-app/src/api/{resourceClient,resourceTypes}.ts`, `packages/dashboard-app/src/library/resources/*`;
  mount in the Library page rail; `resources` namespace in `packages/dashboard-app/src/i18n/translations.ts` (zh + en).
- Tests: `resourceClient.test.tsx`, `ResourceCatalog.test.tsx`; existing `i18n.test.tsx`, `designSystem.test.tsx`.
- Validate: `npm run test:web -- packages/dashboard-app/src/library/resources packages/dashboard-app/src/api/resourceClient.test.tsx packages/dashboard-app/src/i18n && npm run check:design-scale && npm run build`.
- Manual: `tenon dashboard`, open 资源目录, filter React + Tailwind + 图标 at 1280px and 900px widths; nothing wraps.

### C8 frontend block renderer + DESIGN.md seed — design §6.4, §6.2 seed row

- Add `packages/kernel/src/resources/frontend-selection.ts` (+ test).
- Add `packages/server/src/designSeed.ts` (`fetchDesignSeed`, `writeDesignSeed`) and `POST /api/design/seed`; register-root
  check reuses the existing workflow root anchor helper used by create-change.
- Wire into instruction-templates' frontend block and apply (CR-5) if their code is merged; otherwise leave the exported
  functions and record the hand-off in the task notes.
- Validate: `npx vitest run packages/kernel/src/resources/frontend-selection.test.ts packages/server/src/serverResourceRoutes.test.ts && npm run build`.

### C9 design system check, proposal, CLI `tenon design` — design §7.2, §7.5, §7.6

- Add `packages/kernel/src/design-system/{check,proposal,index}.ts`, `packages/kernel/src/infrastructure/design-system-fs.ts`.
- Add `packages/cli/src/commands/design.ts` + registration in `program-resources.ts`; injectable validator path on `CliDeps`
  (`packages/cli/src/deps.ts`).
- Tests: `check.test.ts`, `packages/cli/src/design.integration.test.ts` (check/validate/propose parts).
- Validate: `npm run build && npx vitest run packages/kernel/src/design-system packages/cli/src/design.integration.test.ts`.
- Manual: copy `~/.agents/skills/hue/examples/ridge/*` into a temp repo `design/`, author a minimal `DESIGN.md`, run
  `tenon design validate` against the real upstream validator.

### C10 creation precondition — design §7.4

- Add `packages/kernel/src/design-system/precondition.ts` (+ test).
- Call it in `packages/cli/src/commands/init.ts` after `loadEffectiveWorkflowPlan` and in
  `packages/server/src/serverPostChangesRoutes.ts` after plan load.
- Tests: precondition unit test; init cases in `design.integration.test.ts`; server create-change case.
- Validate: `npm run build && npx vitest run packages/kernel/src/design-system packages/cli/src/design.integration.test.ts packages/cli/src/init-workflow.integration.test.ts packages/cli/src/track-branch.integration.test.ts && npx vitest run packages/server`.

### C11 template workflow `design-system` — design §9.1 (after test-evidence merge)

- Add `templates/workflows/design-system.yaml`; extend `tools/generate-default-workflow.mjs` to emit
  `DESIGN_SYSTEM_WORKFLOW_SOURCE`; extend `check:default-workflow-freshness` in `package.json` to diff the new generated file.
- Add `packages/kernel/src/workflow/template-workflows.ts`; `isTemplateWorkflowName` in `workflow/identifier.ts`;
  fallback in `workflow/loadWorkflow.ts`; template names in `projectWorkflowNames` (`workflow/branch-track-lookup.ts`);
  `packages/server/src/serverGetRoutes.ts` fallback and workflow index source; Dashboard restore condition in
  `packages/dashboard-app/src/workbench/{workbenchDefinition,useWorkflowEditor}.ts`.
- Tests: `template-workflows.test.ts`; existing `loadWorkflow.test.ts`, `generate-default-workflow.test.ts`,
  `serverWorkflowDefinitionStatusRoutes.test.ts`, workbench tests.
- Validate: `npm run generate:default-workflow && npm run check:default-workflow-freshness && npm run build && npx vitest run packages/kernel/src/workflow packages/server/src && npm run test:web -- packages/dashboard-app/src/workbench`.

### C12 default frontend branch data + test direction — design §9.2, CR-2

- Edit only the frontend branch of `templates/workflows/default.yaml` (contract block, spec prompt, ship prompt + test).
- Add `design-system` builtin direction file in test-evidence's builtin directory (their path) if not already added there.
- Regenerate default workflow source.
- Validate: `npm run generate:default-workflow && npm run check:default-workflow-freshness && npm run check:default-skill-matrix && npx vitest run packages/kernel/src/workflow packages/cli/src/track-branch.integration.test.ts packages/cli/src/design.integration.test.ts`.

### C13 GSAP motion gate — design §8

- Extract history parsing + `completedSkillsSinceStepEntry` from `packages/cli/src/commands/internalSkillGate.ts` into
  `packages/cli/src/commands/stepSkillEvidence.ts` (no behaviour change; existing `internalSkillGate.test.ts` must stay green).
- Add `packages/cli/src/commands/internalMotionGate.ts`, hidden registration in `program.ts`.
- Add `pipeline_enforce_motion_gate` and the candidate `case` to `hooks/gate.sh`; new cases in `tools/test-hooks.sh`.
- Validate: `npm run build && npx vitest run packages/cli/src/commands/internalSkillGate.test.ts packages/cli/src/commands/internalMotionGate.test.ts packages/cli/src/internal-skill-gate-hook.integration.test.ts && bash tools/test-hooks.sh`.

### C14 specs — design §7, §8, §6.3

- Add `.trellis/spec/kernel/backend/resource-catalog.md` and `.trellis/spec/kernel/backend/design-system.md` (7-section format
  used by `workflow-track-branches.md`), link them from `.trellis/spec/kernel/backend/index.md`; add a 资源目录 paragraph to
  `.trellis/spec/dashboard-app/frontend/component-guidelines.md`; add the motion gate to `.trellis/spec/cli/frontend/hook-guidelines.md`.
- Validate: `npm run check:docs`.

## 2. Final gates on the branch

```bash
npm run build
npm run check:architecture && npm run check:comments && npm run check:identity
npm run check:default-skill-matrix && npm run check:default-workflow-freshness && npm run check:design-scale
npm test && npm run test:web && bash tools/test-hooks.sh && bash tools/verify-skills.sh
```

Real-host acceptance (after wave-2 merges, in both Claude Code and Codex, installed release):
1. Dashboard filter React + Tailwind + 图标; detail of react-bits shows 仅链接.
2. New React project with shadcn-ui + lucide + zustand + tailwindcss + one design-md brand: root `DESIGN.md` exists,
   instruction files carry the §6.4 block.
3. `tenon init` a frontend task → blocked with the design-system hint; run a design-system task to 完结; frontend task now opens.
4. Ask the agent for a page with a GSAP animation: first Write is blocked until gsap-core/gsap-react are loaded; Codex
   result for `apply_patch` recorded in `hook-guidelines.md`.
5. `find <installed payload>/templates/catalog -type f ! -name '*.yaml'` prints nothing.
6. Create, edit, delete a custom resource; refresh shows the same state.

## 3. Risky files and rollback points

| File | Risk | Rollback |
| --- | --- | --- |
| `hooks/gate.sh` | runs on every tool call in both hosts; a bash error blocks or slows everything | revert C13 alone; C1–C12 unaffected |
| `packages/cli/src/commands/init.ts`, `packages/server/src/serverPostChangesRoutes.ts` | a wrong precondition blocks all task creation | revert C10; kernel check stays |
| `packages/kernel/src/workflow/loadWorkflow.ts`, `serverGetRoutes.ts`, workbench restore | template fallback could shadow a user workflow named `design-system` or break default restore | revert C11 (C12 does not depend on it) |
| `templates/workflows/default.yaml` + generated source | breaks every default task if the contract block does not parse | revert C12; regenerate |
| `resource-catalog-store.ts` rename sequence | could empty `builtin/` on crash | covered by crash test; revert C4 leaves CLI/server reading nothing but not failing tasks |
| `internalSkillGate.ts` extraction | skill gate regressions | extraction is its own diff inside C13; revert C13 |

## 4. Overlap files and merge notes

| File | Also touched by | Note |
| --- | --- | --- |
| `templates/workflows/default.yaml` | workflow-io-openspec, test-evidence, review-agents, data-driven-runner | change only the frontend branch's contract block, spec/ship `prompt`, ship `tests`; rebase onto their versions, never reorder skills |
| `packages/kernel/src/workflow/{parse-document-contract,document-contract,types,identifier,loadWorkflow,branch-track-lookup}.ts` | workflow-io-openspec, data-driven-runner | consume their slot types; add only template helpers and fallback lines |
| `tools/generate-default-workflow.mjs`, `packages/kernel/src/workflow/default-workflow.generated.ts`, `package.json` | data-driven-runner, others editing default.yaml | never hand-merge generated TS; regenerate after merge |
| `packages/dashboard-app/src/i18n/translations.ts` | every UI child | add one `resources` namespace block per locale at the end of each locale object |
| `packages/server/src/serverGetRoutes.ts`, `serverMutationRoutes.ts`, `serverPostRoutes.ts`, `serverPostChangesRoutes.ts` | review-agents, test-evidence, instruction-templates, multi-user, task-delete-archive | one dispatch line each delegating to `serverResourceRoutes.ts`; precondition call is a single line after plan load |
| `packages/cli/src/program.ts` | all CLI children | one `registerResourceCommands(program, deps)` line + hidden `internal-motion-gate` |
| `packages/cli/src/commands/init.ts` | multi-user (creator/owner), test-evidence | precondition call after plan load, before any write |
| `packages/cli/src/commands/internalSkillGate.ts`, `hooks/gate.sh` | review-agents (progressive skill unlock), data-driven-runner | land the extraction first as a no-op commit so their changes rebase onto `stepSkillEvidence.ts` |
| `packages/cli/src/deps.ts` | test-evidence (test runner deps) | optional field only |
| `packages/kernel/package.json`, `packages/kernel/src/index.ts` | several | export lines only |
| Library page files | instruction-templates, review-agents, test-evidence | mount point only; no shared state |

Generated files (`dist`, `default-workflow.generated.ts`, `templates/skill-sources.yaml`) are regenerated by the main
session after merge, not merged by hand.

## 5. Size

About 3.8k lines of TS/TSX and tests (kernel ≈ 1.1k + 0.9k tests, CLI ≈ 0.5k + 0.4k, server ≈ 0.3k + 0.3k,
Dashboard ≈ 0.7k + 0.35k), ≈ 0.15k YAML workflow/hook changes, ≈ 100 hand-authored catalog files plus generated brand
files. 14 commits. Size L.

## Deviations

Written while implementing; each line is a place where the design met the code and the code won.

### Names and shapes

1. **Catalog categories follow instruction-templates, not `design.md` §2.2.** Wave 1 had already shipped
   `CATALOG_CATEGORIES = [component-lib, blocks, template, icons, design-md, state, styling]` and
   `{{catalog.<category>}}` placeholders in the builtin frontend blocks. The design's `components` is therefore
   `component-lib`, `template` stays a separate category from `blocks`, and the set gained `animation` and
   `motion-components` so a block can reference GSAP and the motion collections. `resources/types.ts` now owns the
   list and `instructions/categories.ts` re-exports it, so the two can never drift.
2. **No `renderFrontendResourceBlock`.** instruction-templates had already defined the consumer port
   (`CatalogLookup` / `CatalogEntrySummary` in `instructions/compose.ts`), so this child provides
   `resourceCatalogLookup(entries)` and wires `POST /api/instruction-templates/compose` to it instead of rendering
   a second Markdown block. `compose.ts` gained one line: a 仅链接 rule for non-redistributable entries (the
   summary already carried `redistributable` but never rendered it).
   `validateFrontendSelection` was not implemented: nothing calls it — compose already rejects a category
   mismatch, and the 选资源 step that would check framework/styling compatibility belongs to instruction-templates.
3. **`design-md-spec` → `google-design-md`.** The `design-md-` prefix belongs to the brand generator, which deletes
   unknown files under it; a hand-written entry may not use that prefix.
4. **Store API is `{ payloadRoot, configRoot }`, not `{ payloadDir, storeRoot }`,** so the shared builtin sync
   helper can be called without reconstructing the config root from a string.

### Workflow schema realities

5. **Project documents are read through `require` slots, not `reads`.** The wave-1 validator rejects a `reads`
   entry whose kind has no earlier non-require slot (`… 读取了未声明的 document 'design-md'，项目文档用 role: require`).
   `design.md` §9.2's `reads: build/verify: [design-md]` is therefore three `require` slots (open / build / verify).
6. **A `document_contract` requires `openspec: true`.** CR-1's "project-scope slots are governed either way" did not
   land, so `design-system.yaml` sets `openspec: true`.
7. **`design_doc`, not a new `design_direction` field.** Artifact fields are a closed set (`FIELD_ORDER`); adding one
   is a state-wire change that this child has no reason to make. The 方向 step registers its direction document as
   `design_doc`.
8. **The default frontend branch's document policy now differs from the legacy migration table.** Wave 1's test
   asserted every branch reproduces `LEGACY_DOCUMENT_GOVERNANCE_POLICY` byte for byte. The four other branches still
   do, and the assertion was split so they keep proving it; the frontend branch is asserted separately (its
   `requiresByStep` and the ship `update` slot). Existing changes carry their own frozen snapshot, so they keep
   binding; a change created before this release is unaffected.
9. **Historical snapshot fixtures strip `prompt`** exactly as wave 1 stripped `openspec` / `documentContract` and
   test-evidence stripped `tests`: historical bytes predate the key.

### Surfaces

10. **413 is decided from `content-length`.** The server transport drops bodies over 64 KiB before a handler runs,
    so a post-hoc size check could never fire.
11. **The DESIGN.md seed route is not yet called by anything.** `POST /api/design/seed` and `designSeed.ts` are
    implemented and tested, but instruction-templates' apply does not know about a selected `design-md` entry;
    wiring it is a post-merge item (below).
12. **`tenon design validate` runs hue through an injected runner** (`CliDeps.designValidator`), so no test ever
    spawns a real validator or `npx`.
13. **Test fixtures seed a design system.** Any frontend task on `default` now needs a ready `DESIGN.md`, so
    `freshHarness()` (CLI) and `makeProject()` (server) write one; tests that exercise the precondition remove it.
    The fixture lives in `@tenon/kernel/design-system/test-support`, exported as its own subpath so both packages
    share one definition of "ready".
14. **The hidden `internal-motion-gate` command registers from `program-resources.ts`,** not `program.ts`: that file
    was at its 400-line cap, so this child also moved `migrate-workflow` and `state` into `program-state.ts`.

### Catalog content

15. **89 curated entries, not the design's ~96.** Every license was read from its `license.url` before the entry was
    written. Dropped because no license text could be read: `gluestack-ui`, `coss-ui`, `css-modules` (no license file
    in the repository), `skiper-ui` (site states none), `v0-templates`, `sf-symbols`, `swiftui` (no quotable terms on
    the pages). Corrected against the design: HeroUI is Apache-2.0, Animate UI carries a Commons Clause (so it is
    link-only), Preline is MIT + a Fair Use clause requiring attribution, Iconify's framework packages are MIT while
    each icon set keeps its own license.
16. **74 brand `DESIGN.md` entries, not ≥ 100.** The upstream index currently has 74 brand directories (the research
    note's ~117 is stale), so the builtin test asserts ≥ 70.
17. **`magic-ui` declares no skills.** CR-4 asked upstream-skills to add a `magic-ui` source and it did not land; the
    builtin catalog test requires every declared skill id to exist in `skills/sources.yaml`, so the entry links only.

## Deferred and post-merge wiring

- **Real-host acceptance** (parent X18): the six scenarios in §2 of this file run in wave 5 on `main`, in both hosts,
  from an installed release. Nothing in this branch runs Claude Code or Codex.
- **DESIGN.md seed in the new-project flow**: instruction-templates' 选资源 step must pass the chosen `design-md`
  entry id and its apply must call `POST /api/design/seed` so the file appears in the diff (CR-5).
- **`magic-ui` upstream skill**: add the source, then set `skills: [magic-ui]` on that entry.
- **frontend-quality reviewer** (CR-3, review-agents, wave 3): the motion checklist and the 设计体系 section, plus
  declaring the gsap skills for progressive loading.
- **`tenon` runner skill** (CR-6, data-driven-runner, wave 4): keep the frontend spec / ship prompts and the ship
  `design-system` test when default migrates, and pass step `prompt` to the agent.
