# Resource Catalog (`resources/`, `infrastructure/resource-store.ts`)

## 1. Scope / Trigger

- Trigger: any change to catalog entries, their schema, the global store, the `tenon resources` command,
  `/api/resources*`, or the 资源目录 section of the Library page.
- The catalog stores **information and links only**. It never ships component, icon, template or animation
  source: the entry key set is closed, so no field can carry code, and the builtin payload directory holds
  `*.yaml` and nothing else (asserted by `resources/builtin-resources.test.ts`).

## 2. Signatures

```ts
// resources/types.ts — the closed enums are the single source of truth; instructions/categories.ts re-exports
// RESOURCE_CATEGORIES as CATALOG_CATEGORIES so a template block's `catalog:` and an entry's `category` agree.
RESOURCE_CATEGORIES = ['component-lib','blocks','template','icons','animation','motion-components','design-md','state','styling']
RESOURCE_FRAMEWORKS = ['web','react','next','vue','nuxt','angular','svelte','react-native','flutter','swiftui','compose']
RESOURCE_STYLING    = ['tailwind','css','css-modules','sass','less','css-in-js','vanilla-extract','unocss','panda','native']
RESOURCE_LINK_KEYS  = ['home','docs','source','registry','preview','design_md','mcp','llms_txt']
interface ResourceLicense { spdx; url; redistributable; attribution; commercial: 'free'|'freemium'|'paid'; notice? }
interface ResourceEntry { schema: 'tenon-resource/v1'; id; name; category; frameworks[]; styling[]; use?; baseline;
                          license; install[]; skills[]; links; verified_at }

// resources/{parse,serialize,validate,query,frontend-selection}.ts (pure)
parseResourceEntry(text): ResourceEntry                      // throws ResourceParseError(line, message)
serializeResourceEntry(entry): string                        // canonical form; parse → serialize is byte-stable
validateResourceEntry(entry, fileName): string[]
filterResources<T extends { entry }>(items, query): T[]      // '@tenon/kernel/resources/query'
licenseModes(entry): ('redistributable'|'link-only'|'attribution')[]
resourceCatalogLookup(entries): CatalogLookup                // instructions/compose.ts port

// infrastructure/resource-store.ts (node fs)
resourceStoreRoot(configRoot): string                        // <configRoot>/resources
loadResourceCatalog({ payloadRoot, configRoot }): Promise<{ resources; errors; sync }>
readResourceFile(storeRoot, id) / writeCustomResource(storeRoot, id, yaml, revision?)
copyResource(storeRoot, id) / deleteCustomResource(storeRoot, id, revision?)
class ResourceStoreError { code: 'invalid'|'builtin-readonly'|'conflict'|'not-found'|'duplicate' }
```

## 3. Contracts

- One entry per file, `<id>.yaml`, ≤ 64 KiB, UTF-8. The parser is a narrow scanner (kernel has no YAML
  dependency): `key: scalar`, `key: [a, b]` inline lists of bare tokens, a `- ` block list for `install`, exactly
  one nesting level for `license` and `links`, full-line `#` comments, scalars bare or double-quoted with JSON
  escapes. Anything else is an error carrying its line number (`第 <n> 行：<detail>`).
- `id` matches `^[a-z0-9][a-z0-9-]{1,62}$` and equals the file stem. `license.url` and every link are https.
  `links` needs at least one of `home` / `docs` / `source`. `state` and `styling` entries need `use`;
  `design-md` entries need `links.design_md`; `verified_at` is a real `YYYY-MM-DD` date.
- **License gate**: `attribution: true` or `redistributable: false` requires `license.notice`. Every builtin
  entry's license was read from its `license.url` before the entry was written; an entry whose license cannot be
  read is not added — except an entry the PRD names explicitly (`v0-templates`, `skiper-ui`): it is added as
  `redistributable: false` with a notice that states the license is unknown / terms-only, points `license.url`
  at the official terms page, and carries no `install`. Non-redistributable entries appear as 仅链接 in the Dashboard and add a 仅链接 line to the
  composed instruction file; nothing in Tenon copies their source.
