---
id: typescript-angular
category: frontend
title: TypeScript + Angular
frameworks: [angular]
directory: frontend/
directory_label: 前端工程根目录
catalog: [component-lib, icons, design-md]
variables:
  - key: component.soft
    default: 250
  - key: component.hard
    default: 400
  - key: template.soft
    default: 150
  - key: template.hard
    default: 300
---
## 前端（TypeScript + Angular）

### 技术栈

TypeScript + Angular 22（standalone 组件 + signals + zoneless）+ Angular CLI + pnpm 12，开发与构建环境为 Node.js 24 LTS。

- 包管理只用 pnpm，提交 `pnpm-lock.yaml`，禁止混用 npm / yarn；`angular.json` 的 `cli.packageManager` 设为 `pnpm`。
- TypeScript 版本跟随 Angular CLI 要求，升级 Angular 用 `ng update`，禁止手工改版本号跳过迁移脚本。
- 新代码一律 standalone，禁止新增 `NgModule`；变更检测保持 zoneless，禁止重新引入 `zone.js`。
- UI 组件优先使用所选组件库，统一在 `src/app/shared/ui/` 封装；图标只从所选图标库按需引入。
- 全局状态与样式按本章「状态管理」「样式」小节执行；未选择时组件内状态用 `signal()`，样式沿用项目现有方案。
- 项目根目录存在 `DESIGN.md` 时，颜色、字体、间距、圆角、阴影以其中的设计体系为准。
{{catalog.component-lib}}
{{catalog.icons}}
{{catalog.design-md}}

### 分层结构

按 feature 分层（强制）：

```
frontend/src/app/
├── app.config.ts          # provideRouter、provideHttpClient(withInterceptors(...)) 等全局 provider
├── app.routes.ts          # 顶层路由，feature 路由一律 loadChildren / loadComponent 懒加载
├── core/                  # 单例：拦截器、鉴权、错误处理、应用壳布局
├── features/
│   └── <feature>/         # 一个业务能力一个目录，kebab-case
│       ├── feature/       # 路由页面与容器组件（注入 data-access，编排 ui）
│       ├── ui/            # 纯展示组件：只通过 input() / output() 通信
│       ├── data-access/   # 接口服务、状态、请求/响应类型
│       ├── util/          # 该 feature 的纯函数
│       └── <feature>.routes.ts
└── shared/
    ├── ui/                # 组件库封装与通用展示组件
    ├── data-access/       # 统一响应类型、HTTP 基础服务
    └── util/
```

依赖规则：

- `core` / `features` → `shared`，`app.routes.ts` → `features`；`shared` 禁止引用 `features` 与 `core`。
- feature 内部：`feature` → `ui` / `data-access` / `util`；`ui` 禁止注入 `data-access`，`data-access` 禁止引用 `ui` 与 `feature`。
- feature 之间只能通过对方 `<feature>.routes.ts` 或 `data-access` 的公开导出引用，禁止深层路径引用。
- 依赖方向用 ESLint 规则（`@nx/enforce-module-boundaries` 或 `import/no-restricted-paths`）强制，禁止靠约定。

### 编码规范

- `tsconfig` 开启 `strict`、`noUncheckedIndexedAccess`、`noImplicitOverride`，`angularCompilerOptions` 开启 `strictTemplates`；
  禁止 `any`，确需时用 `unknown` 并收窄；禁止 `@ts-ignore`，确需时用 `@ts-expect-error` 并写原因。
- 组件一律 `changeDetection: ChangeDetectionStrategy.OnPush`；输入输出用 `input()` / `input.required()` / `output()` / `model()`，
  禁止 `@Input()` / `@Output()` 装饰器。
- 依赖注入用 `inject()`，禁止构造函数参数注入；拦截器、守卫、解析器写成函数式（`HttpInterceptorFn`、`CanActivateFn`）。
- 模板使用内置控制流 `@if` / `@for` / `@switch`，`@for` 必须写 `track` 稳定 id，禁止 `*ngIf` / `*ngFor`。
- 模板插值 `\{{ }}` 只读取 signal 或简单属性，禁止在模板里调用有副作用或开销大的方法；派生值写成 `computed()`。
- 手动订阅 Observable 必须用 `takeUntilDestroyed()` 释放；能在模板里消费的流用 `toSignal()` 转换，禁止在组件里嵌套 `subscribe`。
- 接口调用只经 `HttpClient` 与 `core` 中的函数式拦截器：统一 `/api/v1` 前缀、超时、鉴权头；
  拦截器把 `{code, msg, data}` 解包，`code` 非成功时抛出带 `code` 与 `msg` 的类型化错误；组件禁止直接注入 `HttpClient`。
- 请求与响应类型与后端接口一一对应，分页统一使用 `PageResult<T> = {page, pageSize, total, items: T[]}`。
- 表单使用类型化响应式表单（`FormGroup<…>` / `NonNullableFormBuilder`），校验规则与后端参数校验对齐。
- 禁止 `bypassSecurityTrust*` 渲染未净化的内容；禁止直接操作 DOM，确需时用 `Renderer2` 或 `afterNextRender`。
- 每个异步界面显式处理加载、空数据、错误、成功四种状态；可访问性遵守 Angular CDK a11y 与语义标签。
- 文件命名 kebab-case 并带类型后缀（`order-list.component.ts`、`order.service.ts`）；提交前 `pnpm lint`、`pnpm test`、`pnpm build` 必须通过。

### 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| 组件 `.ts` | {{component.soft}} 行 | {{component.hard}} 行 |
| 模板 `.html` | {{template.soft}} 行 | {{template.hard}} 行 |

- 行数按文件总行数计算（含空行和注释）。
- 达到「必须拆分」而不能拆分时，在回复中给出理由（例如生成代码、单一大型配置表），并在文件顶部注释说明。
- 优先按职责拆分：`ui` 子组件、`data-access` 服务、纯函数、类型文件。

### 测试要求

- 单元与组件测试用 Angular CLI 默认的 Vitest（`ng test`），组件测试用 `TestBed` + 组件 harness 或 Testing Library；
  测试文件与被测文件同目录，命名 `*.spec.ts`。
- HTTP 用 `provideHttpClient()` + `provideHttpClientTesting()` 与 `HttpTestingController` 断言请求，禁止访问真实网络。
- 每个 `data-access` 服务、状态、拦截器解包与错误分支、`util` 纯函数必须有单元测试；`feature` 组件测试覆盖加载、空数据、错误、成功四种状态。
- 断言用户可见的行为（文本、角色、发出的事件），禁止按 CSS 类名或组件私有字段断言。
- 核心业务流程用 Playwright 写端到端测试，放在 `frontend/e2e/`；改动涉及这些流程时 `pnpm test:e2e` 必须通过。
- 修复缺陷先写能复现缺陷的失败测试，再修改实现。
- 提交前 `pnpm lint`、`pnpm test`、`pnpm build` 必须通过。
