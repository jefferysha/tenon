# Design: 前端设计资源目录 + 项目设计体系

> **Parent overrides** (`.trellis/tasks/09-15-tenon-next-capabilities/design.md` §9 wins over this file): X3/X5 add design-md slots with `role` (no `scope:`) into the default.yaml track tables; X6 GSAP motion checklist goes into builtin frontend-quality (review-agents wave 3; you only provide the checklist text in design-resources docs if needed); X12 disk path `config/resources/`; append the 8 gsap rows to `skills/sources.yaml`; add builtin test direction `design-system` under test-evidence's builtin directions; X18.

Binding contracts: `.trellis/tasks/09-15-tenon-next-capabilities/design.md` (terms §1, layout §3, workflow YAML §4,
execution boundary §6, Dashboard surfaces §7). Requirements: `prd.md` R1–R8. Evidence: `research/*.md`.

## 0. Current code facts this design builds on

| Fact | Evidence |
| --- | --- |
| Document kinds are a closed list of 10; no DESIGN.md kind | `packages/kernel/src/workflow/document-contract-model.ts:7-18` |
| `default` ignores YAML `document_contract`: name-governed legacy table for all tracks | `packages/kernel/src/workflow/document-contract.ts:141-143` |
| Custom contract slots are `{kind, ownerStep, producers}` only; parser rejects any other slot line and empty producers | `packages/kernel/src/workflow/types.ts:215-219`, `parse-document-contract.ts:29-58` |
| Ledger accepts only `openspec/` and `docs/` paths; 2 MiB source limit | `packages/kernel/src/state/document-path.ts:19,267-269` |
| Steps already carry an agent `prompt` (`prompt: \|-`) | `packages/kernel/src/workflow/types.ts:175-176`, `parse-primitives.ts:22-37` |
| Only `default` has a YAML template fallback; `simple` is a non-shadowable TS builtin | `effective-plan.ts:318-326`, `serverGetRoutes.ts:331-334`, `builtin-workflows.ts:3-9,68`, `loadWorkflow.ts:17-35` |
| A workflow without `tracks:` accepts any registered track; builtin tracks except `simple` allow `*` | `.trellis/spec/kernel/backend/workflow-track-branches.md:88-93`, `packages/kernel/src/tracks/builtins.ts:42,62` |
| Task creation happens in two places, both after plan load and before any write | `packages/cli/src/commands/init.ts:166-222`, `packages/server/src/serverPostChangesRoutes.ts:183-208` |
| `/api/catalog` and kernel `catalog/` already mean the definition catalog | `packages/server/src/definitionCatalogRoutes.ts:34`, `packages/kernel/src/catalog/` |
| Kernel has no YAML dependency; config parsers are hand-written narrow scanners | `packages/kernel/package.json`, `packages/kernel/src/skills/source-registry.ts:197` |
| Dashboard already imports a pure kernel subpath | `packages/kernel/package.json` exports `./workflow/identifier`, `packages/dashboard-app/src/workbench/workbenchDefinition.ts:9` |
| Payload templates are located relative to the bundle | `packages/cli/src/skillSources.ts:30-32` |
| Global config root and store pattern | `packages/kernel/src/product-paths.ts:102-160`, `workflow/global-store.ts:16-18` |
| Lock + tmp/rename write primitive | `packages/kernel/src/state/projectRegistry.ts:45-57` |
| Skill gate: bash fast path, node only for candidates, fail-open except exit 2 | `hooks/gate.sh:14-18,60,370-412,433,456,467` |
| Codex routes every PreToolUse through `veto.sh` → `gate.sh` | `adapters/codex/hooks.json:19-25`, `adapters/codex/hooks/veto.sh:26-29` |
| Step-visit skill evidence scan and id canonicalization | `packages/cli/src/commands/internalSkillGate.ts:60-84,165-180` |
| Namespaced skill ids must compare equal (`superpowers:x` ≙ `x`) | `.trellis/spec/kernel/backend/skill-output-registration.md:218-223` |
| Tenon `hue` is a 14-line stub; upstream hue is 869 lines with `scripts/validate.mjs` | `skills/hue/SKILL.md`, `templates/skill-sources.yaml:49`, `~/.agents/skills/hue/SKILL.md` |
| hue writes to a skill folder by default but honours a user-given path | `~/.agents/skills/hue/SKILL.md:538-554` |
| hue validator: one folder arg; skips frontmatter check when no `SKILL.md`; em-dash check only on `SKILL.md`/`tokens.md`; `npx js-yaml` skipped when unavailable; exit 1 on any ERROR | `~/.agents/skills/hue/scripts/validate.mjs:26,92-106,222-243,248-253,439-484` |
| Frontend track today: no design skill in explore/spec, `frontend-design` in build | `templates/workflows/default.yaml:284-430` |
| Stage-skill prose about DESIGN.md that the runner child deletes | `skills/tenon-build/SKILL.md:150-153`, `skills/tenon/SKILL.md:414` |
| Page rules: ThreeColumns, nouns only, no wrap, tokens only | `.trellis/spec/dashboard-app/frontend/component-guidelines.md:23-43,262-267` |

## 1. Boundaries

### Owned here

1. 资源目录: entry schema, strict parser/serializer/validator, license gate, query predicate, builtin content,
   global store with builtin sync, CLI query, HTTP routes, Dashboard 资源目录 section.
