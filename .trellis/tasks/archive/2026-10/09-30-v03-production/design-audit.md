# Tenon Dashboard v0.2.0 design audit (read-only)

Caveats: `09-library-templates-dark`, `12-skills-dark` and `02-workspace-build-dark` are actually light theme, so dark coverage of library, skills and wizard is unverified. The skill editor overlay, agent composer and run drawer are not in the screenshot set (code-level notes only). Contrast numbers are computed from token hex values.

Verdict: the canvases read as an engineering wireframe. Wires are 1.5:1, ids are truncated mono, boxes nest three deep, and edge rails run along frame borders. The pulse is a blinking tick, not a flow. Fixing edges, node anatomy and the pulse closes most of the premium gap.

## 1. Benchmark

Consulted this session: React Flow "Animating Edges" docs; Liam ERD post (`stroke-dasharray` slow across hundreds of animated edges, replaced by `animateMotion` particles); Emil Kowalski standards (UI under 300ms, never ease-in, animate only transform/opacity); Material 3 duration tokens; Rauno (interactions ≤200ms); GSAP 3.13 (all plugins free, incl. MotionPathPlugin); GitHub Actions, Dagster and LangGraph Studio docs. The n8n, Temporal, Linear, Raycast, FigJam and Retool points are from prior knowledge, not fetched.

- **Node anatomy:** one line, 32-40px. State glyph left (shape plus colour, as in Actions), name, right meta. Category is a quiet icon. Ports are 6px dots shown on hover or on the active path (n8n, FigJam). Words like "等待" appear only for non-default states.
- **Edges:** orthogonal or smooth-step, 8-12px corner radius (FigJam, Actions, Dagster), 1-1.5px, ≥3:1 against the surface. Direction comes from layout plus one end cue, not an arrowhead per hop. n8n puts item counts on wires.
- **Grouping:** swimlanes are header rows or tinted bands, not bordered boxes (Actions stage columns, collapsible Dagster groups). Empty lanes are hidden read-only and shown as one ghost "+" when editing (Retool).
- **Zoom and density:** semantic zoom (glyph only below about 0.7, name at 1, meta at 1.25+). A minimap pays off above roughly 30 nodes; Tenon stages have 40 or fewer, so use fit-to-width plus click-to-focus.
- **Run state:** LangGraph highlights the active node and the path taken. Completed wire solid, frontier bright, future neutral. Idle graphs get at most a quiet ambient signal.
- **Motion:** UI transitions 100-250ms ease-out; loops only for real activity; reduced-motion keeps opacity and drops transforms.

## 2. Diagnosis of the current canvases

**D1 Wires and borders too faint (P0).** `--border-2` on card is 1.49:1 light, 1.60:1 dark. Node borders (`--border`) are 1.26:1. `EDGE_STYLE` (`skillFlowNodes.tsx:13`) is 1.5px. The skeleton dissolves in `04-*` and `overview-canvas-2x`.

**D2 Rails collide with frame borders (P0).** `RAIL = 10` (`orchestrationRouting.ts:9`) and `FRAME_PAD = 16` (`orchestrationLayout.ts:23`) put the junction rail 6px inside the frame border. `PulseEdge` draws these with `getBezierPath`, so `overview-canvas-2x` shows a flat hook under `frontend-design` and arrowheads glued to the frame edge (实现). The 验证 column has four stacked arrowheads and crossing lines.

**D3 Arrowhead per hop (P1).** Hops are 24-28px (HEAD_GAP 24, ROW_GAP 28) with a grey ArrowClosed each. The 调研 column shows 5 triangles for 5 nodes, which reads as rhythm noise.

**D4 Node anatomy (P0).** Overview nodes are 176×32 with 14px mono ids, about 16 characters. `openspec-propo…`, `test-driven-de…` and `openspec-explo…` lose the distinguishing tail. 32px is under the 40px control rule. There is no state glyph; executor, skill and test differ only by a grey icon. Stage-mode nodes carry a second line ("等待", "未运行") on almost every node.

**D5 Three nested boxes (P1).** Canvas border, column frame, node border, all near 1.2:1. Every frame stretches to the tallest column, so 立项 with 1 node sits in a roughly 640px frame.

**D6 Overview framing (P0).** The initial view shows about 4.5 of 8 columns. The 4×40px control stack covers node text (`spe`, `fro`, `sec`). Return arcs are 1.2px dashed `--border-2` and cut off at the top.

