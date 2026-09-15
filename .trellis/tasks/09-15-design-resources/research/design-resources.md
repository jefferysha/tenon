# Design resources: component libraries, icons, UI templates (research)

## Local evidence (tenon-local, 2026-09-15)

- Bundled design-related skills are short generic checklists (13–14 lines each), with no catalog of libraries, icons or
  templates: `skills/design-taste-frontend`, `web-design-guidelines`, `react-best-practices`, `huashu-design`, `prototype`,
  `frontend-design`, `browser-qa`.
- `skills/shadcn-ui/SKILL.md` (14 lines) only says to use primitives where they fit and to "avoid copying a component
  catalogue wholesale"; no registry, block or icon guidance.
- No DESIGN.md support, no v0 / shadcn registry lookup, no icon search exists in Tenon today.

## External research (official sources, 2026-09-15)

### awesome-design-md and DESIGN.md

- [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md): MIT; `design-md/` holds ~117 brand folders
  (README badge says 73). Each has a `DESIGN.md` (~33 KB for claude); details moved to getdesign.md;
  CLI [`npx getdesign list` / `add <slug>`](https://www.npmjs.com/package/getdesign) writes `./DESIGN.md`.
- Content: visual theme, color palette & roles, typography, component stylings, layout, depth, do's and don'ts, responsive,
  agent prompt guide. Disclaimer: no ownership of the sites' visual identity → **link / fetch on demand, do not bundle**.
- Format origin: Google Labs [design.md](https://github.com/google-labs-code/design.md) (Apache-2.0), popularized by Stitch;
  YAML front matter tokens + fixed `##` sections; `@google/design.md` CLI `lint` / `export` (Tailwind, DTCG) / `diff` / `spec`.
- Agents use it by keeping `DESIGN.md` at the project root and pointing to it from AGENTS.md.

### v0

- Own output assigned to the user ([AI Product Terms](https://vercel.com/legal/ai-product-terms)); public community templates
  "may be viewed and copied" with no open-source license ([Templates](https://v0.app/docs/templates)) → **link only**.
- Official MCP `https://v0.app/api/mcp` (OAuth) generates UI, not a catalog; [v0 SDK](https://github.com/vercel/v0-sdk).

### shadcn registry and block collections

- Registry: `registry.json` / `registry-item.json`; `npx shadcn add @ns/item | URL | owner/repo/item`;
  open-source index `https://ui.shadcn.com/r/registries.json`; [MCP server](https://ui.shadcn.com/docs/mcp) for Claude and Codex; llms.txt.
- Licenses: Magic UI MIT; Aceternity custom (no redistribution of source); HyperUI MIT; Flowbite core MIT / Pro EULA;
  Preline MIT + Fair Use (attribution); Tremor Apache-2.0; TailAdmin free MIT / Pro commercial; Park UI MIT; Nuxt UI v4 MIT;
  Tailwind Plus commercial; daisyUI, Mantine UI MIT (not re-checked).

### Component libraries (mostly MIT; licenses not all re-checked)

React: shadcn/ui, Radix, MUI (X Pro commercial), Ant Design, Chakra, Mantine, HeroUI, Headless UI, Arco, Semi.
Vue: Element Plus, Naive UI, Vuetify, PrimeVue, Ant Design Vue, shadcn-vue, Nuxt UI. Angular: Angular Material, PrimeNG,
NG-ZORRO, Spartan. Svelte: shadcn-svelte, Skeleton. Mobile: React Native Paper, Tamagui, NativeWind, gluestack; Flutter BSD-3;
Jetpack Compose Material 3 Apache-2.0; SwiftUI Apple SDK license.

### Icons

Lucide ISC; Heroicons, Tabler, Phosphor, Radix Icons, Bootstrap Icons MIT; Material Symbols Apache-2.0;
Remix Icon custom (no standalone redistribution); Font Awesome Free CC BY 4.0 / OFL / MIT (attribution);
SF Symbols Apple-only; Iconify aggregator with per-set license in `collections.json` (can be stale — record upstream license).

### State management and styling

- React: Zustand (small global), Redux Toolkit (large teams, strict), Jotai (atomic), MobX (reactive OOP), TanStack Query (server state).
- Vue Pinia; Angular Signals / NgRx; Svelte stores / runes; Flutter Riverpod / Bloc; Android ViewModel + StateFlow; iOS Observation / TCA.
- Styling: Tailwind CSS, CSS Modules, Sass/SCSS, styled-components / Emotion, vanilla-extract, UnoCSS, Panda CSS, Less (legacy Ant Design).

### Run-time lookup instead of bundling

shadcn registry index / `shadcn search` / MCP; [Context7 MCP](https://github.com/upstash/context7) for docs; Iconify API
`api.iconify.design/search?query=`; v0 MCP (opt-in, OAuth); llms.txt; `npx getdesign add`.

### Conclusions

- Bundle only catalog metadata, links, the design.md spec, and small MIT/ISC/Apache snippets with license text.
- Never bundle: Tailwind Plus, Aceternity source, v0 community templates, SF Symbols, Remix Icon set, Flowbite Pro, TailAdmin Pro, MUI X Pro.
- Catalog entry fields: id, name, category (component-lib | blocks | template | icons | design-md | state | styling), frameworks,
  styling, license {spdx, url, redistributable, attribution, commercial}, install, docs_url, registry {type, url}, design_md,
  mcp, llms_txt, verified_at.
- Agents consume via AGENTS.md "UI resources" section for the chosen stack, a Tenon lookup command, and existing MCP servers;
  a license gate before copying code.