2. Frontend resource block renderer and selection validation (consumed by `09-15-instruction-templates`).
3. DESIGN.md seed write for new projects (called by instruction-templates' apply).
4. Project design system: on-disk layout, structural check, validation command, change proposal file.
5. The `design-md` kind readiness hook and the creation-time precondition for `role: require` at a first step.
6. Template workflow `design-system` (设计体系) and the template-workflow fallback generalisation.
7. Default frontend branch data: DESIGN.md slots, reads, spec/ship prompts, ship test declaration.
8. GSAP motion gate (hook + hidden CLI).

### Not owned (consumed; see §12 for requests)

| Item | Owner |
| --- | --- |
| `scope` / `role` slot fields, per-track `document_contract`, new kind registration, ledger path exception, record rules | workflow-io-openspec |
| `tests:` step schema, `tenon test run`, test direction store | test-evidence |
| Reviewer agents (`frontend-quality` content) and progressive skill loading | review-agents |
| Upstream install of `hue`, 8 `gsap-*` skills, `shadcn`, `magic-ui` | upstream-skills |
| Instruction templates, Library page shell, new project flow, shared builtin-sync helper | instruction-templates |
| `tenon` runner skill, removal of stage skills, remaining default migration | data-driven-runner |

### Explicitly not done

No MCP configuration of any kind (shadcn, Context7, Iconify, v0, Motion). No bundling of component, icon or animation
code. No visual animation editor (GSAP Standard license, `research/animation-and-popular-components.md:16-22`). No
design-status UI. No catalog CLI writes (Dashboard only). No semantic diff of design proposals (§8.5).

## 2. Resource entry format

### 2.1 File

One entry per file, file name `<id>.yaml`, max 64 KiB, UTF-8. Strict YAML subset (parsed by a narrow scanner like
`parse-document-contract.ts`): `key: scalar`, `key: [a, b]` inline lists of bare tokens, block lists (`- item`) for
`install`, exactly one nesting level for `license` and `links`, full-line `#` comments, scalars bare or double-quoted
(JSON escapes). Anything else is an error with a line number. The serializer writes this canonical form.

```yaml
schema: tenon-resource/v1
id: react-bits
name: React Bits
category: motion-components
frameworks: [react]
styling: [tailwind, css]
use: 文字动画、背景与交互动效
baseline: true
license:
  spdx: MIT AND LicenseRef-Commons-Clause
  url: https://raw.githubusercontent.com/DavidHDev/react-bits/main/LICENSE.md
  redistributable: false
  attribution: false
  commercial: freemium
  notice: "可在应用中使用；不得出售或再分发组件本身"
install:
  - npx shadcn@latest add https://reactbits.dev/r/<Name>-TS-TW
skills: []
links:
  home: https://reactbits.dev
  source: https://github.com/DavidHDev/react-bits
  registry: https://reactbits.dev/r
  llms_txt: https://reactbits.dev/llms.txt
verified_at: 2026-09-15
```

### 2.2 TypeScript (kernel `resources/types.ts`)

```ts
export const RESOURCE_CATEGORIES = ['components', 'blocks', 'icons', 'animation', 'motion-components',
  'design-md', 'state', 'styling'] as const
export const RESOURCE_FRAMEWORKS = ['web', 'react', 'next', 'vue', 'nuxt', 'angular', 'svelte',
  'react-native', 'flutter', 'swiftui', 'compose'] as const
export const RESOURCE_STYLING = ['tailwind', 'css', 'css-modules', 'sass', 'less', 'css-in-js',
  'vanilla-extract', 'unocss', 'panda', 'native'] as const
export const RESOURCE_LINK_KEYS = ['home', 'docs', 'source', 'registry', 'preview', 'design_md', 'mcp', 'llms_txt'] as const
export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number]
export type ResourceFramework = (typeof RESOURCE_FRAMEWORKS)[number]
export type ResourceStyling = (typeof RESOURCE_STYLING)[number]
export type ResourceLinkKey = (typeof RESOURCE_LINK_KEYS)[number]

export interface ResourceLicense {
  readonly spdx: string                     // SPDX expression or LicenseRef-*
  readonly url: string                      // https
  readonly redistributable: boolean
  readonly attribution: boolean
  readonly commercial: 'free' | 'freemium' | 'paid'
  readonly notice?: string                  // required when attribution or !redistributable
}
export interface ResourceEntry {
  readonly schema: 'tenon-resource/v1'
  readonly id: string                       // ^[a-z0-9][a-z0-9-]{1,62}$, equals file stem
  readonly name: string
  readonly category: ResourceCategory
  readonly frameworks: readonly ResourceFramework[]   // [] = any framework
  readonly styling: readonly ResourceStyling[]        // [] = any styling
  readonly use?: string                     // required for state / styling
  readonly baseline: boolean                // always rendered for matching frameworks
  readonly license: ResourceLicense
  readonly install: readonly string[]
  readonly skills: readonly string[]        // upstream skill ids agents load before using it
  readonly links: Readonly<Partial<Record<ResourceLinkKey, string>>>
  readonly verified_at: string              // YYYY-MM-DD
}
export type ResourceSource = 'builtin' | 'custom'
export interface StoredResource { readonly entry: ResourceEntry; readonly source: ResourceSource; readonly revision: string /* sha256 of file bytes */ }
export interface ResourceFileError { readonly file: string; readonly source: ResourceSource; readonly errors: readonly string[] }
export type ResourceLicenseMode = 'redistributable' | 'link-only' | 'attribution'
```

### 2.3 Kernel functions

```ts
// resources/parse.ts, serialize.ts, validate.ts (pure)
parseResourceEntry(text: string, fileName: string): ResourceEntry          // throws ResourceParseError(line, message)
serializeResourceEntry(entry: ResourceEntry): string
validateResourceEntry(entry: ResourceEntry, fileName: string): string[]

// resources/query.ts (pure, types-only imports; exported as '@tenon/kernel/resources/query')
export interface ResourceQuery { category?: ResourceCategory; framework?: ResourceFramework; styling?: ResourceStyling; license?: ResourceLicenseMode; text?: string }
filterResources<T extends { entry: ResourceEntry }>(items: readonly T[], query: ResourceQuery): T[]  // stable order: category order, then name
licenseModes(entry: ResourceEntry): readonly ResourceLicenseMode[]  // redistributable xor link-only, plus attribution

// resources/frontend-selection.ts (pure)
export interface FrontendResourceSelection {
  readonly framework: ResourceFramework
  readonly components?: string; readonly icons?: string; readonly state?: string; readonly styling?: string
  readonly animation?: string; readonly motionComponents?: readonly string[]; readonly blocks?: readonly string[]
  readonly designMd?: string
}
validateFrontendSelection(selection: FrontendResourceSelection, catalog: readonly ResourceEntry[]): string[]
renderFrontendResourceBlock(selection: FrontendResourceSelection, catalog: readonly ResourceEntry[]): string  // Markdown

// infrastructure/resource-catalog-store.ts (node fs)
resourceCatalogRoot(input?: ProductPathInput): string                      // <configRoot>/catalog
ensureBuiltinResources(opts: { payloadDir: string; storeRoot: string }): Promise<'unchanged' | 'synced'>
loadResourceCatalog(opts: { payloadDir: string; storeRoot: string }): Promise<{ resources: StoredResource[]; errors: ResourceFileError[] }>
readResourceFile(storeRoot: string, id: string): Promise<{ stored: StoredResource; yaml: string } | null>
writeCustomResource(storeRoot: string, id: string, yaml: string, revision?: string): Promise<StoredResource>  // ResourceStoreError(code)
copyResource(storeRoot: string, id: string): Promise<string>              // new custom id
deleteCustomResource(storeRoot: string, id: string, revision?: string): Promise<void>
```

`ResourceStoreError.code`: `invalid` (400) | `builtin-readonly` (409) | `conflict` (409) | `not-found` (404) | `duplicate` (409).

### 2.4 Filter semantics

- `category`, `framework`, `styling`: equality; an entry with an empty `frameworks` / `styling` list matches any value.
- `license`: `redistributable` ⇔ `license.redistributable`; `link-only` ⇔ `!redistributable`; `attribution` ⇔ `license.attribution`.
- `text`: case-insensitive substring over `id`, `name`, `use`.
- Acceptance probe: `{framework: react, styling: tailwind, category: icons}` returns lucide, heroicons, tabler-icons,
  phosphor, iconoir, radix-icons, material-symbols, font-awesome-free, iconify and nothing from another category.

## 3. Global store and builtin sync

```
<configRoot>/catalog/            (parent design §3)
  builtin/<id>.yaml              rewritten from payload; read-only
  builtin/.digest                tree-sha256 of payload templates/catalog/builtin
  custom/<id>.yaml               user entries; never touched by sync
```

- Payload source: `templates/catalog/builtin/*.yaml`, located like `skillSources.ts:30-32` (CLI) and the equivalent
  relative path from the server bundle.
- `ensureBuiltinResources` runs inside `loadResourceCatalog` under `withLock(storeRoot)` (same lock family as
  `projectRegistry.ts:45-49`): digest equal → no-op; otherwise write `builtin.staging-<pid>/`, rename old `builtin/` to
  `builtin.old-<pid>/`, rename staging to `builtin/`, remove old. Install and every update therefore take effect on the
  first read by the new release, without touching release activation code. If instruction-templates lands a shared
  builtin sync helper first, this call uses it (merge note, implement.md).
- Id uniqueness: a custom file whose id exists in builtin is reported in `errors` (`与内置资源 id 重复`) and excluded.
- Custom writes: `withLock(storeRoot)` → optional revision compare → validate → tmp + rename.
- Copy id: `<id>-copy`, then `<id>-copy-2`, … ; copy preserves every field.

## 4. Builtin catalog inventory

Ships as `templates/catalog/builtin/<id>.yaml`. Every license below must be re-verified against its `license.url`
when authoring (research marks several as not re-checked, `research/design-resources.md:36-44`); an entry whose license
cannot be verified is omitted, never guessed. `verified_at` = authoring date. Abbreviations: R = redistributable,
A = attribution, C = commercial (f free, fm freemium).

### 4.1 components (29)

| id | frameworks | styling | spdx | R | A | C | skills / notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| shadcn-ui | react, next | tailwind | MIT | ✓ | | f | `shadcn`; links.registry, links.mcp, links.llms_txt |
| radix-ui | react | css | MIT | ✓ | | f | |
| mui | react, next | css-in-js | MIT | ✓ | | fm | notice: MUI X Pro/Premium 商用收费 |
| ant-design | react | css-in-js | MIT | ✓ | | f | |
| chakra-ui | react | css-in-js | MIT | ✓ | | f | |
| mantine | react | css-modules | MIT | ✓ | | f | |
| heroui | react | tailwind | MIT | ✓ | | f | |
| headless-ui | react, vue | tailwind | MIT | ✓ | | f | |
| arco-design | react, vue | less | MIT | ✓ | | f | |
| semi-design | react | sass | MIT | ✓ | | f | |
| element-plus | vue | sass | MIT | ✓ | | f | |
| naive-ui | vue | css-in-js | MIT | ✓ | | f | |
| vuetify | vue | sass | MIT | ✓ | | f | |
| primevue | vue | tailwind, css | MIT | ✓ | | f | |
| ant-design-vue | vue | css-in-js | MIT | ✓ | | f | |
| shadcn-vue | vue, nuxt | tailwind | MIT | ✓ | | f | |
| nuxt-ui | nuxt, vue | tailwind | MIT | ✓ | | f | |
| angular-material | angular | sass | MIT | ✓ | | f | |
| primeng | angular | css, tailwind | MIT | ✓ | | f | |
| ng-zorro-antd | angular | less | MIT | ✓ | | f | |
| spartan-ui | angular | tailwind | MIT | ✓ | | f | |
| shadcn-svelte | svelte | tailwind | MIT | ✓ | | f | |
| skeleton | svelte | tailwind | MIT | ✓ | | f | |
| react-native-paper | react-native | native | MIT | ✓ | | f | |
| tamagui | react-native, react | native | MIT | ✓ | | f | |
| gluestack-ui | react-native | tailwind | MIT | ✓ | | f | |
| flutter-material | flutter | native | BSD-3-Clause | ✓ | | f | |
| compose-material3 | compose | native | Apache-2.0 | ✓ | | f | |
| swiftui | swiftui | native | LicenseRef-Apple-SDK | | | f | notice: 仅限 Apple 平台 SDK 使用 |

### 4.2 blocks (10)

| id | frameworks | styling | spdx | R | A | C | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| shadcn-registry | react, next | tailwind | MIT | ✓ | | f | links.registry `https://ui.shadcn.com/r/registries.json` |
| hyperui | web, react, vue | tailwind | MIT | ✓ | | f | |
| flowbite | web, react, vue, svelte, angular | tailwind | MIT | ✓ | | fm | notice: Pro 为 EULA，不在目录内 |
| preline | web, react, vue, angular | tailwind | MIT | ✓ | ✓ | f | notice: Fair Use 署名要求（按 license.url 原文） |
| tremor | react | tailwind | Apache-2.0 | ✓ | | f | |
| park-ui | react, vue | panda, tailwind | MIT | ✓ | | f | |
| daisyui | web | tailwind | MIT | ✓ | | f | |
| mantine-ui | react | css-modules | MIT | ✓ | | f | |
| tailadmin | react, vue, angular, next | tailwind | MIT | ✓ | | fm | notice: Pro 为商业许可 |
| v0-templates | react, next | tailwind | LicenseRef-v0-Community-Templates | | | f | notice: 无开源许可，仅浏览与链接 |

### 4.3 icons (11)

All `styling: []`. hue's icon kit pool (Phosphor, Lucide, Tabler, Iconoir, Material Symbols, Heroicons,
`~/.agents/skills/hue/references/icon-kits.md:27-154`) is fully covered, so DESIGN.md `icons:` always names an entry.

