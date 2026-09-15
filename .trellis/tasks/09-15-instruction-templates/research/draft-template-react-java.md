# AGENTS.md

<!-- 基准模板草稿：前端 TS + React（feature-first）+ 后端 Java 21 + Spring Boot 4 DDD 多模块 + PostgreSQL。
     花括号中的值是模板变量及默认值，应用到项目时替换。 -->

## 1. 最终回复格式

每次完成改动后的最终回复必须包含：

- **改动摘要**：做了什么、为什么这样做。
- **受影响文件**：关键文件路径及其变化（新增 / 修改 / 删除）。
- **验证命令与结果**：实际运行的命令和结果摘要；未运行的说明原因。
- **未验证项、剩余风险、需要用户决策的事项**。
- 涉及架构、分层或包边界时，给出对应的架构自检结论（前端 feature-first 分层、后端 DDD 分层与模块依赖方向）；
  不涉及时不写形式化的「不适用」说明。

## 2. 目录约束

| 目录 | 内容 |
| --- | --- |
| `frontend/` | 前端工程根目录 |
| `backend/` | 后端工程根目录（Gradle 多模块） |
| `sql/` | 全部数据库初始化脚本 |

- 不得在上述目录之外新增前端、后端或数据库代码。
- 根目录只放仓库级配置与文档（本文件、README、`.gitignore`、CI 配置等）。

## 3. 前端

### 3.1 技术栈

TypeScript + React + Node.js + pnpm + shadcn/ui + Tailwind CSS + Zustand + Axios。

- 包管理只用 pnpm，提交 `pnpm-lock.yaml`，禁止混用 npm / yarn。
- UI 组件优先使用 shadcn/ui，放在 `src/shared/ui/`；样式只用 Tailwind 工具类，禁止新增全局 CSS（主题变量除外）。
- 全局 / 跨组件状态用 Zustand；服务器数据经 Axios 获取。

### 3.2 feature-first 分层（强制）

```
frontend/src/
├── app/                 # 应用壳：入口、路由、全局 Provider、布局
├── features/
│   └── <feature>/       # 一个业务能力一个目录，kebab-case
│       ├── api/         # 该 feature 的接口函数与请求/响应类型
│       ├── components/  # 该 feature 的组件
│       ├── hooks/       # 该 feature 的 hooks
│       ├── store/       # 该 feature 的 Zustand store
│       ├── types/       # 该 feature 的领域类型
│       ├── utils/       # 该 feature 的纯函数
│       └── index.ts     # 对外公开的唯一出口
└── shared/
    ├── ui/              # shadcn/ui 与通用展示组件
    ├── api/             # Axios 实例、拦截器、统一响应类型
    ├── hooks/ lib/ types/ config/
```

依赖规则：

- `app` → `features` → `shared`，只能单向依赖。
- feature 之间只能通过对方的 `index.ts` 引用，禁止深层路径引用（如 `features/order/components/...`）；
  出现循环依赖时把共用部分下沉到 `shared` 或拆出新 feature。
- `shared` 禁止引用 `features` 和 `app`。
- 新代码先判断归属的 feature；确实跨多个 feature 复用的才放 `shared`。

### 3.3 TypeScript + React 编码规范

- `tsconfig` 开启 `strict`、`noUncheckedIndexedAccess`、`noImplicitOverride`；禁止 `any`，确需时用 `unknown` 并收窄；
  禁止 `@ts-ignore`，确需时用 `@ts-expect-error` 并写原因。
- 只写函数组件和 hooks；组件文件名 PascalCase，hooks 以 `use` 开头，其他文件 kebab-case；除页面路由约定外使用具名导出。
- Props 用 `type` 显式声明；禁止在组件内定义组件；列表 `key` 使用稳定 id，禁止用数组下标。
- 遵守 Hooks 规则（启用 `eslint-plugin-react-hooks`）；`useEffect` 只用于与外部系统同步，派生数据直接计算，
  不要用 effect 同步 state。
- 状态就近放置：组件内状态用 `useState`；跨组件共享才进 Zustand；store 按 feature 拆分，只暴露 selector 与 action，
  组件用 selector 订阅所需字段。
- 接口调用只经 `shared/api` 的 Axios 实例：统一 `baseURL=/api/v1`、超时、鉴权头、错误拦截；
  拦截器把 `{code, msg, data}` 解包，`code` 非成功时抛出带 `code` 与 `msg` 的类型化错误；
  禁止在组件中直接调用 `axios`。
- 请求与响应类型与后端接口一一对应，分页统一使用 `PageResult<T> = {page, pageSize, total, items: T[]}`。
- 可访问性：交互元素使用语义标签或 shadcn/ui 组件，图片有 `alt`，表单控件有 label。
- 使用 ESLint + Prettier，提交前 `pnpm lint`、`pnpm typecheck`、`pnpm test` 必须通过。

### 3.4 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| 组件 `.tsx` | {frontend.component.soft = 200} 行 | {frontend.component.hard = 350} 行 |
| 其他 `.ts`（hooks、store、api、utils） | {frontend.module.soft = 250} 行 | {frontend.module.hard = 400} 行 |

