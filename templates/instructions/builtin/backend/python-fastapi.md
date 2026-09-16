---
id: python-fastapi
category: backend
title: Python + FastAPI
directory: backend/
directory_label: 后端工程根目录
variables:
  - key: module.soft
    default: 300
  - key: module.hard
    default: 500
  - key: function.soft
    default: 40
  - key: function.hard
    default: 80
---
## 后端（Python + FastAPI）

### 技术栈

Python 3.14 + FastAPI + Pydantic v2 + SQLAlchemy 2.0（异步）+ asyncpg + PostgreSQL，依赖与虚拟环境用 uv 管理。

- 依赖只用 uv（`uv add` / `uv sync`），提交 `uv.lock`，`pyproject.toml` 写明 `requires-python = ">=3.14"`；禁止 pip、Poetry 混用。
- 静态检查用 ruff（lint 与格式化）+ pyright（`typeCheckingMode = "strict"`），配置统一写在 `pyproject.toml`。
- 配置用 `pydantic-settings` 从环境变量读取，密钥禁止写入仓库。
- 表结构变更遵循「数据库」章节，代码里禁止 `metadata.create_all` 等自动建表或改表。

### 分层结构

```
backend/
├── pyproject.toml
├── uv.lock
├── app/
│   ├── main.py              # 创建 FastAPI 应用：挂载路由、异常处理器、lifespan 管理连接池
│   ├── api/
│   │   └── v1/              # 路由：参数解析、依赖注入、调用 service、返回统一响应
│   ├── schemas/             # Pydantic 请求/响应模型
│   ├── services/            # 业务规则与事务编排
│   ├── repositories/        # 数据访问：SQLAlchemy 查询
│   ├── models/              # SQLAlchemy ORM 映射（对应 sql/ 中的表）
│   └── core/                # 配置、数据库会话、日志、统一响应、业务异常
└── tests/
    ├── unit/
    └── integration/
```

依赖规则：

- `api` → `services` → `repositories` → `models`；`schemas` 只被 `api` 与 `services` 使用；`core` 可被所有层使用。
- `services`、`repositories`、`models` 禁止导入 `fastapi`；`repositories` 禁止导入 `schemas`。
- 路由函数不写业务判断，只做参数到 service 调用的转换。
- 导入方向用 ruff 的 `flake8-tidy-imports` 禁用规则或 import-linter 强制。

### 编码规范

- 所有函数、方法、类属性写完整类型注解；禁止 `Any` 外泄到边界之外，确需时在边界处用 Pydantic 校验收窄。
- 路由与 service 一律 `async def`；数据库只经 `AsyncSession`；禁止在异步代码中调用阻塞 I/O（`requests`、`time.sleep`、同步驱动），CPU 密集或阻塞调用用 `run_in_threadpool`。
- 依赖注入用 `Annotated[AsyncSession, Depends(get_session)]` 形式；每个请求一个会话，禁止模块级全局会话。
- 请求模型设置 `model_config = ConfigDict(extra="forbid")`；接口字段用 camelCase 别名（`alias_generator=to_camel`、`populate_by_name=True`），与接口约定一致。
- 统一响应模型 `ApiResponse[T]`（`code`、`msg`、`data`）；业务异常继承 `BusinessError`，由异常处理器统一转换，`RequestValidationError` 同样转换为统一响应。
- 所有路由挂在 `/api/v1` 前缀下；分页返回 `PageResult[T]`（`page`、`pageSize`、`total`、`items`）。
- SQLAlchemy 只用 2.0 写法：`Mapped[...]` + `mapped_column`、`select()`；禁止旧式 `session.query`。
- 关系默认 `lazy="raise"`，需要关联数据时显式 `selectinload` / `joinedload`，杜绝 N+1 与异步隐式加载。
- 事务边界在 service：`async with session.begin():`；repository 不提交事务。
- 乐观锁用 `version_id_col` 映射 `version` 字段；禁止用 f-string 拼接 SQL，原生 SQL 只用 `text()` 绑定参数。
- 时间一律带时区的 `datetime`（UTC），数据库为 `timestamptz`。
- 日志用标准库 `logging` 输出结构化字段，禁止记录密码、令牌等敏感信息。
- `uv run ruff check`、`uv run ruff format --check`、`uv run pyright`、`uv run pytest` 必须通过。

### 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| Python 模块 | {{module.soft}} 行 | {{module.hard}} 行 |
| 单个函数 / 方法 | {{function.soft}} 行 | {{function.hard}} 行 |

- 行数按文件总行数计算（含空行和注释）。
- 达到「必须拆分」而不能拆分时，在回复中给出理由，并在模块文档字符串中说明。
- 优先按职责拆分：独立 service、查询函数、schema 模块、纯函数。

### 测试要求

- 测试框架：pytest + pytest-asyncio；接口测试用 httpx `AsyncClient` + `ASGITransport` 直接调用应用，不启动真实端口。
- `services` 用假仓储或 `app.dependency_overrides` 替换依赖，覆盖业务规则的成功与每个失败分支。
- `repositories` 用 testcontainers 启动真实 PostgreSQL，执行 `sql/` 脚本后测试查询、事务与乐观锁，禁止用 SQLite 替代。
- 接口测试覆盖参数校验失败、业务异常、成功三类响应，断言统一响应结构与错误码。
- 测试数据用工厂函数构造，每个用例在事务中执行并回滚，禁止用例之间共享数据。
- 修复缺陷先写能复现缺陷的失败测试。
- `uv run pytest` 必须通过；集成测试依赖 Docker，本机无法运行时在回复中写明未运行的测试。
