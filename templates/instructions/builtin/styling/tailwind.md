---
id: tailwind
category: styling
title: Tailwind CSS
frameworks: [react, vue, angular]
catalog_ref: tailwindcss
---
### 样式（Tailwind CSS）

- 使用 Tailwind CSS 4，在全局样式入口 `@import "tailwindcss";`；颜色、字体、间距、圆角、阴影等设计 token 统一定义在 `@theme` 中。
- 样式只写 Tailwind 工具类；禁止新增全局 CSS，`@theme` token 与 `@layer base` 中的元素基础样式除外。
- 已有 token 能表达时禁止使用任意值（如 `text-[13px]`、`bg-[#1f2937]`）；新的视觉值先加 token，再使用对应工具类。
- 禁止在组件里硬编码色值、字号；暗色模式在 token 层切换两套值，禁止在组件里成对写死两套颜色。
- 条件类名与冲突合并统一用 `shared/lib` 中的 `cn()`（`clsx` + `tailwind-merge`），禁止手写字符串拼接类名。
- 禁止用 `@apply` 在 CSS 里重新拼一套组件样式；需要复用的样式抽成组件。
- 响应式按移动优先：无前缀是最小屏样式，`sm:` / `md:` / `lg:` 逐级覆盖；交互状态用 `hover:`、`focus-visible:`、`disabled:` 变体。
- 类名顺序由 `prettier-plugin-tailwindcss` 自动排序，提交前格式化。
{{catalog.ref}}
