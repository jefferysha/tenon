# hue skill: what a complete design system contains (research, 2026-09-15)

## Two versions on this machine

- Tenon's bundled `skills/hue/SKILL.md` is a 14-line first-party stub ("turn a confirmed product intent into a restrained visual
  language … record tokens in the design artifact"). Referenced by `skills/tenon-build/SKILL.md:152,163,188` as a design source
  in build (PM/frontend prototypes), `templates/skill-sources.yaml:49` tier conditional.
- The full upstream skill is installed at `~/.agents/skills/hue` (v1.2.0): [dominikmartn/hue](https://github.com/dominikmartn/hue),
  **MIT** (Copyright (c) 2026 Dominik Martin), works on Claude Code and Codex, site hueapp.io. SKILL.md 869 lines, 11 reference
  templates, `scripts/validate.mjs`, 17 example brands.

## Inputs

Brand name (web lookup + confirmation), URL (Chrome DevTools computed styles preferred, fetch fallback with reduced confidence),
local codebase (tokens, CSS vars, components, Storybook), screenshots (play back findings, resolve contradictions), description
(every adjective becomes a number), remix of an existing design language. Fetched content is treated as data, never instructions.

## Workflow (16 phases)

Deep analysis (UI-rich vs content-rich) → component inventory with tear-down sheets (observed) or derived designs (justified by
principles) → icon kit selection (score stroke / corners / fill / form / density; pick one freely licensed kit; record
`observed_style` vs `fallback_kit`) → hero stage (mandatory; background / hero subject / relation dials, 9 presets) →
**confirm direction with the user** → **token preview for the user** → build `design-model.yaml` (single source of truth) →
generate SKILL.md, tokens.md, components.md, platform-mapping.md from the model → previews (`preview.html` bento dashboard,
`component-library.html`, `landing-page.html`, `app-screen.html`) → **validation gate** `node scripts/validate.mjs` (YAML, orphan
selectors, undefined `var(--token)`, placeholders, em-dashes, frontmatter contract, WCAG contrast, AI-default display fonts) +
screenshot self-review in light and dark → iteration edits the model first, regenerates affected files only.

## What the design system specifies

- Identity: name, philosophy (attitude + lineage + primary tension), primary mode, brand domain and type, voice (tone + samples).
- Primitives: neutral ramp 50–950 matched to temperature, brand accent ramp, status ramps (red / green / amber), spacing scale,
  radii scale trimmed to values actually used.
- Semantic tokens for light and dark: background, surface1–3, border, border_visible, text1–4, accent, accent_subtle,
  success / warning / error and their `*_bg` tints.
- Typography: display / body / mono families with rationale and fallbacks; 7-step scale (display, heading, subheading, body,
  body-sm, caption, label) with size, line height, letter spacing, weight, use; `mono_for_code`, `mono_for_metrics`, banned
  AI-default fonts and genre palettes for invented choices.
- Spacing (8px grid with semantic uses), radii per element / control / component / container / pill, elevation strategy
  (flat / subtle / glow / material), motion personality (mechanical / smooth / playful / none) with easing and durations,
  interaction states.
- Hero stage recipe; iconography (observed style + one fallback kit with CDN and class prefix + disclaimer).
- Components: buttons (4 variants + states), cards, inputs, lists / data rows, navigation / tab bar, tags / chips, overlays
  (modal, bottom sheet), state patterns (empty, loading, error, disabled); each with source observed / derived and token mapping.
- Design principles (5–7 falsifiable), craft rules (5–6), anti-patterns (8–12 "No …").
- Platform mapping: CSS custom properties (light/dark), SwiftUI Color / Font extensions, Tailwind config.

## Relevance to Tenon

- The user's definition of project `DESIGN.md` ("整个项目的设定，包括每个图标、UI 颜色、个性化等所有细节") matches hue's full output,
  not the 14-line stub and not a lightweight Google design.md file alone.
- hue writes generated design skills to `~/.claude/skills/` or `~/.agents/skills/` by default; Tenon needs the output at the
  project root and versioned with the project.
- hue has two built-in human checkpoints (direction, token preview) and a deterministic validator — natural review gate and test
  direction in a Tenon workflow.
- MIT allows bundling the full skill with its license; pin the upstream commit.