| id | frameworks | spdx | R | A | notes |
| --- | --- | --- | --- | --- | --- |
| lucide | web, react, vue, angular, svelte, react-native | ISC | ✓ | | |
| heroicons | web, react, vue | MIT | ✓ | | |
| tabler-icons | web, react, vue, svelte, angular | MIT | ✓ | | |
| phosphor | web, react, vue, flutter, swiftui | MIT | ✓ | | |
| iconoir | web, react, react-native, vue, flutter | MIT | ✓ | | |
| radix-icons | web, react | MIT | ✓ | | |
| bootstrap-icons | web | MIT | ✓ | | |
| material-symbols | web, react, angular, flutter, compose | Apache-2.0 | ✓ | | |
| font-awesome-free | web, react, vue, angular | CC-BY-4.0 AND OFL-1.1 AND MIT | ✓ | ✓ | notice: 图标 CC BY 4.0 署名 |
| iconify | web, react, vue, svelte | LicenseRef-Iconify-Per-Set | | | notice: 按所选图标集许可；links.docs `https://api.iconify.design/search?query=` |
| sf-symbols | swiftui | LicenseRef-Apple-SF-Symbols | | | notice: 仅限 Apple 平台 |

### 4.4 animation (7)

| id | frameworks | spdx | R | C | baseline | skills / notes |
| --- | --- | --- | --- | --- | --- | --- |
| gsap | web, react, next, vue, nuxt, svelte, angular | LicenseRef-GSAP-Standard | | f | ✓ | gsap-core, gsap-timeline, gsap-scrolltrigger, gsap-plugins, gsap-utils, gsap-react, gsap-performance, gsap-frameworks; install `pnpm add gsap @gsap/react`; notice: 免费商用；禁止用于与 Webflow 可视化动画构建竞争的工具 |
| motion | react, vue | MIT | ✓ | fm | notice: Motion+ 收费；links.mcp = AI Kit 文档（不自动配置） |
| animejs | web | MIT | ✓ | f | |
| auto-animate | web, react, vue, svelte, angular | MIT | ✓ | f | |
| react-spring | react, react-native | MIT | ✓ | f | |
| dotlottie | web, react, vue | MIT | ✓ | f | |
| rive | web, react, flutter, swiftui, compose | MIT | ✓ | fm | notice: 运行时 MIT，编辑器专有 |

### 4.5 motion-components (13)

All `styling: [tailwind]` unless noted.

| id | frameworks | spdx | R | A | C | baseline | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| react-bits | react | MIT AND LicenseRef-Commons-Clause | | | fm | ✓ | styling tailwind, css; §2.1 example |
| magic-ui | react, next | MIT | ✓ | | f | | skills `magic-ui` |
| motion-primitives | react | MIT | ✓ | | f | | |
| animate-ui | react | MIT | ✓ | | f | | |
| cult-ui | react | MIT | ✓ | | f | | |
| kokonut-ui | react | MIT | ✓ | | f | | |
| animata | react | MIT | ✓ | | f | | |
| eldora-ui | react | MIT | ✓ | | f | | |
| coss-ui | react | MIT | ✓ | | f | | notice: 仅 apps/ui 为 MIT，仓库其余部分 AGPL |
| inspira-ui | vue, nuxt | MIT | ✓ | | f | | |
| vue-bits | vue | MIT AND LicenseRef-Commons-Clause | | | fm | | styling tailwind, css |
| aceternity-ui | react, next | LicenseRef-Aceternity-UI | | | fm | | notice: 禁止再分发源码 |
| skiper-ui | react, next | LicenseRef-Skiper-UI | | ✓ | fm | | notice: 免费层需署名 |

### 4.6 state (14), `use` required

| id | frameworks | spdx | use |
| --- | --- | --- | --- |
| zustand | react, next | MIT | 小型全局状态 |
| redux-toolkit | react, next | MIT | 大型团队严格数据流 |
| jotai | react, next | MIT | 原子化状态 |
| mobx | react | MIT | 响应式对象模型 |
| tanstack-query | react, vue, svelte, angular | MIT | 服务端数据缓存 |
| pinia | vue, nuxt | MIT | 全局状态 |
| angular-signals | angular | MIT | 组件与服务状态 |
| ngrx | angular | MIT | 大型应用集中状态 |
| svelte-runes | svelte | MIT | 组件与共享状态 |
| riverpod | flutter | MIT | 依赖注入与状态 |
| bloc | flutter | MIT | 事件驱动状态 |
| android-viewmodel-stateflow | compose | Apache-2.0 | 界面状态 |
| swift-observation | swiftui | Apache-2.0 | 可观察模型 |
| tca | swiftui | MIT | 单向数据流 |

### 4.7 styling (10), `use` required; each entry's own `styling` lists the value it represents

| id | frameworks | styling | spdx | use |
| --- | --- | --- | --- | --- |
| tailwindcss | web, react, next, vue, nuxt, angular, svelte | tailwind | MIT | 原子类 |
| css-modules | react, next, vue | css-modules | MIT | 局部作用域 CSS |
| sass | [] | sass | MIT | 预处理 |
| styled-components | react | css-in-js | MIT | 运行时 CSS-in-JS |
| emotion | react | css-in-js | MIT | 运行时 CSS-in-JS |
| vanilla-extract | react, vue, svelte | vanilla-extract | MIT | 零运行时类型化样式 |
| unocss | web, vue, react, svelte | unocss | MIT | 按需原子类 |
| panda-css | react, vue, svelte | panda | MIT | 零运行时 CSS-in-JS |
| less | web, react, vue, angular | less | Apache-2.0 | 旧版 Ant Design 主题 |
| nativewind | react-native | tailwind | MIT | Tailwind 语法 |

