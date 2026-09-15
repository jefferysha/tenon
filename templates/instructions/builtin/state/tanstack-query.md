---
id: tanstack-query
category: state
title: TanStack Query
frameworks: [react, vue]
catalog_ref: tanstack-query
---
### 状态管理（TanStack Query）

- 使用 TanStack Query 5（React 用 `@tanstack/react-query`，Vue 用 `@tanstack/vue-query`）管理全部服务器数据；
  应用壳只创建一个 `QueryClient`，统一设置 `staleTime`、`retry` 默认值。
- 每个 feature 在 `api/` 中维护 query key 工厂（如 `orderKeys.all`、`orderKeys.detail(id)`）与 `queryOptions`，
  组件禁止手写 key 数组。
- 查询函数只调用 `shared/api` 的接口函数，拿到的是解包后的 `data`；错误沿用统一的类型化错误。
- 数据修改用 `useMutation`，成功后按 key 工厂 `invalidateQueries` 精确失效相关查询；乐观更新必须在 `onError` 回滚。
- 禁止把查询结果复制进客户端 store（Zustand、Pinia 等）或组件 state；需要派生时用 `select`。
- 列表分页用 `placeholderData: keepPreviousData`，无限滚动用 `useInfiniteQuery`，参数进 query key。
- 界面显式处理 `isPending`、`isError`、空数据三种状态；需要 Suspense 时用 `useSuspenseQuery`。
- 测试中每个用例创建新的 `QueryClient`（关闭重试），接口请求用 MSW 拦截。
{{catalog.ref}}