**D7 Stage canvas (P0).** `OrchestrationFlow` stage mode has `start.y = 0` and `readOnlyViewport` yields y=0, so the start dot is flush to the top border with its label clipped (`02-*`, `pulse-frame-*`). A 220px column sits in about 1060px. Lane labels float about 120px left at 16px, larger than the 14px node text (inverted hierarchy). Empty lanes ("测试 0", "评审者 0") leave bare labels with a 190px arrowless wire through them.

**D8 Dark mode (P1).** `--green` vs `--accent` is 1.32:1 dark (#7fa38c vs #74c29e) and 1.57:1 light, so done and current cannot be told apart in the stage rail or status dots. The 12% glow stroke on the pulse is invisible in both themes.

**D9 Why the current pulse fails** (`flowPulse.ts`)
- **Clamped segment.** `pulseSegment` is 36-64px but hops are 24-28px, so the lit part is a 4-6px sliver (frames 00-03, 11). Only the empty-lane wire gets a hard-ended 64px bar (04-05). Frame 07 is empty.
- **Inconsistent speed.** `PULSE_MIN_LEG` 0.48s makes a 26px edge move at about 54px/s and a 190px edge at 420px/s, 8× apart, despite "整条匀速".
- **Serial waves.** One order lights at a time. The overview has roughly 40 sequential orders, so a loop is 15-25s with one lit stub, mostly off-screen.
- **Invisible arrival.** The signal disappears behind nodes (no path inside), and the 160ms border flash is imperceptible.
- **Wrong semantics.** The same loop plays on idle, blocked and running canvases. Three pulse idioms coexist: `StageRail` sine breathing (even while 阻塞 4), Tailwind `animate-pulse` on running dots, and the dash.

## 3. Flow animation redesign: "Signal"

**Model.** Keep the intent (continuous start→end, always on visible canvases). Replace per-edge waves with one conveyor. Every edge derives its phase from its arrival distance, so speed is constant and forks and joins synchronise by construction.

**Phase plan (pure function).**
- `arrival(node) = max over incoming edges of (a(e) + len(e))`
- `a(e) = arrival(source) + transit(source)`, where `transit` is the node's extent along the flow (32 overview, 36-52 stage).
- Fork branches share the same `a`. A join's outgoing edge starts at the slowest arrival.

**Streak.** Four clones of each edge path share one `d`, heads aligned, so no gradient is needed:

| Layer | Dash length | Stroke | Opacity |
|---|---|---|---|
| halo | 72 | 4px | .14 |
| trail | 48 | 1.5px | .30 |
| trail | 26 | 2px | .55 |
| core | 10 | 2.5px round cap | 1 |

- Each layer: `stroke-dasharray = "Li, P−Li"`, `stroke-dashoffset = a(e) + Li − v·t` (mod P).
- A dash straddling two edges draws its tail on the previous edge automatically.
- Nodes are opaque and above edges, so the streak passes behind them. At a 58px pitch a 72px streak always shows part of itself.
- No filters, no blur.

**Parameters.**

| | Ambient (idle) | Running |
|---|---|---|
| Speed v | 140 px/s | 300 px/s |
| Spacing P | clamp(routeLen/3, 320, 720) | 360 |
| Emitters | whole route from start | running node → end only |
| Streak opacity | ×0.7 | ×1 |
| Easing / repeatDelay | linear (`ease:'none'`) / none | same |

- Overview: routeLen about 2600, P=720, 3-4 streaks in flight, 18s traverse. Stage canvas: routeLen about 500, P=320, about 1.5 streaks. Spacing replaces any manual stagger.
- Wire states: upstream of the running node solid `--flow-done` 1.5px; downstream `--flow-line`; done at 55% opacity; blocked at a review gate has no motion, and the wire ends in a 6px amber tick.

**Node arrival** (existing `[data-pulse-flash]`, opacity only)
- Accent border plus 4px halo at .16 alpha. Rise 90ms, decay 520ms, both `power2.out`, 610ms total.
- The 6px top port dot fills accent for 300ms. The icon goes `--text-3` → accent over 200ms.
- The start dot emits a ring (scale 1→2.2, opacity .35→0, 600ms) each time a streak spawns. The end dot rings on arrival.
- The running node gets a static accent border, `0 0 0 3px accent/.12` and a 12px rotating arc glyph (compositor transform). Delete the `animate-pulse` dot.

**Tokens** (add to all three theme blocks in `index.css`)

| Token | Light | Dark |
|---|---|---|
| `--flow-line` | #94938a (3.09:1) | #666c66 (3.19:1) |
| `--flow-done` | `var(--accent)` | `var(--accent)` |
| `--flow-streak` core | `var(--accent)` | `var(--accent-d)` (11:1) |
| halo | accent @ .14 | accent @ .14 |

Node border: light #c9c8bf (1.68:1), dark #4a4f4a (2.05:1). Wires must clear 3:1; outlines can be quieter because fill and text carry the node.

**GPU-friendly implementation**
- **One clock.** A single `gsap.ticker` callback (or one infinite tween on a plain `{t}` with `onUpdate`). No per-edge tweens, no React state, no `getBBox` in the tick.
- **Hot edges only.** An edge is hot when the streak window `[H−72, H]` intersects `[a, a+len]`. Only hot edges get their 4 offsets written: at most 6 edges, 24 attribute writes per frame. Cold edges stay `visibility:hidden`. Cache `getTotalLength` per `d`.
- **Pause** on `IntersectionObserver` (already present), `document.hidden`, and reduced-motion.
- **Honest limit.** SVG `stroke-dashoffset` is a main-thread paint, not compositor-accelerated; Liam ERD measured dash cost at hundreds of edges, hence hot-only writes. If profiling shows more than 2ms paint per frame, switch each streak to one `<circle>` driven by GSAP MotionPathPlugin: one transform per streak, no path repaint.
- **Node ring:** `opacity` on a pre-rendered `<span>`. No `scale` on nodes, no `box-shadow` animation.
- **Reduced-motion:** no streaks, no loops. Running is shown statically (accent border, glyph, done wire). Events get a 100ms opacity flash. Keep the `matchMedia` change listener from `flowPulse.ts`.

**Component plan**
1. New `workflow/flowSignal.ts` replaces `flowPulse.ts`. Export pure `planSignal(edges, nodes, {speed, spacing})` → `{ a, arrival, routeLen }` and `useSignal(container, mode, frontier?)`, `mode: 'off'|'ambient'|'running'|'still'`.
2. `PulseEdge` (`skillFlowNodes.tsx`) renders the base path plus 4 `<path data-signal-layer>` clones. Use `getSmoothStepPath({ borderRadius: 8 })` everywhere. Drop the glow/core pair.
3. `orchestrationRouting.ts`: with frame borders gone (§4), set `RAIL` to 12 and keep it clear of node edges. Drop arrowheads on serial hops; keep one 5px chevron at fan-in entries.
4. `pulseModeOf` becomes `signalModeOf({visible, running, blocked})`; pass the running node id from `statusOf` as `frontier`.
5. Remove the `StageRail` breathing tween. While a task runs, the running-mode streak slides along the current segment instead.
6. Rewrite `flowPulse.test.tsx` as `planSignal` tests: fork, join, constant speed, arrival order.

## 4. Page-by-page review

**Workspace**
- **P0 Next-step block** (`NextStepPanel.tsx`): four unstructured lines, and the command is truncated at its tail (`…cart-dis…`), cutting the one part that matters. Head-truncate the `cd` path and keep `tenon status <change>`. Make blockers 40px rows with a 2px amber left stripe and group "缺少文档 proposal openspec-design tasks" into one row. Drop the count beside "下一步".
- **P0 Detail header:** 34/700 title, mono subtitle, orphan "J" avatar, amber "阻塞 4", and the same "阻塞" again in the list card and the next-step block. Keep card plus header; move the avatar to the ⋯ row.
- **P1 Stage rail** (`StageRail.tsx`): current is accent (`01`), selected is bold ink (`02` 实现), two active signals. Done vs current is 1.3-1.6:1, and current breathes while blocked. Fix: bar 3px, done = `--text-3`, current = `--accent`, todo = `--border`, selected = 2px ink underline under the label, no breathing.
- **P1 Tests tab:** the stat line is plain mono. Make four tabular figures at 24/600 with 13px labels, zeros in `--text-3`, non-zero failures red. Collapse the seven boilerplate "将本阶段目标拆成…" rows into one "7 可选" row and sort failing first. Move the truncated 缺项 command into a row expand.
- **P1 Project rail:** paths truncate at the wrong end (`~/…/projects/tenon-l…`). Use start-ellipsis or the last two segments. Make the collapse chevron and "+" borderless.
- **P1 Run drawer** (`TestRunDrawer.tsx`, code only): it imports `StatusPill` from `ThreeColumns`; check it against the no-pills rule.

**Workflow page**
- **P0 Overview:** fit to width with min zoom 0.6 so all 8 headers show, plus semantic zoom. Click a header to tween the viewport to that stage (320ms `--ease-in-out`). Replace the four-button stack with one 40px row at bottom-left.
- **P0 Column frames:** drop the borders for a header row plus a 4% tint band, each hugging its content. This removes the third nested box.
- **P0 Left-rail return arcs** (`WorkflowNav.tsx`): use `--flow-line`, 1.25px, dash "2 3", 5px arrowhead.
- **P1 IO tables:** dim repeated values ("立项 / openspec-propose" ×3) to `--text-3`. File names at 16/600 mono are heavy; use 500.
- **P1 Stage canvas:** left-align at 24px, node width 320, lane label becomes a 13px group header above its nodes, empty lanes vanish read-only, 24px top and bottom padding including labels.

**Projects**
- **P0 Clients empty state** (`07-*`): the right pane is blank. Show one centred ghost "＋ 客户端" button, no sentence.
- **P1 Tests list:** an "不稳定" column of all zeros in a 360px table. Hide zeros.

**Library**
- **P1:** ten agent rows read "官方 1.0.0". Show meta only on 自定义 rows.

**Skills**
- **P1:** the "引用" column is all "—", so drop it until populated. Full mono timestamps become `09-21`. Hover fills per cell and leaves white seams (`12-light`), so put hover on `tr`. Use sticky subheaders for repeated sources ("obra/superpowers" ×7).
- **P1:** the page has no title and no left rail, unlike its siblings.

**New-project wizard and dialogs**
- **P0** (`13-*`): step 1 has one control and about 300px of dead space. Open the system folder picker on entry, or hug content with a 200ms height tween.
- **P1:** the five-step stepper for one decision could merge 模板 / 资源 / 客户端 into one step (your call).
- **P1:** an unlabeled ⌶ glyph next to the folder field has no tooltip or aria-label.
- **P2:** blur plus scrim turns the light theme muddy grey. Drop `backdrop-blur`.

**Top bar and rail**
- **P1:** the gear is the only bordered element on the bar; remove its border. Keep the sliding nav indicator.

**Global**
- **P1 Borders:** `--border` is 1.17:1 on `--bg` and 1.26:1 on card. Darken light `--border` to about #dcdbd4 (1.5:1) and keep `--border-2` for controls.
- **P1 Mono overuse:** restrict mono to ids, paths, commands and hashes. Use Inter 500 at 14px for skill names, which fits about 26 characters in 176px. Truncate in the middle: head span truncates, 6-character tail span fixed.

## 5. Signature moves

1. **One Signal everywhere.** The same streak on the workflow canvas, the task canvas, the running stage-rail segment, and a 2px streak under the active nav tab when any task runs. One motion idea becomes the product's identity.
2. **Energising circuit.** Done wire solid accent, frontier bright, future neutral. The task canvas reads as a circuit being powered, with no words.
3. **Signals stop at gates.** At a review gate (shield) the streak stalls and the ring turns amber until approved; at an auto gate (⚡) it flashes accent and passes. Motion carries semantics, so no status text is needed.
4. **Orthogonal wires, cursor-aware ports.** 8px radius, 1.25px hairline, 6px ports that fade in within 48px of the cursor, with semantic zoom.
5. **Bands, not boxes.** Stage headers on tint bands, sticky on horizontal pan, click to focus-zoom.
6. **Keyboard on canvas.** Arrow keys walk the flow, Enter opens, and the focus ring travels the wire with one 240ms streak.
7. **Typographic discipline.** Mono for ids only, tabular figures on every count, count changes roll with a 160ms vertical slide (low frequency, within Emil's rule).

Do first: D1/D2 (wire contrast and routing), D4 (node anatomy), the Signal spec (§3), then the two dead-space P0s (Projects clients, wizard step 1).

Rule flags: (a) overview nodes stay 32px visually with an invisible 40px hit area; (b) done=green retired for warm grey in the rail; (c) idle loop kept, as the ambient tier; (d) column frames lose borders; (e) skill ids move from mono to proportional. Say if any should stay as is.

Sources: [React Flow Animating Edges](https://reactflow.dev/examples/edges/animating-edges); [Liam ERD edge tuning](https://liambx.com/blog/tuning-edge-animations-reactflow-optimal-performance); [Emil Kowalski standards](https://github.com/emilkowalski/skills/blob/main/skills/review-animations/STANDARDS.md); [Material 3 easing and duration](https://m3.material.io/styles/motion/easing-and-duration/tokens-specs); [GSAP 3.13](https://gsap.com/blog/3-13/); [GitHub Actions visualization](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph).
