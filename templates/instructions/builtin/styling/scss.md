---
id: scss
category: styling
title: Sass（SCSS）
frameworks: [angular, vue, react]
catalog_ref: sass
---
### 样式（Sass（SCSS））

- 使用 Dart Sass（`sass` 包）；模块只用 `@use` / `@forward`，禁止 `@import`（Dart Sass 1.80 起弃用，3.0 移除）。
- 组件样式与组件同目录、组件作用域：Angular 用组件的 `.scss`（默认 Emulated 封装），Vue 用 `<style scoped lang="scss">`，
  React 用 `*.module.scss`。
- 设计 token 集中在 `src/shared/styles/_tokens.scss` 并输出为 CSS 变量；组件通过 `@use` 引入，禁止硬编码色值、字号。
- mixin 与 function 按用途拆成 partial 放在 `src/shared/styles/`（`_mixins.scss`、`_breakpoints.scss`）。
- 嵌套不超过 3 层；`&` 只用于伪类与修饰类，禁止用 `&-xxx` 拼出无法全局搜索的类名。
- 禁止新增全局样式，token、reset 与第三方组件主题覆盖除外，统一由应用壳入口引入。
- 禁止 `!important` 与 ID 选择器；Angular 禁止 `ViewEncapsulation.None` 与 `::ng-deep`，确需覆盖第三方组件时写注释说明原因。
{{catalog.ref}}
