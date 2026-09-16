---
id: go
category: backend
title: Go
directory: backend/
directory_label: 后端工程根目录
variables:
  - key: app
    default: app
  - key: file.soft
    default: 400
  - key: file.hard
    default: 600
  - key: func.soft
    default: 50
  - key: func.hard
    default: 100
---
## 后端（Go）

### 技术栈

Go 1.27 + Go Modules + 标准库 `net/http` + pgx + sqlc + PostgreSQL。

- `go.mod` 的 `go` 指令固定语言版本，提交 `go.sum`；新增依赖先确认标准库无法满足，禁止引入整套 Web 框架替代 `net/http`。
- HTTP 路由用标准库 `http.ServeMux` 的方法与路径模式（`GET /api/v1/orders/{id}`）。
- 数据访问用 pgx（`pgxpool`）+ sqlc 生成的类型安全查询；sqlc 的表结构来自仓库根 `sql/` 脚本，禁止运行时建表或改表。
- 静态检查用 `golangci-lint`（启用 `errcheck`、`govet`、`staticcheck`、`depguard`），格式化用 `gofmt` / `goimports`。

### 分层结构

```
backend/
├── go.mod
├── go.sum
├── sqlc.yaml                  # sqlc 配置：schema 指向 ../sql，queries 指向 queries/
├── cmd/
│   └── {{app}}/main.go        # 入口：读配置、装配依赖、启动与优雅关闭 HTTP 服务
├── queries/                   # sqlc 查询文件，按领域分文件
└── internal/
    ├── <domain>/              # 一个业务领域一个包
    │   ├── handler.go         # HTTP 处理：解码请求、校验、调用 service、写统一响应
    │   ├── service.go         # 业务规则与事务编排，声明它需要的仓储接口
    │   ├── repository.go      # 仓储实现：调用 sqlc 生成代码
    │   ├── model.go           # 领域类型与领域错误
    │   └── *_test.go
    └── platform/              # 横切：配置、日志、数据库连接池、HTTP 中间件、统一响应
```

依赖规则：

- `handler` → `service` → 仓储接口；`repository.go` 实现 `service.go` 中声明的接口。
- 领域包之间只能调用对方 `service` 暴露的函数或接口，禁止引用对方的 `repository` 与 sqlc 生成类型。
- `platform` 禁止引用任何领域包；`cmd` 只做装配。
- 所有业务代码放在 `internal/`，禁止新建对外可导入的 `pkg/`；导入限制用 `depguard` 规则强制。

### 编码规范

- 所有涉及 I/O 或可能阻塞的函数第一个参数是 `ctx context.Context`；禁止把 `Context` 存进结构体。
- 错误向上返回时用 `fmt.Errorf("加载订单 %d: %w", id, err)` 包装；判断错误用 `errors.Is` / `errors.As`，禁止比较错误字符串。
- 禁止忽略返回的 `error`；库代码禁止 `panic`，只有 `main` 在启动失败时可以退出。
- 接口定义在使用方且保持小（1～3 个方法），函数返回具体类型。
- 每个 goroutine 必须有明确的退出路径，并发任务用 `errgroup` 管理并传递 `ctx`；禁止无人等待的 goroutine。
- 禁止包级可变全局变量与带副作用的 `init()`；配置在启动时解析一次并显式传入。
- handler 统一写出 `{code, msg, data}`；业务错误在一处映射为错误码；所有路由挂在 `/api/v1` 下，分页返回 `PageResult`（`page`、`pageSize`、`total`、`items`）。
- JSON 字段用 camelCase 标签（`json:"pageSize"`），请求体用 `DisallowUnknownFields` 解码并限制大小。
- SQL 只经 sqlc 生成的参数化查询；事务在 service 中用 `pgx.BeginFunc` 包裹，禁止字符串拼接 SQL。
- 日志用 `log/slog` 结构化输出，禁止记录密码、令牌等敏感信息。
- 时间统一 `time.Time`（UTC），数据库为 `timestamptz`。
- `go vet ./...`、`golangci-lint run`、`go test -race ./...` 必须通过。

### 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| Go 源文件 | {{file.soft}} 行 | {{file.hard}} 行 |
| 单个函数 | {{func.soft}} 行 | {{func.hard}} 行 |

- 行数按文件总行数计算（含空行和注释），sqlc 生成的文件不计。
- 达到「必须拆分」而不能拆分时，在回复中给出理由，并在文件注释中说明。
- 优先按职责拆分：同包内按功能分文件、提取纯函数、拆出子领域包。

### 测试要求

- 测试用标准库 `testing`，断言失败信息写清楚期望与实际；多组输入写成表驱动测试并用 `t.Run` 命名子用例。
- `service` 用手写的仓储假实现测试业务规则与错误分支，禁止依赖数据库。
- `repository` 用 testcontainers-go 的 PostgreSQL 模块启动真实数据库，执行 `sql/` 脚本后测试查询与事务。
- `handler` 用 `net/http/httptest` 验证路由、参数校验、统一响应与错误码映射。
- 无共享状态的测试调用 `t.Parallel()`；测试辅助函数调用 `t.Helper()`，资源用 `t.Cleanup` 释放。
- 修复缺陷先写能复现缺陷的失败测试。
- `go test -race ./...` 与 `golangci-lint run` 必须通过；集成测试依赖 Docker，本机无法运行时在回复中写明未运行的测试。
