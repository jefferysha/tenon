---
id: typescript-vue3
category: frontend
title: TypeScript + Vue 3
frameworks: [vue]
directory: frontend/
directory_label: 前端工程根目录
catalog: [component-lib, icons, design-md]
variables:
  - key: component.soft
    default: 200
  - key: component.hard
    default: 350
  - key: module.soft
    default: 250
  - key: module.hard
    default: 400
---
## 前端（TypeScript + Vue 3）

### 技术栈

TypeScript + Vue 3.5 + Vue Router + Vite 8 + pnpm 12 + Axios，开发与构建环境为 Node.js 24 LTS。

- TypeScript 版本跟随 `vue-tsc` 支持的范围，升级前先确认 `vue-tsc` 已支持。
- 包管理只用 pnpm，提交 `pnpm-lock.yaml`，禁止混用 npm / yarn；`package.json` 的 `packageManager` 字段固定 pnpm 版本。
- 开发服务器与构建只用 Vite；环境变量只通过 `import.meta.env.VITE_*` 读取，禁止把密钥、令牌写进前端代码。
- UI 组件优先使用所选组件库，统一放在 `src/shared/ui/`；图标只从所选图标库按需引入，禁止整包引入。
- 全局状态与样式按本章「状态管理」「样式」小节执行；未选择时组件内状态用 `ref` / `reactive`，样式沿用项目现有方案。
- 项目根目录存在 `DESIGN.md` 时，颜色、字体、间距、圆角、阴影以其中的设计体系为准。
{{catalog.component-lib}}
{{catalog.icons}}
{{catalog.design-md}}

### 分层结构

feature-first 分层（强制）：

```
frontend/src/
├── app/                   # 应用壳：main.ts、App.vue、路由、全局插件、布局
├── features/
│   └── <feature>/         # 一个业务能力一个目录，kebab-case
│       ├── api/           # 该 feature 的接口函数与请求/响应类型
│       ├── components/    # 该 feature 的组件（.vue）
│       ├── composables/   # 该 feature 的组合式函数（useXxx）
│       ├── stores/        # 该 feature 的全局状态
│       ├── types/         # 该 feature 的领域类型
│       ├── utils/         # 该 feature 的纯函数
│       └── index.ts       # 对外公开的唯一出口
└── shared/
    ├── ui/                # 组件库组件与通用展示组件
    ├── api/               # Axios 实例、拦截器、统一响应类型
    ├── composables/ lib/ types/ config/
```

依赖规则：

- `app` → `features` → `shared`，只能单向依赖。
- feature 之间只能通过对方的 `index.ts` 引用，禁止深层路径引用（如 `features/order/components/...`）；
  出现循环依赖时把共用部分下沉到 `shared` 或拆出新 feature。
- `shared` 禁止引用 `features` 和 `app`。
- 新代码先判断归属的 feature；确实跨多个 feature 复用的才放 `shared`。
- 依赖方向用 ESLint 规则（`import/no-restricted-paths` 或同类规则）强制，禁止靠约定。

### 编码规范

- `tsconfig` 开启 `strict`、`noUncheckedIndexedAccess`、`noImplicitOverride`；类型检查用 `vue-tsc --noEmit`（`pnpm typecheck`）；
  禁止 `any`，确需时用 `unknown` 并收窄；禁止 `@ts-ignore`，确需时用 `@ts-expect-error` 并写原因。
- 单文件组件一律 `<script setup lang="ts">`，只用 Composition API；禁止 Options API、mixin 与全局事件总线。
- 组件文件名 PascalCase 且为多词（如 `OrderList.vue`），组合式函数以 `use` 开头，其他文件 kebab-case。
- Props 与事件用类型声明：`defineProps<Props>()`、`defineEmits<{ … }>()`；默认值用 props 解构默认值，禁止运行时数组写法。
- 禁止修改 props；需要双向绑定时用 `defineModel()`。
- 派生数据用 `computed`；`watch` / `watchEffect` 只用于副作用（请求、与外部系统同步），禁止用 watch 同步两份状态。
- `v-for` 必须以稳定 id 作为 `:key`，禁止用索引；`v-if` 与 `v-for` 不写在同一元素上。
- 模板插值 `\{{ }}` 与指令表达式只做简单读取，超过一个运算的逻辑移到 `computed`；禁止 `v-html` 渲染未净化的内容。
- 状态就近放置：组件内状态用 `ref` / `reactive`；跨组件共享才进全局状态，按 feature 拆分。
- 接口调用只经 `shared/api` 的 Axios 实例：统一 `baseURL=/api/v1`、超时、鉴权头、错误拦截；
  拦截器把 `{code, msg, data}` 解包，`code` 非成功时抛出带 `code` 与 `msg` 的类型化错误；
  禁止在组件中直接调用 `axios`。
- 请求与响应类型与后端接口一一对应，分页统一使用 `PageResult<T> = {page, pageSize, total, items: T[]}`。
- 每个异步界面显式处理加载、空数据、错误、成功四种状态；路由组件用 `() => import()` 懒加载。
- 可访问性：交互元素使用语义标签或组件库组件，图片有 `alt`，表单控件有 label，可键盘操作。
- 使用 ESLint 10（`eslint.config.js` + `eslint-plugin-vue`）+ Prettier，提交前 `pnpm lint`、`pnpm typecheck`、`pnpm test` 必须通过。

### 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| 组件 `.vue` | {{component.soft}} 行 | {{component.hard}} 行 |
| 其他 `.ts`（composables、stores、api、utils） | {{module.soft}} 行 | {{module.hard}} 行 |

- 行数按文件总行数计算（含空行和注释）。
- 达到「必须拆分」而不能拆分时，在回复中给出理由（例如生成代码、单一大型配置表），并在文件顶部注释说明。
- 优先按职责拆分：子组件、组合式函数、纯函数、类型文件。

### 测试要求

- 单元与组件测试用 Vitest 5 + Vue Test Utils（`@vue/test-utils`）+ jsdom；测试文件与被测文件同目录，命名 `*.test.ts`。
- 断言用户可见的行为（文本、角色、发出的事件），禁止按 CSS 类名或组件内部实例状态断言。
- 每个组合式函数、store、`utils` 纯函数、`shared/api` 的解包与错误分支必须有单元测试；组件测试覆盖加载、空数据、错误、成功四种状态。
- 测试中的接口请求用 MSW 拦截，禁止访问真实网络。
- 核心业务流程用 Playwright 写端到端测试，放在 `frontend/e2e/`；改动涉及这些流程时 `pnpm test:e2e` 必须通过。
- 修复缺陷先写能复现缺陷的失败测试，再修改实现。
- 提交前 `pnpm lint`、`pnpm typecheck`、`pnpm test` 必须通过。
