---
id: angular-signals
category: state
title: Angular Signals
frameworks: [angular]
catalog_ref: angular-signals
---
### 状态管理（Angular Signals）

- 每个 feature 在 `data-access/` 中写状态服务（`xxx.state.ts`），默认在 feature 路由的 `providers` 中提供，确需全局单例时 `providedIn: 'root'`。
- 服务内部用私有 `signal()` 保存状态，对外只暴露 `asReadonly()` 的只读 signal 与修改方法，组件禁止直接 `set` 服务的状态。
- 派生状态一律用 `computed()`；依赖其它 signal 又需要可写时用 `linkedSignal()`；禁止用 `effect()` 在 signal 之间同步值。
- `effect()` 只用于与非响应式 API 同步（日志、`localStorage`、第三方库、手写 DOM），并在注入上下文中创建。
- 更新用 `set()` / `update()` 且保持不可变：数组、对象返回新引用，禁止原地修改后再写回同一引用。
- 异步数据用 `resource()` 或 `HttpClient` + `toSignal()` 接入，模板显式处理加载与错误状态。
- 禁止用 `BehaviorSubject` / `Subject` 保存状态；与 RxJS 流交界处用 `toSignal()` / `toObservable()` 转换。
- 组件输入输出用 `input()` / `input.required()` / `output()` / `model()`，模板直接调用 signal 读取值。
{{catalog.ref}}