- Store layout `<configRoot>/resources/{builtin,custom}`. `builtin/` is one of `BUILTIN_LIBRARIES`
  (`infrastructure/builtin-library-sync.ts`): the whole directory is replaced from `templates/resources/builtin`
  by source digest on the first read after a release, and `custom/` is never opened by the sync. Custom writes go
  through `withLock(storeRoot)` + tmp/rename and must parse and validate first, so on-disk custom entries are
  always valid.
- Reading never fails on one bad file: unparseable entries and custom ids that shadow a builtin id are returned
  in `errors[]` and excluded from `resources[]`. `revision` is `sha256:<hex>` of the file bytes and is the
  optimistic-concurrency token for PUT / DELETE.
- Filtering is one predicate for both consumers. An entry with an empty `frameworks` / `styling` list matches any
  value of that facet; `license` maps to `licenseModes`; `text` is a case-insensitive substring over id, name and
  `use`. Order is the category table, then name, then id.
- `skills[]` lists upstream skill ids that an agent loads before using the resource; every id must exist in
  `skills/sources.yaml` (asserted by the builtin catalog test). `gsap` carries the eight official GSAP skills and
  is `baseline: true`, so it is always written into a matching frontend instruction block.
- Brand `DESIGN.md` entries (`design-md-<slug>`) are generated by `tools/generate-design-md-catalog.mjs` from the
  upstream index and are always `redistributable: false`: their content is fetched into the user's project at
  selection time (`POST /api/design/seed`), never shipped. That prefix belongs to the generator — a hand-written
  entry must not use it, or the next run deletes it as an orphan.

## 4. Surfaces

- CLI: `tenon resources list [--category|--framework|--styling|--license|--query|--json]`, `tenon resources show <id> [--json]`.
  Unknown enum value, unknown id or an unreadable store → exit 1 with `ERROR: …` on stderr.
- HTTP: `GET /api/resources`, `GET /api/resources/:id`, `PUT /api/resources/:id`, `POST /api/resources/:id/copy`,
  `DELETE /api/resources/:id?revision=`. Mutations take the Host guard and token of the existing mutation tables.
  A body larger than 64 KiB is 413 decided from `content-length` — the transport drops larger bodies before the
  handler sees them.
- Dashboard: Library page rail item 资源目录; four single-select facet rows plus search; detail shows 许可 / 安装 /
  链接 / 技能 / 框架 / 样式 / 场景 / 核验; custom entries are edited as YAML in a drawer and validated by the server.
  Filtering runs client-side through the same kernel predicate, so switching a chip issues no request.

## 5. Failure Modes

| Condition | Result |
| --- | --- |
| Entry outside the YAML subset / unknown key | `第 <n> 行：<detail>`; builtin → the catalog test fails; custom → `errors[]`, 400 on PUT |
| Custom id equals a builtin id | `errors[]` `与内置资源 id 重复`; the entry is excluded |
| PUT / DELETE on a builtin id | 409 `内置资源只读，先复制` |
| Stale `revision` | 409 `资源已在磁盘上被修改，重新载入` |
| Builtin sync fails mid-way | the previous `builtin/` stays readable; the failure surfaces in the read result |

## 6. Rationale

- A second `catalog` name would collide with the existing definition catalog (`kernel/catalog/`, `/api/catalog`),
  so the module, routes and command are `resources` while the disk path follows the parent design.
- The strict YAML subset keeps kernel dependency-free and makes every rejection point at a line, which matters
  because users edit these files by hand in the drawer.
- Filtering client-side keeps the facets instant and guarantees the CLI and the Dashboard can never disagree
  about what "React + Tailwind + icons" means.

## 7. Related

- [Design System](./design-system.md) — the `design-md` category and the project design system it seeds.
- [Per-step Test Evidence](./test-evidence.md) — shares `BUILTIN_LIBRARIES` and the same global config root.