### 4.8 design-md (2 + all awesome-design-md brands)

| id | spdx | R | notes |
| --- | --- | --- | --- |
| design-md-spec | Apache-2.0 | ✓ | Google Labs design.md format; links.source |
| awesome-design-md | MIT | ✓ | index; install `npx getdesign@latest list` |
| `design-md-<slug>` × every folder in `VoltAgent/awesome-design-md/design-md/` | MIT | ✗ | notice: 品牌视觉归各公司所有，仅作参考起步；links.design_md = raw GitHub URL of that folder's `DESIGN.md`; install `npx getdesign@latest add <slug>`; frameworks [] |

Brand entries are produced by `tools/generate-design-md-catalog.mjs` (network, run manually, output committed): list
the folder via the GitHub contents API, `HEAD` each raw `DESIGN.md` (skip non-200), write one file per slug with
`name` = folder title, `verified_at` = run date. Not run in CI.

Totals ≈ 96 + brand entries (research counts ~117 folders, `research/design-resources.md:16-18`).

## 5. License gate

| Rule | Where enforced |
| --- | --- |
| Closed field set; unknown keys rejected → an entry cannot carry code, icons or templates | `validateResourceEntry` |
| `templates/catalog/builtin/` contains only `*.yaml` | `resources/builtin-catalog.test.ts` |
| `attribution: true` or `redistributable: false` ⇒ `license.notice` required | validator |
| Detail pill 仅链接 for `!redistributable`; no copy-to-project action exists anywhere | Dashboard |
| Frontend block adds a 仅链接 line and every `notice` of selected + baseline entries | `renderFrontendResourceBlock` |
| DESIGN.md seed is fetched to the user's project at selection time, never shipped in the payload | §7.3 |
| GSAP library code never bundled; projects install `gsap` / `@gsap/react` | entry `install` |

## 6. Consumers of the catalog

### 6.1 CLI (R5)

```
tenon resources list [--category <c>] [--framework <f>] [--styling <s>] [--license redistributable|link-only|attribution] [--query <text>] [--json]
tenon resources show <id> [--json]
```

- Registered in new `packages/cli/src/program-resources.ts` (pattern of `program-tracks.ts`, called from `program.ts`).
- `list` text: columns `id  类别  许可  名称`, one row per entry, `filterResources` order. `--json`:
  `{ "entries": ResourceEntry[], "errors": ResourceFileError[] }`.
- `show` prints every field, license line `SPDX · 仅链接|可再分发 · 免费|部分收费|收费`, `notice`, install, skills, links.
- Exit 1: unknown enum value (`--framework 只接受：web, react, …`), unknown id (`未知资源：<id>`), store read failure.

### 6.2 HTTP routes (server)

Global, no `root` query. Mutations require Host guard + token exactly like `serverMutationRoutes.ts` (token check at
`:18`, PUT table at `:302`).

| Method / path | Body | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/resources` | — | `{ schema_version: 'resource-catalog/v1', entries: ResourceDto[], errors: ResourceFileError[] }` | 500 |
| `GET /api/resources/:id` | — | `{ entry: ResourceDto, yaml: string }` | 404 |
| `PUT /api/resources/:id` | `{ yaml: string, revision?: string }` | `{ ok: true, entry: ResourceDto }` (create or update custom) | 400 `{ok:false, errors}` · 409 builtin/conflict/duplicate · 413 > 64 KiB |
| `POST /api/resources/:id/copy` | — | `{ ok: true, id }` | 404 |
| `DELETE /api/resources/:id?revision=` | — | `{ ok: true }` | 404 · 409 builtin/conflict |
| `POST /api/design/seed` | `{ root: string, resource: string }` | `{ ok: true, path: 'DESIGN.md' }` | 400 wrong category · 403 unregistered root · 409 exists · 502 fetch failed |

`ResourceDto = ResourceEntry & { source: ResourceSource; revision: string }`. Handlers live in new
`packages/server/src/serverResourceRoutes.ts`; dispatch lines are added to `serverGetRoutes.ts` (next to `/api/workflows`,
`:282`), `serverMutationRoutes.ts` (PUT/DELETE tables) and `serverPostRoutes.ts`. `:id` validated with the entry id regex
before any fs access.

### 6.3 Dashboard 资源目录 (R3)

Lives in the Library page shell built by instruction-templates (parent §7). The Library rail item is `资源目录`.

Files (`packages/dashboard-app/src/library/resources/`):

| File | Role |
| --- | --- |
| `api/resourceClient.ts`, `api/resourceTypes.ts` | fetch + closed-shape decoder (pattern `definitionCatalogClient.ts:4-50`) |
| `library/resources/useResourceCatalog.ts` | load once, keep query state, call `filterResources` from `@tenon/kernel/resources/query` |
| `library/resources/ResourceList.tsx` | list column |
| `library/resources/ResourceDetail.tsx` | detail column |
| `library/resources/ResourceEditorDrawer.tsx` | YAML editor in `shared/Drawer.tsx` |
| `library/resources/resourceLabels.ts` | enum → i18n key; framework/styling proper names |

List column: search input (`res-search`, placeholder `搜索`), four single-select chip rows `res-facet-category|framework|styling|license`
(`role=tablist`, `whitespace-nowrap overflow-x-auto`, first chip `全部`), trailing `+ 资源` (`res-new`). Rows `res-row-<id>`:
name (truncate, `title`), category pill, license pill (`可再分发` / `仅链接`), `内置` / `自定义` marker; invalid files render
`res-row-invalid-<file>` with pill `无效`.

Detail column (`DetailColumn`): eyebrow = category word, H1 = name, mono slug = id, one `StatusPill` = license mode.
Noun sections in order: 许可 (SPDX, 再分发, 署名, 收费, 声明, link), 安装 (mono lines + copy icon), 链接 (icon buttons
`res-link-<key>`: 官网 文档 源码 注册表 预览 DESIGN.md MCP llms.txt, `target=_blank rel=noreferrer`), 技能, 框架, 样式, 场景,
核验. Footer: 复制 (always), 编辑 + 删除 (custom only; delete uses `Dialog` with title `删除「{name}」`). Invalid file detail
shows the error strings only.

Editor drawer: mono textarea (`res-yaml`), server error list under it, 保存 (`res-save`, disabled without token like
`getToken() === ''` rule in component-guidelines), 取消. New resource starts from a skeleton with `schema`, `id`, `name`,
`category`, empty lists and today's `verified_at`. 409 conflict shows `资源已在磁盘上被修改，重新载入` and a 重新载入 action.

i18n: new `resources` namespace in both locales of `packages/dashboard-app/src/i18n/translations.ts`:
`title 资源目录, search 搜索, all 全部, new 资源, copy 复制, edit 编辑, delete 删除, save 保存, cancel 取消, reload 重新载入,
invalid 无效, empty 无资源, delete_title 删除「{name}」, conflict …, facet.{category 类别, framework 框架, styling 样式, license 许可},
category.{components 组件库, blocks 区块, icons 图标, animation 动画, motion-components 动效组件, design-md DESIGN.md,
state 状态管理, styling 样式}, license_mode.{redistributable 可再分发, link-only 仅链接, attribution 需署名},
commercial.{free 免费, freemium 部分收费, paid 收费}, source.{builtin 内置, custom 自定义},
section.{license 许可, install 安装, links 链接, skills 技能, frameworks 框架, styling 样式, use 场景, verified 核验},
field.{spdx SPDX, redistributable 再分发, attribution 署名, commercial 收费, notice 声明}, link.{home 官网, docs 文档,
source 源码, registry 注册表, preview 预览, design_md DESIGN.md, mcp MCP, llms_txt llms.txt}, yes 是, no 否`.
No `*_desc` / `*_note` / `*_hint` keys.

### 6.4 Frontend instruction block (R4)

instruction-templates owns templates and the new-project flow. Its frontend block inserts
`renderFrontendResourceBlock(selection, catalog)` when a selection exists; its 选资源 step reads `GET /api/resources`
and offers, for the chosen framework, one each of components / icons / state / styling / animation, any number of
motion-components and blocks, and at most one design-md. Baseline entries (`gsap`, `react-bits` for react) are always
included for matching frameworks and cannot be deselected.

`validateFrontendSelection` errors: `未知资源：<id>` · `<id> 不属于类别 <category>` · `<id> 不适用于 <framework>` ·
`组件库 <id> 与样式 <id> 不兼容` (both styling lists non-empty and disjoint).

Rendered block (zh-CN; stable order; table + rules):

```markdown
### 前端资源

