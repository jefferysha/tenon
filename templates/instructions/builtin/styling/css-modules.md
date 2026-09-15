---
id: css-modules
category: styling
title: CSS Modules
frameworks: [react, vue]
catalog_ref: css-modules
---
### 样式（CSS Modules）

- 组件样式放在与组件同目录、同名的 `*.module.css`（如 `OrderList.tsx` ↔ `OrderList.module.css`）；Vue 单文件组件用 `<style module>`。
- 设计 token（颜色、字体、间距、圆角、阴影）以 CSS 变量定义在唯一的 `src/shared/styles/tokens.css`，组件只引用 `var(--…)`；
  禁止在组件样式里硬编码色值、字号。
- 类名 camelCase，通过 `styles.orderRow` 引用；禁止在标记里硬写字符串类名；条件组合用 `clsx`。
- `:global` 只允许出现在应用壳（`src/app/`）的样式里。
- 禁止新增全局样式文件，`tokens.css` 与应用壳的 reset 除外。
- 选择器嵌套不超过 3 层；禁止 ID 选择器与 `!important`，覆盖第三方组件样式确需使用时写注释说明原因。
- 暗色模式在 `tokens.css` 中按 `[data-theme="dark"]` 或 `prefers-color-scheme` 切换变量值，组件样式不写两套颜色。
{{catalog.ref}}