- 行数按文件总行数计算（含空行和注释）。
- 达到「必须拆分」而不能拆分时，在回复中给出理由（例如生成代码、单一大型配置表），并在文件顶部注释说明。
- 优先按职责拆分：子组件、自定义 hook、纯函数、类型文件。

## 4. 后端

### 4.1 技术栈

Java 21 + Spring Boot 4.x + Gradle（Groovy DSL）+ PostgreSQL + Spring Data JPA，多模块工程。

### 4.2 严格 DDD 分层与模块划分

```
backend/
├── settings.gradle
├── build.gradle
├── {app}-domain/          # 领域层：聚合、实体、值对象、领域服务、领域事件、仓储接口
├── {app}-application/     # 应用层：用例服务、命令/查询对象、事务边界、DTO 装配
├── {app}-infrastructure/  # 基础设施层：JPA 实体与仓储实现、外部系统适配
├── {app}-interfaces/      # 接口层：REST Controller、请求/响应模型、参数校验、异常映射
└── {app}-bootstrap/       # 启动模块：Spring Boot 入口与配置装配
```

依赖方向（由 Gradle 依赖强制）：

- `interfaces` → `application` → `domain`
- `infrastructure` → `domain`（实现仓储接口），`infrastructure` → `application`（仅在实现应用层端口时）
- `bootstrap` 依赖全部模块，只做装配
- `domain` 不依赖任何其他模块，不引用 Spring、JPA、Jackson 等框架类型

规则：

- 按限界上下文分包：`com.{company}.{app}.<context>.<layer>`。
- 聚合通过聚合根修改，跨聚合只按 id 引用；一个事务只修改一个聚合，跨聚合一致性用领域事件。
- 业务规则写在领域对象和领域服务中；应用服务只编排、不写业务判断；Controller 只做协议转换。
- 领域模型与 JPA 持久化模型分离：JPA `@Entity` 只放在 infrastructure，通过映射器与领域对象互转。
- 仓储接口定义在 domain，以领域语言命名；Spring Data 接口只在 infrastructure 内部使用。

### 4.3 Java + Spring Boot 编码规范

- 使用构造器注入，依赖声明为 `final`；禁止字段注入。
- 值对象、命令、查询、DTO 优先使用 `record`；领域实体保持封装，禁止公开 setter 暴露内部状态。
- 事务注解只放在应用层服务方法上；只读查询使用 `@Transactional(readOnly = true)`。
- 禁止在 Controller 或领域层捕获异常后吞掉；业务异常继承统一业务异常基类，由 `@RestControllerAdvice` 映射为统一响应。
- 参数校验使用 Jakarta Validation 注解，在接口层完成。
- 返回集合时返回空集合而不是 `null`；可能缺失的单值使用 `Optional`，但不用于字段和参数。
- JPA：禁止 `FetchType.EAGER`；避免 N+1，关联查询使用 fetch join 或实体图；乐观锁使用 `@Version` 映射 `version` 字段；
  `spring.jpa.hibernate.ddl-auto` 只能是 `none` 或 `validate`。
- 日志使用 SLF4J 占位符，禁止输出密码、令牌等敏感信息。
- 时间统一使用 `OffsetDateTime` / `Instant`，数据库为 `timestamptz`。
- 构建时 `./gradlew build` 必须通过（编译、测试、静态检查）。

### 4.4 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| Java 类 / 接口 / record | {backend.class.soft = 300} 行 | {backend.class.hard = 500} 行 |
| 单个方法 | {backend.method.soft = 40} 行 | {backend.method.hard = 80} 行 |

- 达到「必须拆分」而不能拆分时，在回复中给出理由，并在类注释中说明。
- 优先按职责拆分：值对象、领域服务、策略、独立用例服务。

## 5. 接口约定

- 所有接口统一使用 `/api/v1` 前缀。
- 返回格式统一为：

```json
{ "code": 0, "msg": "success", "data": {} }
```

- 分页数据返回格式：

```json
{ "code": 0, "msg": "success", "data": { "page": 1, "pageSize": 20, "total": 0, "items": [] } }
```

- `code` 为 int，`total` 为 long；成功码与错误码表在后端统一定义，前端 Axios 拦截器按同一张表处理。

## 6. 数据库

- 所有初始化脚本放在 `sql/` 目录，按执行顺序编号命名（如 `sql/001_init_schema.sql`）；
  禁止使用 Flyway、Liquibase 等迁移框架。
- 每张表必须包含：

```sql
id         bigint generated by default as identity primary key,
version    bigint      not null default 0,
created_at timestamptz not null,
updated_at timestamptz not null
```

- 禁止软删除（不得出现 `deleted`、`is_deleted`、`deleted_at` 等删除标记字段）。
- 所有表和字段必须有中文注释（`COMMENT ON TABLE` / `COMMENT ON COLUMN`）。
- 禁止使用存储过程；除维护 `created_at`、`updated_at` 的触发器外，禁止定义和使用任何其他触发器。
- 必须符合第三范式；确需反范式设计时，在表或字段注释以及回复中写明理由。
- 新增表之前必须梳理已有表的字段与关联关系，能用已有表表达的不得新增表；新增时在回复中说明梳理结论。