| 类别 | 选择 | 安装 | 许可 |
| --- | --- | --- | --- |
| 组件库 | shadcn/ui | `pnpm dlx shadcn@latest init` | MIT |
| 图标 | Lucide | `pnpm add lucide-react` | ISC |
| 状态管理 | Zustand | `pnpm add zustand` | MIT |
| 样式 | Tailwind CSS | `pnpm add tailwindcss @tailwindcss/vite` | MIT |
| 动画 | GSAP | `pnpm add gsap @gsap/react` | GSAP Standard（仅链接） |
| 动效组件 | React Bits | `npx shadcn@latest add https://reactbits.dev/r/<Name>-TS-TW` | MIT + Commons Clause（仅链接） |

- UI 工作遵循项目根目录 `DESIGN.md`：颜色、字体、间距、圆角、阴影、动效只用其中令牌；图标只用 Lucide。
- 编写或评审动画前先加载技能 gsap-core；React 另加 gsap-react，滚动动画加 gsap-scrolltrigger，性能问题加 gsap-performance。
- 查找组件与图标：`tenon resources list --framework react --category <components|icons|motion-components|blocks>`；在线来源见 `tenon resources show <id>` 的链接（注册表、llms.txt、Iconify 搜索）。
- 仅链接资源（GSAP、React Bits）：通过安装命令在本项目使用，不把其源码作为独立组件库、模板或工具再分发。
- 署名：<notice>                       ← one line per selected entry with attribution
- 设计变更：规格步骤写 `openspec/changes/<change>/design-system.md`，交付步骤合并回 `DESIGN.md`。
```

The DESIGN.md line is emitted when a design-md entry is selected or the project already has `DESIGN.md`; the design
change line only when the project uses Tenon tasks (always true for instruction-templates output).

## 7. Project design system

### 7.1 On-disk layout (repo root, versioned with the project)

```
DESIGN.md                        the design system; what agents and instruction files point to
design/
  design-model.yaml              hue Phase 7 model, schema unchanged (single source of truth)
  direction.md                   confirmed direction + core tokens (design-system step 方向)
  preview.html                   hue Phase 10
  component-library.html         hue Phase 11
  landing-page.html              hue Phase 12
  app-screen.html                hue Phase 13
openspec/changes/<change>/design-system.md    per-change proposal (§7.5)
```

Why: a single root `DESIGN.md` matches how hosts and awesome-design-md/getdesign consume design files
(`research/design-resources.md:18-23`); hue's four generated Markdown files are merged into it so one read gives the
whole system; hue's model and previews stay intact under `design/` so hue iteration ("edit the model first, regenerate
affected files", `~/.agents/skills/hue/SKILL.md:657-660`) and `validate.mjs <folder>` work unchanged. No `SKILL.md` is
written, so hue's frontmatter check is skipped by design (`validate.mjs:248-253`) and no host loads the design as a skill.

### 7.2 DESIGN.md contract

```markdown
---
schema: tenon-design/v1
model: design/design-model.yaml
icons: <resource id, category icons>
---

# <Name> Design System
## 1. Philosophy          hue skill-template §1 + 5–7 principles
## 2. Craft Rules         hue skill-template §2
## 3. Anti-Patterns       hue skill-template §3 (8–12 "No …")
## 4. Tokens              hue tokens-template: fonts, 7-step type scale, primitives, light/dark semantic, status, spacing, radii, elevation, motion
## 5. Iconography         observed_style + fallback kit = the `icons` resource
## 6. Hero Stage          hue hero_stage recipe
## 7. Components          hue components-template sections (buttons … state patterns)
## 8. Voice               tone + samples
## 9. Platform Mapping    hue platform-mapping-template: CSS variables, SwiftUI, Tailwind
## 10. Previews           relative links to the four design/*.html files
```

Headings are fixed English (hue's own vocabulary; checker is locale-free); body language is free.

```ts
// kernel design-system/check.ts (pure; reader port implemented in infrastructure/design-system-fs.ts)
export const DESIGN_SCHEMA = 'tenon-design/v1'
export const DESIGN_SECTIONS = ['Philosophy', 'Craft Rules', 'Anti-Patterns', 'Tokens', 'Iconography', 'Hero Stage',
  'Components', 'Voice', 'Platform Mapping', 'Previews'] as const
export const DESIGN_PREVIEWS = ['design/preview.html', 'design/component-library.html', 'design/landing-page.html', 'design/app-screen.html'] as const
export type DesignSystemStatus = 'missing' | 'seed' | 'incomplete' | 'ready'
export interface DesignFileReader { read(relativePath: string): string | null }
export interface DesignSystemCheck { readonly status: DesignSystemStatus; readonly problems: readonly string[] }
checkDesignSystem(reader: DesignFileReader, iconIds: ReadonlySet<string>): DesignSystemCheck
```

| Status | Condition |
| --- | --- |
| missing | no `DESIGN.md` |
| seed | `DESIGN.md` without front matter `schema: tenon-design/v1` (e.g. an awesome-design-md brand file) |
| incomplete | marker present and any problem below |
| ready | marker present, no problem |

Problems (exact strings): `model 必须是 design/design-model.yaml` · `缺少 design/design-model.yaml` ·
`design-model.yaml 缺少顶层键 <name|primitives|tokens|components>` · `icons 必须是资源目录中的图标：<id>` ·
`缺少章节 ## <n>. <Section>` · `章节顺序错误：<Section>` · `缺少预览 <path>` · `Previews 未链接 <path>` ·
`DESIGN.md 含占位内容 <{{|TODO|FIXME|lorem ipsum>` · `DESIGN.md 含 em-dash（hue 硬性规则）`.

### 7.3 Lifecycle

| Moment | What happens | Enforced by |
| --- | --- | --- |
| New project with a design-md resource | `POST /api/design/seed` writes the brand file as root `DESIGN.md` (status seed) | instruction-templates apply calls it |
| 设计体系 task (`tenon init <n> --workflow design-system --track free --preset <p>`) | 方向 → 生成 → 预览; seed, if present, is hue Remix input read as data | template workflow §9.1 |
| Frontend task creation (default `frontend` branch) | `DESIGN.md` must be `ready` | §7.4 precondition |
| build / verify | `design-md` in `reads` | workflow-io-openspec reads |
| spec needs a design change | `tenon design propose <change>` creates the proposal; reviewed by the spec review gate | step prompt |
| ship | agent merges proposal into model, regenerates affected sections/previews, records `design-md` (`role: update`), required test `design-system` passes | test-evidence + `tenon design validate` |
| Other workflows / tracks | any step may declare `design-md` produce / update / require | slots (example below) |

Product track defining its own system at build (customisation example; default pm branch is not changed):

```yaml
  pm:
    label: 产品
    document_contract:
      version: v1
      slots:
        - kind: design-md
          owner_step: build
          producers: [hue]
          scope: project
          role: produce
      reads:
        - step: verify
          kinds: [design-md]
```

### 7.4 Creation precondition (`role: require` at the first step)

```ts
// kernel design-system/precondition.ts
export interface ProjectDocumentKindSpec {
  readonly kind: 'design-md'
  readonly paths: readonly string[]                  // ['DESIGN.md', 'design/design-model.yaml']
  readiness(root: string): DesignSystemCheck
}
export class ProjectDocumentPreconditionError extends Error { readonly kind: string; readonly status: DesignSystemStatus }
assertCreationPreconditions(plan: EffectiveWorkflowPlan, repoRoot: string, specs: readonly ProjectDocumentKindSpec[]): void
```

