---
id: redux-toolkit
category: state
title: Redux Toolkit
frameworks: [react]
catalog_ref: redux-toolkit
---
### 状态管理（Redux Toolkit）

- 使用 Redux Toolkit 2 + React Redux 9；store 在 `src/app/store.ts` 用 `configureStore` 组装，导出 `RootState`、`AppDispatch`、`AppStore` 类型。
- 每个 feature 一个 slice，放在 `features/<feature>/store/<feature>-slice.ts`，用 `createSlice` 编写；禁止在 slice 之外手写 reducer 与 action type 字符串。
- 类型化 hooks 在 `src/app/hooks.ts` 定义：`useDispatch.withTypes<AppDispatch>()`、`useSelector.withTypes<RootState>()`；
  组件只用 `useAppDispatch` / `useAppSelector`，禁止直接使用未类型化的 `useDispatch` / `useSelector`。
- selector 与 slice 同文件导出（`selectXxx`），派生数据用 `createSelector` 记忆化；组件只选择所需字段，禁止返回整个 slice。
- 服务器数据用 RTK Query（`createApi` + `fetchBaseQuery` 或基于 `shared/api` 的 baseQuery）管理，按 feature 注入 endpoints；
  禁止把接口结果复制进普通 slice。
- 异步业务流程用 `createAsyncThunk` 或 RTK Query mutation，reducer 保持纯函数，禁止在 reducer 里发请求、读时间或随机数。
- state 只放可序列化数据，禁止存放 class 实例、函数、Promise。
- 测试用真实 `configureStore` 构造 store 断言 dispatch 后的 state，组件测试用 Provider 包裹真实 store。
{{catalog.ref}}
