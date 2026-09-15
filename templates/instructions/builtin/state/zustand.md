---
id: zustand
category: state
title: Zustand
frameworks: [react]
catalog_ref: zustand
---
### 状态管理（Zustand）

- 使用 Zustand 5；全局 / 跨组件状态才进 store，组件内状态仍用 `useState`。
- store 按 feature 拆分，放在 `features/<feature>/store/`（如 `use-cart-store.ts`，导出 `useCartStore`），禁止一个包含全部业务的全局 store。
- store 只暴露状态字段与 action；状态修改只能通过 store 内定义的 action，组件禁止调用 `setState` 直接改写。
- 组件用 selector 订阅所需字段（`useCartStore((s) => s.items)`）；一次选择多个字段时用 `zustand/react/shallow` 的 `useShallow`，
  禁止不带 selector 订阅整个 store。
- 派生数据在 selector 中计算或写成独立的 selector 函数，禁止把可计算的值存进 store。
- 服务器数据不放进 store；请求缓存交给数据请求方案，store 只保存客户端状态。
- 需要持久化时用 `persist` 中间件，存储键加 feature 前缀并设置 `version` 与 `migrate`；开发环境可挂 `devtools` 中间件。
- 跨 feature 使用对方的 store 时经其 `index.ts` 导出引用。
- 测试中每个用例开始前把 store 重置为初始状态，禁止用例之间共享状态。
{{catalog.ref}}
