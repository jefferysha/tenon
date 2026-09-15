---
id: jotai
category: state
title: Jotai
frameworks: [react]
catalog_ref: jotai
---
### 状态管理（Jotai）

- 使用 Jotai 3；atom 放在所属 feature 的 `store/` 目录（如 `features/cart/store/cart-atoms.ts`），命名 `xxxAtom`。
- atom 保持最小粒度，一个 atom 一份独立状态；禁止创建聚合全部状态的全局大对象 atom。
- 可计算的值用只读派生 atom（`atom((get) => …)`），禁止把派生结果再存一份。
- 多步更新封装为只写 atom（`atom(null, (get, set, arg) => …)`），组件用 `useSetAtom` 调用，不在组件里拼装多步更新。
- 组件只读用 `useAtomValue`，只写用 `useSetAtom`，读写都需要时才用 `useAtom`。
- 跨 feature 使用对方的 atom 时经其 `index.ts` 导出引用。
- 参数化 atom 用 `jotai-family` 包的 `atomFamily`（Jotai 3 已移除内置的 `atomFamily`）；参数集合无上限时必须用 `remove` / `setShouldRemove` 清理，防止内存泄漏。
- 服务器数据不放进普通 atom，atom 只保存客户端状态；需要持久化时用 `atomWithStorage`，存储键加 feature 前缀。
- 测试中每个用例使用独立的 `createStore()` 或 `Provider`，禁止用例之间共享状态。
{{catalog.ref}}
