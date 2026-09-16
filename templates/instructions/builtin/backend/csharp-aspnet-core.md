---
id: csharp-aspnet-core
category: backend
title: C# + ASP.NET Core
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
## 后端（C# + ASP.NET Core）

### 技术栈

.NET 10 LTS + ASP.NET Core + EF Core（Npgsql 提供程序）+ PostgreSQL。

- `global.json` 固定 SDK 版本；`Directory.Build.props` 统一开启 `<Nullable>enable</Nullable>`、`<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`、
  `<AnalysisLevel>latest</AnalysisLevel>`；`Directory.Packages.props` 中央管理包版本，禁止在项目文件里写版本号。
- 配置用 Options 模式绑定并 `ValidateOnStart()`；本地密钥用 user-secrets，部署用环境变量，禁止写入 `appsettings.json`。
- 表结构变更遵循「数据库」章节；禁止 EF Core 迁移、`EnsureCreated()` 与 `Database.Migrate()`，映射按已有表手写或用 `dotnet ef dbcontext scaffold` 生成。

### 分层结构

```
backend/
├── global.json
├── Directory.Build.props
├── Directory.Packages.props
├── src/
│   ├── App.Domain/              # 实体、值对象、领域事件、领域异常、仓储接口（不引用 EF Core 与 ASP.NET Core）
│   ├── App.Application/         # 用例（命令/查询处理）、DTO record、端口接口、事务边界
│   ├── App.Infrastructure/      # DbContext、IEntityTypeConfiguration 映射、仓储实现、外部服务
│   └── App.Api/                 # Program.cs 装配、路由组 /api/v1、端点或 Controller、统一响应、异常处理
└── tests/
    ├── App.Domain.Tests/
    ├── App.Application.Tests/
    └── App.Api.IntegrationTests/
```

依赖方向（由项目引用强制）：

- `App.Api` → `App.Application` → `App.Domain`；`App.Infrastructure` → `App.Application`、`App.Domain`。
- `App.Api` 引用 `App.Infrastructure` 只用于在 `Program.cs` 注册依赖，端点代码禁止直接使用 `DbContext`。
- `App.Domain` 禁止引用任何其它项目与 `Microsoft.EntityFrameworkCore`、`Microsoft.AspNetCore.*` 包。
- 另用架构测试（NetArchTest.Rules 或反射断言）锁定上述规则。

### 编码规范

- 命令、查询、DTO 用 `record`；领域实体属性 `private set`，通过工厂方法与行为方法修改状态。
- 异步一路到底：I/O 方法返回 `Task` 并接收 `CancellationToken` 往下传；禁止 `.Result`、`.Wait()` 与 `async void`。
- 依赖用构造函数（可用主构造函数）注入；`DbContext` 注册为 Scoped；禁止服务定位器（在业务代码里调用 `IServiceProvider`）。
- 禁止空值宽容运算符 `!`，确需时写注释说明原因；公开 API 不返回 `null` 集合。
- 全局 `IExceptionHandler` 把业务异常、校验失败与未处理异常统一转换为 `{code, msg, data}`，不直接把 ProblemDetails 返回给前端。
- 所有端点挂在 `app.MapGroup("/api/v1")` 下；分页返回 `PageResult<T>`（`page`、`pageSize`、`total`、`items`），JSON 使用 camelCase。
- 请求模型在 `App.Api` 校验（DataAnnotations 或 FluentValidation 二选一），`App.Application` 再校验业务不变量。
- EF Core：禁止懒加载代理；读查询用 `AsNoTracking()` 并投影为 DTO（`Select`），需要关联时显式 `Include`；
  映射写在 `IEntityTypeConfiguration<T>`，`version` 列配置为并发令牌。
- 事务边界在应用层用例中，通过 `SaveChangesAsync` 或显式事务提交；禁止 `FromSqlRaw` 拼接字符串，原生 SQL 用 `FromSql` 插值参数。
- 日志用 `ILogger<T>` 消息模板（`"订单 {OrderId} 已创建"`），禁止字符串插值与记录敏感信息。
- 时间统一 `DateTimeOffset`（UTC），数据库为 `timestamptz`。
- `dotnet format --verify-no-changes`、`dotnet build -warnaserror`、`dotnet test` 必须通过。

### 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| C# 文件 | {{file.soft}} 行 | {{file.hard}} 行 |
| 单个方法 | {{method.soft}} 行 | {{method.hard}} 行 |

- 行数按文件总行数计算（含空行和注释），scaffold 生成的映射代码不计。
- 达到「必须拆分」而不能拆分时，在回复中给出理由，并在类注释中说明。
- 优先按职责拆分：值对象、领域服务、独立用例处理器、实体映射配置。

### 测试要求

- 测试框架：xUnit v3（`xunit.v3`）+ Shouldly + NSubstitute；FluentAssertions 8 起需要商业许可，禁止引入。
- `App.Domain.Tests` 覆盖实体、值对象、领域服务的每条不变量；`App.Application.Tests` 用替身替换端口，覆盖成功与每个失败分支。
- `App.Api.IntegrationTests` 用 `WebApplicationFactory<Program>` + Testcontainers（`Testcontainers.PostgreSql`）启动真实 PostgreSQL，
  执行 `sql/` 脚本后测试端点、事务与并发冲突；禁止使用 EF Core InMemory 或 SQLite 提供程序替代。
- 集成测试断言 HTTP 状态、统一响应结构、错误码与分页字段，参数校验失败与业务异常都要覆盖。
- 修复缺陷先写能复现缺陷的失败测试。
- `dotnet test` 必须通过；集成测试依赖 Docker，本机无法运行时在回复中写明未运行的测试。