- Reads the selected branch's slots (`plan.workflow` document contract, including per-track contracts delivered by
  workflow-io-openspec); for every slot with `scope: project`, `role: require`, `ownerStep === plan.workflow.steps[0].id`,
  runs the kind's `readiness`; any status other than `ready` throws.
- Called in `cmdInit` right after `loadEffectiveWorkflowPlan` (`init.ts:207`) → `ERROR: …` exit 1, nothing written; and in
  the create-change route right after plan load (`serverPostChangesRoutes.ts:208`) → 400 `{ ok:false, error }`.
- Message: `工作流 <workflow> 轨道 <track> 要求项目 DESIGN.md 就绪（当前：<缺失|起步|不完整>）；先完成设计体系任务：tenon init <name> --workflow design-system --track free --preset <preset>`
  followed by up to 5 problems, one per line.
- Existing changes are unaffected (frozen snapshots).

### 7.5 Change proposal

`tenon design propose <change>` writes `openspec/changes/<change>/design-system.md` if absent:

```markdown
---
schema: tenon-design-proposal/v1
change: <change>
base: sha256:<hex>          # sha256(DESIGN.md bytes ‖ design/design-model.yaml bytes) at propose time
---

# 设计变更

## 修改

## 理由

## 影响
```

`tenon design validate` with a change context fails `设计变更未合并：按 openspec/changes/<c>/design-system.md 更新
design/design-model.yaml 与 DESIGN.md` when the proposal exists and the current combined digest equals `base`.
Known limit (recorded decision): a digest change does not prove the proposal's content was merged; that is judged by the
human spec review and the ship record's diff.

### 7.6 Commands

```
tenon design check [--json]                   # structural, no spawn, exit 0 ready / 1 otherwise
tenon design validate [--change <change>]     # check must be ready → hue validate.mjs design/ → proposal merge check
tenon design propose <change>                 # §7.5
```

- `validate` locates `<pluginRoot>/skills/hue/scripts/validate.mjs` (plugin root resolved like `skillSources.ts:30-32`);
  missing → exit 1 `hue 技能未安装：<path>；运行 tenon update 同步上游技能`. Spawns `node <script> <repo>/design` with
  the repo as cwd, streams its output, exit 1 on non-zero. hue's own `npx js-yaml` SKIP is not a failure.
- `--change` defaults to `TENON_CHANGE_NAME` from the environment; no change context → merge check skipped.
- `check --json`: `{ "status": "...", "problems": [...] }`.
- The validator path is injectable through `CliDeps` for tests; tests never spawn `npx`.

### 7.7 Directing upstream hue

hue is installed verbatim by upstream-skills; Tenon never patches it. Direction is data in the workflow step `prompt`
(types.ts:175-176), relying on hue's "If the user specifies a different path, use that" (`SKILL.md:541-542`). The
design-system `生成` prompt (§9.1) states the exact file mapping, forbids writing `SKILL.md` or any skill directory, and
skips hue Phase 16. Icon kit choice is constrained to `tenon resources list --category icons`.

## 8. GSAP enforcement (R2 动画)

### 8.1 Motion gate (hook)

- `hooks/gate.sh`, after `TOOL` is known (`:60`), pure bash candidate test, no fork for non-candidates:

  ```bash
  case "$TOOL" in
    Write|Edit|MultiEdit|NotebookEdit|apply_patch)
      case "$INPUT" in *gsap*|*GSAP*|*ScrollTrigger*|*useGSAP*) pipeline_enforce_motion_gate || exit 2 ;; esac ;;
  esac
  ```

  `pipeline_enforce_motion_gate` resolves the active change exactly like `pipeline_enforce_skill_gate` (`:370-388`), returns 0
  when none, then pipes `$INPUT` to `node <bundle> internal-motion-gate <change>` from the project root; only exit 2 blocks.
  Unlike the skill gate it runs for `default` too (the GSAP rule is not workflow-specific).
- `tenon internal-motion-gate <change>` (hidden; `packages/cli/src/commands/internalMotionGate.ts`):

  ```ts
  requiredGsapSkills(toolInput: string): readonly string[]
  cmdInternalMotionGate(deps: CliDeps, change: string, stdin: string): Promise<0 | 2>
  ```

  | Marker in tool input | Adds |
  | --- | --- |
  | any candidate | gsap-core |
  | `@gsap/react`, `useGSAP` | gsap-react |
  | `ScrollTrigger`, `ScrollSmoother` | gsap-scrolltrigger |
  | `.timeline(` | gsap-timeline |
  | `Flip`, `Draggable`, `SplitText`, `MorphSVGPlugin`, `DrawSVGPlugin`, `MotionPathPlugin`, `Observer`, `InertiaPlugin`, `CustomEase` | gsap-plugins |
  | file path ending `.vue` or `.svelte` | gsap-frameworks |

  Evidence = skills completed since the latest entry into the current step, from the shared helper extracted from
  `internalSkillGate.ts:46-84,165-180` into `packages/cli/src/commands/stepSkillEvidence.ts` (`Skill:` and
  `CodexSkillRead:` rows), compared with namespace-insensitive equality (`skillsEquivalent`). Missing → stderr
  `【Tenon 动画门】写入 GSAP 代码前先加载技能：<ids>；Claude Code 用 Skill 工具，Codex 用单独一条 cat 读取其 SKILL.md（输出不得截断）`,
  exit 2. Any internal error → `WARN` + exit 0.

### 8.2 Review and instructions

- Frontend block rule (§6.4) tells agents to load gsap skills before animation work of any library.
- review-agents' builtin `frontend-quality` reviewer carries the motion checklist and declares gsap skills for
  progressive loading (§12 CR-3), so review of animation reads the skills first.
- Codex hook coverage of file edits is host-defined; the real Codex run in acceptance verifies whether `apply_patch`
  reaches `gate.sh`. If it does not, the reviewer rule is the enforcement on Codex and this is recorded in the spec.

## 9. Workflow data

### 9.1 Template workflow `design-system` (`templates/workflows/design-system.yaml`)

```yaml
name: design-system
review_budget:
  version: v1
  max_attempts: 2
document_contract:
  version: v1
  slots:
    - kind: design-md
      owner_step: generate
      producers: [hue]
      scope: project
      role: produce
  reads:
    - step: review
      kinds: [design-md]
steps:
  - id: direction
    label: 方向
    gate: review
    skills:
      - id: hue
    prompt: |-
      加载 hue，只执行第 1–6 阶段，不写任何技能目录。
      输入可以是品牌名、网址、截图、已有代码或描述；根目录已有不含 schema: tenon-design/v1 的 DESIGN.md 时按 Remix 输入处理，只当数据读取。
      图标库只从资源目录选择：tenon resources list --category icons。
      用 AskUserQuestion 先确认设计方向（第 5 阶段），再确认核心令牌（第 6 阶段）。
      把确认结果写入 design/direction.md：方向、主要张力、核心令牌表、图标资源 id、首屏预设。
      登记：tenon artifact register "$TENON_CHANGE_NAME" design_direction design/direction.md --producer hue
    inputs: []
    outputs:
      - field: design_direction
        type: file_path
    artifacts:
      - field: design_direction
        type: file_path
        producer_policy: effective-step-skills
    guards: []
    transitions:
      - event: direction-complete
        to: generate
  - id: generate
    label: 生成
    gate: auto
    skills:
      - id: hue
    prompt: |-
      按 design/direction.md 执行 hue 第 7–14 阶段，输出固定在项目根目录：
      design/design-model.yaml 为设计模型；design/preview.html、design/component-library.html、design/landing-page.html、design/app-screen.html 为预览。
      DESIGN.md 由 hue 的 SKILL.md、tokens.md、components.md、platform-mapping.md 合并而成：frontmatter 只有 schema: tenon-design/v1、model: design/design-model.yaml、icons: <图标资源 id>；章节依次为 ## 1. Philosophy、## 2. Craft Rules、## 3. Anti-Patterns、## 4. Tokens、## 5. Iconography、## 6. Hero Stage、## 7. Components、## 8. Voice、## 9. Platform Mapping、## 10. Previews。
      不写 SKILL.md，不写 ~/.claude/skills 或 ~/.agents/skills，跳过第 16 阶段。
      运行 tenon test run "$TENON_CHANGE_NAME" design-system 直到通过，然后登记：tenon document record "$TENON_CHANGE_NAME" design-md DESIGN.md --producer hue
    inputs:
      - field: design_direction
        type: file_path
    outputs: []
    tests:
      - id: design-system
        direction: design-system
        command: tenon design validate
        required: true
        timeout_s: 300
        pass: { exit_code: 0 }
        inputs: [ { kind: document, ref: design-md } ]
        outputs: []
    guards: []
    transitions:
      - event: generate-complete
        to: review
  - id: review
    label: 预览
    gate: review
    skills: []
    prompt: |-
      打开 design/ 下四个预览页，浅色与深色都检查；Codex 没有浏览器时把四个绝对路径交给用户。
      需要调整时发送 review-changes 回到生成：先改 design/design-model.yaml，再只重新生成受影响的文件。
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: review-changes
        to: generate
```

