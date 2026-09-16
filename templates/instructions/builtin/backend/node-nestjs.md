---
id: node-nestjs
category: backend
title: Node.js + NestJS
directory: backend/
directory_label: 后端工程根目录
variables:
  - key: file.soft
    default: 300
  - key: file.hard
    default: 500
  - key: method.soft
    default: 40
  - key: method.hard
    default: 80
---
## 后端（Node.js + NestJS）

### 技术栈

Node.js 24 LTS + NestJS 12 + TypeScript（strict）+ Prisma ORM + PostgreSQL，包管理用 pnpm。

- 包管理只用 pnpm，提交 `pnpm-lock.yaml`，`package.json` 的 `packageManager` 与 `engines.node` 固定版本。
- TypeScript 版本跟随 NestJS CLI 支持的范围；静态检查用 ESLint（`typescript-eslint` 类型感知规则）+ Prettier。
- Prisma schema 由 `prisma db pull` 从数据库反向生成，再 `prisma generate` 生成客户端；表结构变更遵循「数据库」章节，
  禁止使用 `prisma migrate` 与 `prisma db push`。
- 配置用 `@nestjs/config` 读取环境变量，并在启动时按 schema 校验，缺失即启动失败。

### 分层结构

```
backend/
├── package.json
├── pnpm-lock.yaml
├── prisma/schema.prisma          # 反向生成的数据模型，禁止手工改表结构
├── src/
│   ├── main.ts                   # 启动：全局前缀 api/v1、ValidationPipe、异常过滤器、响应拦截器
│   ├── app.module.ts
│   ├── common/                   # 统一响应、业务异常、异常过滤器、响应拦截器、分页类型
│   ├── infrastructure/prisma/    # PrismaService：PrismaClient 生命周期
│   └── modules/
│       └── <context>/
│           ├── domain/           # 实体、值对象、领域服务、仓储接口（不引用 Nest 与 Prisma）
│           ├── application/      # 用例服务、命令/查询、事务边界
│           ├── infrastructure/   # Prisma 仓储实现、外部系统适配
│           ├── interfaces/       # Controller、请求/响应 DTO
│           └── <context>.module.ts
└── test/                         # e2e 测试
```

依赖规则：

- `interfaces` → `application` → `domain`；`infrastructure` → `domain`（实现仓储接口）；`<context>.module.ts` 负责装配。
- `domain` 禁止导入 `@nestjs/*`、`@prisma/client` 与任何 `infrastructure` 代码。
- 模块之间只通过对方 module `exports` 的 application 服务调用，禁止深层路径导入对方内部文件。
- 依赖方向用 ESLint `import/no-restricted-paths`（或 dependency-cruiser）强制，禁止靠约定。

### 编码规范

- `tsconfig` 开启 `strict`、`noUncheckedIndexedAccess`、`noImplicitOverride`；禁止 `any`，确需时用 `unknown` 并收窄；禁止 `@ts-ignore`。
- 依赖用构造函数注入并声明 `private readonly`；仓储接口用注入 token（`Symbol`）+ `@Inject(ORDER_REPOSITORY)` 绑定实现。
- 请求 DTO 用 class-validator + class-transformer；全局 `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`。
- 全局异常过滤器把业务异常与校验失败转换为 `{code, msg, data}`，响应拦截器包装成功结果；Controller 禁止手工拼响应。
- `app.setGlobalPrefix('api/v1')`；分页返回 `PageResult<T>`（`page`、`pageSize`、`total`、`items`）。
- Controller 只做协议转换；业务规则写在 `domain`，`application` 只编排与划定事务。
- Prisma 只在 `infrastructure` 使用：显式 `select` 需要的字段，关联数据用 `include` 一次取回，禁止循环内查询；
  事务用 `prisma.$transaction(async (tx) => …)` 并把 `tx` 传给同一事务内的仓储。
- 乐观锁：更新时以 `version` 作为条件并自增，受影响行数为 0 时抛冲突异常。
- 原生 SQL 只用 `$queryRaw` 模板字符串绑定参数，禁止 `$queryRawUnsafe` 与字符串拼接。
- 禁止悬空 Promise（启用 `@typescript-eslint/no-floating-promises`）；禁止在请求路径中使用同步阻塞 API。
- 日志用 Nest `Logger`，禁止记录密码、令牌等敏感信息。
- 时间在接口中用 ISO 8601 字符串（UTC），数据库为 `timestamptz`。
- `pnpm lint`、`pnpm build`、`pnpm test`、`pnpm test:e2e` 必须通过。

### 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| TypeScript 文件 | {{file.soft}} 行 | {{file.hard}} 行 |
| 单个方法 | {{method.soft}} 行 | {{method.hard}} 行 |

- 行数按文件总行数计算（含空行和注释），Prisma 生成代码不计。
- 达到「必须拆分」而不能拆分时，在回复中给出理由，并在文件注释中说明。
- 优先按职责拆分：领域服务、独立用例、仓储查询、DTO 文件。

### 测试要求

- 测试框架：Vitest 或 Jest（二选一并在 `package.json` 固定）+ `@nestjs/testing`；e2e 用 supertest 调用 `INestApplication`。
- `domain` 必须有纯单元测试，不创建 Nest 测试模块；`application` 用假仓储替换注入 token，覆盖成功与每个失败分支。
- 仓储实现用 Testcontainers 启动真实 PostgreSQL，执行 `sql/` 脚本后测试查询、事务与乐观锁，禁止用 SQLite 替代。
- e2e 测试覆盖参数校验失败、业务异常、成功三类响应，断言统一响应结构、错误码与分页字段。
- 修复缺陷先写能复现缺陷的失败测试。
- `pnpm test` 与 `pnpm test:e2e` 必须通过；集成测试依赖 Docker，本机无法运行时在回复中写明未运行的测试。
