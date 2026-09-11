# PRD · 脉冲改用 MotionPathPlugin
## 问题
截图 31：画布边上看不到脉冲。上一版用 CSS `offset-path` + GSAP 补 `offsetDistance`，SVG `<circle>` 上不生效，圆点停在 (0,0) 且 opacity 0。
## 目标
- `PulseEdge` 用 `gsap/MotionPathPlugin` 沿边路径字符串移动圆点（`motionPath: { path }`），同一时间轴按段序传递、循环；圆点 r 4 + 淡光晕；reduced-motion 不动。
- 实机用 Playwright 采样圆点 transform 两次，确认在移动。
## 验收
- [ ] 圆点 transform 随时间变化；web 用例、design-scale、comments、build 通过。