- `review` ends the task through the implicit `archived` edge (its loop back to `generate` reaches it again,
  `workflow-track-branches.md:64-71`). Two human confirmations (direction, core tokens) happen inside 方向 and are sealed by
  its review gate; the deterministic check is the required test; 预览 is the preview review (R8).
- Template mechanism: new `packages/kernel/src/workflow/template-workflows.ts` —
  `TEMPLATE_WORKFLOW_NAMES = ['default', 'design-system']`, `templateWorkflowSource(name): string | undefined`,
  `isTemplateWorkflowName(name)` (also exported from `workflow/identifier.ts` for the Dashboard). Sources come from the
  generated file (`tools/generate-default-workflow.mjs` also emits `DESIGN_SYSTEM_WORKFLOW_SOURCE`). Resolution:
  `loadWorkflow` falls back to the template after project and global files (`loadWorkflow.ts:27-29`);
  `serverGetRoutes.ts:331-334` falls back through `templateWorkflowSource`; the workflow index lists template names with
  source `builtin` when no override exists; Dashboard `恢复内建` checks `isTemplateWorkflowName` instead of
  `isDefaultWorkflowName`. `default` keeps its phase-manifest compile path (`effective-plan.ts:318-322`).

### 9.2 Default `frontend` branch additions (`templates/workflows/default.yaml:284-430`)

```yaml
  frontend:
    label: 前端
    document_contract:
      version: v1
      slots:
        - kind: design-md
          owner_step: open
          scope: project
          role: require
        - kind: design-md
          owner_step: ship
          producers: [hue]
          scope: project
          role: update
      reads:
        - step: build
          kinds: [design-md]
        - step: verify
          kinds: [design-md]
    steps:
      # spec step gains:
        prompt: |-
          需要新增或调整设计时运行 tenon design propose "$TENON_CHANGE_NAME"，在 openspec/changes/<change>/design-system.md 写清修改、理由、影响，随规格评审。
      # ship step gains:
        prompt: |-
          存在 openspec/changes/<change>/design-system.md 时：加载 hue，先改 design/design-model.yaml，再只重新生成 DESIGN.md 受影响章节与预览，登记 tenon document record "$TENON_CHANGE_NAME" design-md DESIGN.md --producer hue。
        tests:
          - id: design-system
            direction: design-system
            command: tenon design validate
            required: true
            timeout_s: 300
            pass: { exit_code: 0 }
            inputs: []
            outputs: []
```

Only these lines change in `default.yaml`; skill lists belong to data-driven-runner. `check:default-skill-matrix` is
unaffected (no skill added).

## 10. Data flow

```
templates/catalog/builtin/*.yaml ──(first read by a release)──▶ <configRoot>/catalog/builtin
                                                            ▲ custom/ (Dashboard PUT/COPY/DELETE)
loadResourceCatalog ─▶ CLI tenon resources · GET /api/resources ─▶ Dashboard (filterResources client-side)
                    ─▶ instruction-templates 选资源 ─▶ renderFrontendResourceBlock ─▶ CLAUDE.md / AGENTS.md
                    ─▶ POST /api/design/seed ─▶ <repo>/DESIGN.md (seed)
design-system task: 方向(hue 1–6, review) ─▶ 生成(hue 7–14 → DESIGN.md + design/, test tenon design validate, record design-md) ─▶ 预览(review) ─▶ 完结
frontend task: create ─▶ assertCreationPreconditions(checkDesignSystem) ─▶ … build/verify read design-md
             ─▶ spec: tenon design propose ─▶ ship: merge + record + test (proposal merge check)
Write/Edit containing gsap ─▶ gate.sh ─▶ internal-motion-gate ─▶ step skill evidence ─▶ allow | block
```

## 11. Validation and error matrix

| Condition | Result |
| --- | --- |
| Entry YAML outside the subset / unknown key | parse error `第 <n> 行：<detail>`; builtin → test fails; custom → `errors[]`, 400 on PUT |
| `schema` wrong | `schema 必须是 tenon-resource/v1` |
| id invalid or ≠ file stem / URL id | `id 必须匹配 ^[a-z0-9][a-z0-9-]{1,62}$` · `id 必须与文件名一致` · 400 `id 与 URL 不一致` |
| category / framework / styling unknown | `<field> 只接受：<values>` |
| license.url or any link not https | `<field> 必须是 https 链接` |
| no home/docs/source link | `links 至少需要 home、docs 或 source` |
| attribution or not redistributable without notice | `license.notice 必填` |
| state/styling without use | `use 必填` |
| design-md without links.design_md | `links.design_md 必填` |
| verified_at not `YYYY-MM-DD` | `verified_at 必须是日期` |
| custom id equals builtin id | `errors[]` `与内置资源 id 重复`; PUT 409 |
| PUT/DELETE builtin | 409 `内置资源只读，先复制` |
| revision mismatch | 409 `资源已在磁盘上被修改，重新载入` |
| PUT body > 64 KiB | 413 |
| mutation without token | same status as existing mutation routes |
| seed: resource not design-md | 400 `<id> 不是 DESIGN.md 资源` |
| seed: DESIGN.md exists | 409 `DESIGN.md 已存在` |
| seed: fetch non-2xx / >512 KiB / timeout 10 s / not https | 502 `DESIGN.md 获取失败：<reason>` |
| builtin sync fails mid-way | old `builtin/` kept (rename order), error surfaces in read, custom untouched |
| selection invalid | §6.4 strings; instruction-templates shows them and blocks apply |
| `tenon design check` not ready | exit 1, status + problems |
| hue validator missing / exits non-zero | exit 1 with message / hue output |
| proposal unmerged | exit 1 `设计变更未合并：…` |
| frontend task creation with DESIGN.md not ready | CLI exit 1 / HTTP 400, message §7.4, no change directory |
| GSAP write without skills | exit 2 message §8.1 |
| motion gate internal error | WARN, allow |

## 12. Contract change requests (parent and siblings are not edited)

- **CR-1 workflow-io-openspec**
  1. Register kind `design-md` with `scope: project`; ledger digest = `sha256(DESIGN.md ‖ design/design-model.yaml)`;
     `document-path.ts:267-269` accepts exactly `DESIGN.md` for project-scope kinds.
  2. `scope: project` slots are governed whether or not the workflow sets `openspec: true` (DESIGN.md is not an OpenSpec document).
  3. For `default`, a branch's `document_contract` slots/reads merge onto `LEGACY_DOCUMENT_GOVERNANCE_POLICY` for that track
     (today `document-contract.ts:141-143` ignores them).
  4. `producers` optional for `role: require`; the same kind may appear in several slots with different owner steps.
  5. Roles: `produce` = record required in the owner step visit; `update` = allowed producer, not required; `require` = no
     record by agents. Recording a project kind fails unless `ProjectDocumentKindSpec.readiness` is `ready`
     (`DESIGN.md 未就绪：<problems>`). Creation with a `require` slot writes a baseline ledger row
     `{kind, path, sha256, producer: 'project-baseline'}` so `reads` bind a digest and turn stale when DESIGN.md changes.
  6. Parse and serialize slot keys `scope` and `role` in block form (as used in §9).
