---
id: ngrx-signals
category: state
title: NgRx SignalStore
frameworks: [angular]
catalog_ref: ngrx-signals
---
### 状态管理（NgRx SignalStore）

- 使用 `@ngrx/signals`，大版本与 Angular 保持一致；每个 feature 在 `data-access/` 中定义一个 `signalStore`，文件名 `xxx.store.ts`。
- store 由 `withState`、`withComputed`、`withMethods` 组合；派生状态只写在 `withComputed`，组件禁止重复计算。
- 状态只在 `withMethods` 的方法内用 `patchState` 更新；组件与其它 store 禁止直接调用 `patchState`。
- 副作用（HTTP、防抖搜索）用 `rxMethod` 包装，管道内用 `switchMap` / `concatMap` / `exhaustMap` 明确并发策略，
  用 `@ngrx/operators` 的 `tapResponse` 同时处理成功与失败。
- 集合数据用 `withEntities` 管理，禁止手写数组的增删改查。
- 初次加载等生命周期逻辑写在 `withHooks({ onInit })`。
- 多个 store 复用的行为抽成 `signalStoreFeature`，跨 feature 共享时放在 `shared/data-access/`。
- store 默认在 feature 路由或组件的 `providers` 中提供，确需全局单例时 `{ providedIn: 'root' }`。
- 测试通过 `TestBed.inject` 获取 store 断言 signal 值，HTTP 用 `provideHttpClientTesting` 模拟。
{{catalog.ref}}
