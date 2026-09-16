---
id: rust-axum
category: backend
title: Rust + Axum
directory: backend/
directory_label: 后端工程根目录（Cargo workspace）
variables:
  - key: file.soft
    default: 400
  - key: file.hard
    default: 700
  - key: fn.soft
    default: 50
  - key: fn.hard
    default: 100
---
## 后端（Rust + Axum）

### 技术栈

Rust stable（1.98，edition 2024）+ Axum 0.8 + Tokio + SQLx（PostgreSQL）+ serde + tracing。

- `rust-toolchain.toml` 固定工具链，提交 `Cargo.lock`；依赖版本统一写在根 `Cargo.toml` 的 `[workspace.dependencies]`。
- 根 `Cargo.toml` 的 `[workspace.lints]` 统一开启 `clippy::unwrap_used`、`clippy::expect_used` 为 `deny`，`unsafe_code` 为 `forbid`。
- SQL 用 `sqlx::query!` / `query_as!` 编译期校验，`cargo sqlx prepare --workspace` 生成的 `.sqlx/` 提交入库，CI 以 `SQLX_OFFLINE=true` 构建。
- 表结构变更遵循「数据库」章节，禁止使用 `sqlx migrate` 与运行时建表。

### 分层结构

```
backend/
├── Cargo.toml                  # workspace：成员、共享依赖、lints
├── Cargo.lock
├── rust-toolchain.toml
├── .sqlx/                      # 离线查询元数据
└── crates/
    ├── domain/                 # 实体、值对象、领域错误、仓储 trait（不依赖 axum / sqlx / tokio）
    ├── application/            # 用例服务、命令/查询、事务编排
    ├── infrastructure/         # SQLx 仓储实现、外部系统客户端
    └── api/                    # main.rs 装配、axum Router、handler、提取器、统一响应
```

依赖方向（由各 crate 的 `Cargo.toml` 依赖强制）：

- `api` → `application` → `domain`；`infrastructure` → `domain`（实现仓储 trait）。
- `api` 依赖 `infrastructure` 只用于在 `main.rs` 装配，handler 禁止直接使用 `PgPool` 执行 SQL。
- `domain` 禁止依赖 `axum`、`sqlx`、`tokio`、`serde_json` 等框架 crate。
- crate 之间只通过 `pub` 导出的类型交互，内部模块默认 `pub(crate)`。

### 编码规范

- 禁止 `unwrap()` / `expect()`（测试与 `main` 启动阶段除外）；可失败操作返回 `Result` 并用 `?` 传播。
- 库 crate 的错误用 `thiserror` 定义枚举；`anyhow` 只允许在 `api` 的 `main.rs` 中使用。
- handler 返回 `Result<Json<ApiResponse<T>>, AppError>`，`AppError` 实现 `IntoResponse`，统一输出 `{code, msg, data}` 与错误码。
- 路由统一 `Router::new().nest("/api/v1", …)`；分页返回 `PageResult<T>`（`page`、`pageSize`、`total`、`items`）；
  接口类型标注 `#[serde(rename_all = "camelCase")]`，请求类型加 `#[serde(deny_unknown_fields)]`。
- 共享状态放进 `#[derive(Clone)] struct AppState`（内部 `Arc`），经 `State` 提取器传递；禁止用全局可变静态变量。
- 异步代码中禁止阻塞调用（`std::thread::sleep`、同步文件与网络 I/O），需要时用 `tokio::task::spawn_blocking`；禁止跨 `.await` 持有 `std::sync::Mutex` 锁。
- 事务在 `application` 中用 `pool.begin()` 开启，把事务句柄传给同一事务内的仓储；乐观锁以 `version` 为条件更新，影响行数为 0 返回冲突错误。
- 禁止字符串拼接 SQL，动态条件用 `QueryBuilder` 绑定参数。
- 日志与链路用 `tracing` + `tower-http` 的 `TraceLayer`，禁止记录密码、令牌等敏感信息。
- 时间统一 `time::OffsetDateTime`（UTC），数据库为 `timestamptz`。
- 公开函数与类型写文档注释说明错误条件；`cargo fmt --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace` 必须通过。

### 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| Rust 源文件 | {{file.soft}} 行 | {{file.hard}} 行 |
| 单个函数 | {{fn.soft}} 行 | {{fn.hard}} 行 |

- 行数按文件总行数计算（含空行、注释与同文件内的 `#[cfg(test)]` 模块）。
- 达到「必须拆分」而不能拆分时，在回复中给出理由，并在模块文档注释中说明。
- 优先按职责拆分：子模块、独立用例、领域类型文件、测试移到 `tests/`。

### 测试要求

- `domain` 与 `application` 的单元测试写在同文件 `#[cfg(test)] mod tests`，`application` 用实现仓储 trait 的内存假实现测试业务分支。
- 仓储实现用 `#[sqlx::test]` 连接真实 PostgreSQL（每个测试独立数据库），先执行 `sql/` 脚本再断言查询、事务与乐观锁。
- `api` 用 `tower::ServiceExt::oneshot` 直接调用 `Router`，断言 HTTP 状态、统一响应结构与错误码，参数校验失败与业务错误都要覆盖。
- 异步测试用 `#[tokio::test]`；测试中允许 `unwrap()`，但断言信息要写清楚期望。
- 修复缺陷先写能复现缺陷的失败测试。
- `cargo test --workspace` 与 clippy、fmt 检查必须通过；依赖数据库的测试本机无法运行时在回复中写明未运行的测试。