- **CR-2 test-evidence**: builtin direction `config/test-directions/builtin/design-system.yaml`
  (`id: design-system, label: 设计体系, command: tenon design validate, timeout_s: 300, pass: {exit_code: 0},
  inputs: [{kind: document, ref: design-md}], outputs: []`); the runner exports `TENON_CHANGE_NAME` to the child process.
- **CR-3 review-agents**: builtin `frontend-quality` agent declares skills `gsap-core, gsap-react, gsap-performance`
  (progressive) and adds section `## 动效`: useGSAP / gsap.context scoping and cleanup on unmount; ScrollTrigger kill on
  route change and refresh after layout change; `gsap.matchMedia` for `prefers-reduced-motion`; animate transform and
  opacity only; durations and easing from `DESIGN.md` `## 4. Tokens`; plus `## 设计体系`: tokens, icons and components
  match `DESIGN.md`.
- **CR-4 upstream-skills**: `skills/sources.yaml` includes `hue` (dominikmartn/hue, whole tree incl. `scripts/`,
  `references/`), the 8 skills of greensock/gsap-skills (`skills/<name>`), `magic-ui`; `shadcn` already listed. The old
  `skills/hue` stub and its `templates/skill-sources.yaml:49` row are removed there.
- **CR-5 instruction-templates**: frontend blocks call `renderFrontendResourceBlock`; 选资源 uses `GET /api/resources`
  and `validateFrontendSelection`; apply calls the seed writer inside its preview/apply so `DESIGN.md` appears in the diff;
  Library page exposes a `资源目录` rail item hosting §6.3; if it provides a shared builtin sync helper, it accepts
  `{payloadDir, storeRoot}` as in §3.
- **CR-6 data-driven-runner**: keep §9.2 prompts/tests when migrating default; pass step `prompt` to the agent; the
  deleted stage skills take their DESIGN.md prose with them (`skills/tenon-build/SKILL.md:150-153`, `skills/tenon/SKILL.md:414`).
- **CR-7 parent design §3/§7 wording only**: on disk the store stays `config/catalog/`; code module, routes and CLI
  are named `resources` because `catalog` already names the definition catalog. No contract change is required if the
  parent accepts this naming note.

## 13. Tests required

| File | Assertion points |
| --- | --- |
| `packages/kernel/src/resources/parse.test.ts` | §2.1 example round-trips byte-identical through serialize; quoted scalar with `:` kept; inline `install` rejected with line; unknown key line number; 64 KiB limit |
| `packages/kernel/src/resources/validate.test.ts` | one case per validator row in §11 |
| `packages/kernel/src/resources/query.test.ts` | empty frameworks/styling match any; license modes incl. attribution; text search over id/name/use; §2.4 acceptance probe ids exactly |
| `packages/kernel/src/resources/builtin-catalog.test.ts` | every builtin file parses + validates; stem = id; directory holds only `.yaml`; ids gsap, react-bits, shadcn-ui, lucide, zustand, tailwindcss, awesome-design-md exist; gsap skills = the 8 ids; gsap and react-bits `redistributable: false` and `baseline: true`; ≥ 100 `design-md-*`; hue kit names map to icon ids |
| `packages/kernel/src/resources/frontend-selection.test.ts` | acceptance selection (shadcn-ui, lucide, zustand, tailwindcss, one design-md) renders all four install commands, DESIGN.md rule, gsap rule, React Bits 仅链接 row; font-awesome-free adds 署名 line; each §6.4 error |
| `packages/kernel/src/infrastructure/resource-catalog-store.test.ts` | first load syncs builtin; payload change resyncs and keeps custom; crash between renames leaves readable builtin; copy id suffixing; builtin PUT/DELETE `builtin-readonly`; revision `conflict`; duplicate id reported |
| `packages/kernel/src/design-system/check.test.ts` | fixtures for missing, seed, each incomplete problem string, ready |
| `packages/kernel/src/design-system/precondition.test.ts` | require slot on first step + missing → throws with status; require on later step → no throw; no slot → no throw |
| `packages/kernel/src/workflow/template-workflows.test.ts` | design-system template parses and passes `validateWorkflowForStorage`; gates review/auto/review; implicit completion on `review`; `loadWorkflow` template fallback; global override wins; generated source equals YAML |
| `packages/cli/src/resources.integration.test.ts` | `list --framework react --styling tailwind --category icons --json` ids = §2.4; `show gsap` contains 仅链接 and all 8 skills; bad enum exit 1 |
| `packages/cli/src/design.integration.test.ts` | `check` exit codes per status; `validate` with injected fake validator (exit 0 / 1 passthrough); unmerged proposal exit 1; `propose` refuses when not ready or existing; `init --track frontend` on default with seed DESIGN.md exit 1 + message + no change dir; with ready fixture succeeds; `init --workflow design-system --track free` succeeds on empty repo |
| `packages/cli/src/commands/internalMotionGate.test.ts` | marker table; `Skill: gsap-core` after step entry → 0; row before latest entry → 2; `CodexSkillRead: gsap-core` and `tenon:gsap-core` accepted; message lists missing ids; no active change → 0 |
| `tools/test-hooks.sh` (new cases) | Write with `import gsap` and no active change → exit 0 and node not spawned; active change fixture without evidence → exit 2; Read tool containing gsap → exit 0 |
| `packages/server/src/serverResourceRoutes.test.ts` | GET shape; PUT create/update/invalid/builtin/conflict/oversize/no-token; POST copy; DELETE custom then GET 404; DELETE builtin 409; seed 409 existing, 400 wrong category, fetch stub 502 |
| `packages/server/src/serverPostChangesRoutes` test (existing suite) | frontend on default without ready DESIGN.md → 400 with precondition message |
| `packages/dashboard-app/src/api/resourceClient.test.tsx` | decoder rejects missing `license.redistributable`, unknown category, extra top-level shape |
| `packages/dashboard-app/src/library/resources/ResourceCatalog.test.tsx` | selecting React + Tailwind + 图标 chips lists §2.4 rows only (no extra request); react-bits detail pill 仅链接 and 声明 row; builtin shows 复制 only; custom 编辑 → PUT → row updated; 删除 → Dialog → DELETE → row gone; 409 shows 重新载入; chip rows carry nowrap/overflow classes; no text node longer than one line in sections except errors |
| `packages/dashboard-app/src/i18n/i18n.test.tsx` (existing) | `resources` keys symmetric in zh/en; no `_desc/_note/_hint/_lead` |

## 14. Decisions made during design

1. One file per entry, strict YAML subset, hand-written parser — no new dependency in kernel (none today).
2. Module/routes/CLI named `resources`; disk path keeps parent's `config/catalog/`.
3. Builtin sync is lazy-on-read with a payload digest instead of a hook in release activation; install and update both
   converge on first read by the new release.
4. Filtering runs client-side in the Dashboard via a pure kernel subpath (`@tenon/kernel/resources/query`), same
   predicate as the CLI; the server returns all entries.
5. Custom entries are edited as YAML text in a drawer, validated by the server; no per-field form.
6. `baseline` entries (GSAP, React Bits) are always rendered into the frontend block for matching frameworks.
7. awesome-design-md brands are individual entries generated by a manual script; the catalog never ships their content.
8. Project design system = root `DESIGN.md` (hue's four Markdown files merged, fixed English section headings,
   `schema: tenon-design/v1` marker) + `design/` (model, direction, four previews). No `SKILL.md`.
9. A brand `DESIGN.md` placed at project creation is a seed, not a finished system; frontend tasks require `ready`.
10. `tenon design check` (structural, fast) gates creation; `tenon design validate` (hue validator + merge check) is a
    required test.
11. The creation precondition is data-driven: `role: require` on a branch's first step, evaluated in both creation paths.
12. `role: update` at ship is not ledger-required; the required `design-system` test fails an unmerged proposal
    (digest-equality check, semantic merge judged by review).
13. `design-system` is a template workflow like `default` (editable, 恢复内建), not a TS builtin.
14. hue is steered only by step `prompt` data; Tenon never forks hue.
15. GSAP is enforced by a hook on file-edit tools whose input contains GSAP markers, independent of workflow; other
    animation libraries rely on the instruction rule and the reviewer.
16. No design status UI, no catalog CLI writes, no MCP configuration.
