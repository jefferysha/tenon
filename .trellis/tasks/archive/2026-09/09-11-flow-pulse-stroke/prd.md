# PRD · 线段高亮流动 + 长名截断
## 问题（截图 32）
1. 小球脉冲不流畅，用户要的是线本身有一段高亮沿边流动。
2. 长技能名（verification-before-completion）溢出节点边框。
## 目标
- PulseEdge：在底线上叠一条强调色路径，`stroke-dasharray = 段长 + 总长`，GSAP 把 `stroke-dashoffset` 从 总长 补到 −段长，段序 / 总段数沿用，循环；reduced-motion 不动。
- 节点宽 260，名称用 caption 等宽字号并截断，hover 显示全名；flex 行 `min-w-0`。
## 验收
- [ ] Playwright 采样 `flow-pulse-*` 的 stroke-dashoffset 随时间变化。
- [ ] 长名节点不溢出（节点 scrollWidth ≤ clientWidth）。web 用例、design-scale、comments、build 通过。
