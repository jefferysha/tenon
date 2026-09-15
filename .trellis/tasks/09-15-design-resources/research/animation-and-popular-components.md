# Animation skills and popular animated component libraries (research, 2026-09-15)

## GSAP official agent skills

- [greensock/gsap-skills](https://github.com/greensock/gsap-skills) (~15.3k stars), [MIT](https://raw.githubusercontent.com/greensock/gsap-skills/main/LICENSE)
  "Copyright (c) 2026 GreenSock"; last commit 2026-04-21 (Vue/Nuxt examples added April).
- 8 skills: gsap-core, gsap-timeline, gsap-scrolltrigger, gsap-plugins (Flip, Draggable, SplitText…), gsap-utils, gsap-react
  (useGSAP, cleanup), gsap-performance, gsap-frameworks (Vue/Svelte). Each `skills/<name>/SKILL.md` with `license: MIT`;
  skills cross-reference each other. Repo ships `.claude-plugin/`, `.cursor-plugin/`, `.github/copilot-instructions.md`,
  `examples/`, `AGENTS.md`.
- Install: `npx skills add https://github.com/greensock/gsap-skills`; Claude Code `/plugin marketplace add greensock/gsap-skills`;
  or copy folders. Codex not named explicitly in the README.
- This machine has only 4 of 8 installed (core, react, utils, performance).
- **Can be bundled** in Tenon verbatim with the MIT license and copyright; pin the upstream commit.

## GSAP library license

- Free since 3.13 (April 2025) including commercial use and all former paid plugins, in the `gsap` npm package
  ([3.13](https://gsap.com/blog/3-13/)); React integration `@gsap/react`.
- Not MIT: Webflow [Standard "no charge" license](https://gsap.com/community/standard-license/) prohibits tools that help create
  solutions competing with Webflow's visual animation building, and reverse engineering for competing products.
  → Projects install the package; Tenon does not bundle GSAP code and must not build a visual animation editor.

## React Bits

- [DavidHDev/react-bits](https://github.com/DavidHDev/react-bits) (~47.3k stars), "165+" components: Text Animations, Animations,
  Components, Backgrounds; each in JS/TS × CSS/Tailwind.
- License [MIT + Commons Clause](https://raw.githubusercontent.com/DavidHDev/react-bits/main/LICENSE.md): usable in apps/sites/products;
  must not sell, sublicense or redistribute the components themselves, alone or in a bundle. → **link / install only.**
- Install: `npx shadcn@latest add https://reactbits.dev/r/<Name>-<JS|TS>-<CSS|TW>` or `@react-bits/<Name>-TS-TW`; jsrepo; copy-paste.
- Dependencies: gsap, @gsap/react, motion, lenis, three, @react-three/fiber/drei/postprocessing, ogl, matter-js.
- Agent support: [llms.txt](https://reactbits.dev/llms.txt); paid Pro tier uses shadcn MCP and advertises 20 skills.
- Vue Bits: MIT + Commons Clause (same restriction).

## Other libraries

| Library | Stars | License | Install | Agent support |
|---|---|---|---|---|
| shadcn/ui | 124k | MIT | shadcn CLI v4 | official skill `npx skills add shadcn-ui/ui`; MCP `npx shadcn@latest mcp` (Claude Code, Codex) |
| Magic UI | 22.3k | MIT | `@magicui` registry | `skills/magic-ui`, MCP |
| Motion Primitives | 6.3k | MIT | shadcn registry | — |
| Cult UI | 6.1k | MIT | shadcn registry | — |
| Animate UI | 4.3k | MIT | `@animate-ui` registry | — |
| Animata | 2.8k | MIT | copy-paste | — |
| Kokonut UI | 2.1k | MIT | shadcn registry | — |
| Eldora UI | 2k | MIT | copy-paste | — |
| coss ui (ex Origin UI) | 10.6k | repo AGPL; `apps/ui`, `apps/origin` MIT | `@coss` registry | — |
| Aceternity UI | no public repo | Pro forbids source redistribution | `@aceternity` registry | third-party MCP |
| Skiper UI | no public repo | free tier attribution; Pro license key | `@skiper-ui` | third-party MCP |
| Inspira UI (Vue) | 5k | MIT | shadcn-vue | — |
| Motion | 33.6k | MIT (Motion+ paid) | `motion`, `motion-v` | AI Kit `npx motion-ai`: skill + hosted MCP |
| Anime.js v4 | 72.8k | MIT | `animejs` | — |
| React Spring | 29.1k | MIT | `@react-spring/web` | — |
| lottie-web / dotLottie | 32.1k / 0.9k | MIT | `lottie-web`, `@lottiefiles/dotlottie-react` | — |
| AutoAnimate | 13.9k | MIT | `@formkit/auto-animate` | — |
| Rive runtime | 1k | MIT (editor proprietary) | `@rive-app/react-canvas` | — |

## Conclusions

- Bundle: gsap-skills (MIT, verbatim + license), shadcn / Magic UI skills after checking per-folder licenses, short MIT excerpts.
- Link / install only: React Bits, Vue Bits (Commons Clause), Aceternity, Skiper, GSAP library code, Motion+ content, all packages.
- Animation section — required: all 8 gsap-skills bundled; `gsap` + `@gsap/react` packages. Optional: Motion (AI Kit), Anime.js,
  AutoAnimate, React Spring, dotLottie, Rive.
- Animated components — required: React Bits (registry link), shadcn/ui base (skill + MCP). Optional: Magic UI, Motion Primitives,
  Animate UI, Cult UI, Kokonut, Animata, Eldora, coss ui; Vue: Inspira UI, Vue Bits; Aceternity, Skiper link-only.
- Making agents follow GSAP: bundle skills; AGENTS.md rule to read the relevant gsap skills before any animation work; enforce
  via Tenon's skill gate (animation work requires the gsap skills read) and review checks (useGSAP scope/cleanup, `gsap.matchMedia`
  reduced motion, transform-only, ScrollTrigger refresh/kill).
