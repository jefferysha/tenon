---
id: pinia
category: state
title: Pinia
frameworks: [vue]
catalog_ref: pinia
---
### 状态管理（Pinia）

- 使用 Pinia 4；store 按 feature 放在 `features/<feature>/stores/`，文件名 `use-xxx-store.ts`，导出 `useXxxStore`，store id 带 feature 名。
- 只写 setup store（`defineStore('cart', () => { … })`）：`ref` 是 state，`computed` 是 getter，函数是 action；
  全部 state 必须 return，否则 devtools 与插件看不到。
- 组件解构 state、getter 必须用 `storeToRefs(store)`；action 直接从 store 解构。
- 异步请求与业务流程写在 action 中；组件禁止直接给 store 的 state 赋值，禁止在组件里用 `$patch` 拼装业务更新。
- store 可以在 action / getter 内部使用其它 store，禁止循环依赖；两个 store 互相需要时把共享部分下沉为第三个 store 或组合式函数。
- 只保存客户端状态；选择了数据请求方案（如 TanStack Query）时，禁止把查询结果复制进 store。
- 测试用 `@pinia/testing` 的 `createTestingPinia`，每个用例独立 pinia 实例。
{{catalog.ref}}
