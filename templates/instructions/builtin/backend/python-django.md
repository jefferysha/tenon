---
id: python-django
category: backend
title: Python + Django
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
## 后端（Python + Django）

### 技术栈

Python 3.14 + Django 5.2 LTS + Django REST framework 3.18 + PostgreSQL，依赖与虚拟环境用 uv 管理。

- 依赖只用 uv（`uv add` / `uv sync`），提交 `uv.lock`；禁止 pip、Poetry 混用。
- 静态检查用 ruff（lint 与格式化）+ mypy（`django-stubs`、`djangorestframework-stubs` 插件，`strict = true`）。
- 配置按 `config/settings/{base,local,production}.py` 拆分，密钥与数据库连接从环境变量读取；生产环境 `DEBUG = False`。
- 表结构变更遵循「数据库」章节；模型 `Meta` 显式写 `db_table`，禁止在代码里自动建表或改表。

### 分层结构

```
backend/
├── pyproject.toml
├── uv.lock
├── manage.py
├── config/                      # settings、根 urls.py（挂载 api/v1/）、asgi.py / wsgi.py
└── apps/
    └── <context>/               # 一个限界上下文一个 app
        ├── models.py            # ORM 映射、字段约束、简单属性
        ├── services.py          # 写操作：业务规则与事务
        ├── selectors.py         # 读操作：查询与数据组装
        ├── api/
        │   ├── serializers.py   # 输入校验与输出序列化
        │   ├── views.py         # APIView：校验输入、调用 service / selector、返回统一响应
        │   └── urls.py
        ├── admin.py
        └── tests/
```

依赖规则：

- `api` → `services` / `selectors` → `models`；`services` 可以调用 `selectors`，`selectors` 禁止写数据。
- `models` 禁止导入 `services`、`selectors`、`api`；`services` 与 `selectors` 禁止导入 DRF 与 `request`。
- app 之间只调用对方的 `services` / `selectors`，禁止直接查询或修改对方的模型。
- 导入方向用 import-linter 契约强制，禁止靠约定。

### 编码规范

- service 函数只接受关键字参数（`def create_order(*, user: User, items: list[OrderItemIn]) -> Order`），写操作用 `transaction.atomic` 包裹。
- 视图保持薄：校验输入、调用 service / selector、序列化输出；禁止在视图、序列化器 `save()`、模型 `save()` 重写中写业务规则。
- 禁止在信号（`post_save` 等）中写业务逻辑，信号只用于与外部系统解耦的通知。
- selector 查询显式使用 `select_related` / `prefetch_related` 并只取需要的字段，禁止 N+1。
- 序列化器显式列出字段，禁止 `fields = "__all__"`；输入序列化器与输出序列化器分开定义。
- 统一响应：自定义 DRF `EXCEPTION_HANDLER` 与响应封装输出 `{code, msg, data}`；业务异常继承统一的 `BusinessError`。
- 所有接口挂在 `/api/v1/` 下；分页使用自定义分页类返回 `PageResult`（`page`、`pageSize`、`total`、`items`），字段名 camelCase。
- 每个视图显式声明 `permission_classes`，全局默认 `IsAuthenticated`。
- 乐观锁：更新时带 `version` 条件并自增（`filter(id=..., version=...).update(version=F("version") + 1, ...)`），受影响行数为 0 时抛冲突异常。
- 原生 SQL 只用参数化查询，禁止字符串拼接。
- `USE_TZ = True`，时间一律带时区（`django.utils.timezone.now()`），数据库为 `timestamptz`。
- 日志用标准库 `logging`，禁止记录密码、令牌等敏感信息。
- `uv run ruff check`、`uv run mypy .`、`uv run pytest`、`uv run python manage.py check --deploy` 必须通过。

### 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| Python 模块 | {{module.soft}} 行 | {{module.hard}} 行 |
| 单个函数 / 方法 | {{function.soft}} 行 | {{function.hard}} 行 |

- 行数按文件总行数计算（含空行和注释）。
- 达到「必须拆分」而不能拆分时，在回复中给出理由，并在模块文档字符串中说明。
- 优先按职责拆分：`services` / `selectors` 拆成包、独立 app、纯函数。

### 测试要求

- 测试框架：pytest + pytest-django + factory_boy；接口测试用 DRF `APIClient`。
- 测试数据库使用真实 PostgreSQL（CI 服务或 Testcontainers），表结构由 `sql/` 脚本初始化，禁止用 SQLite 替代。
- 每个 service 覆盖成功、校验失败、权限不足、并发冲突等分支；每个 selector 用 `django_assert_num_queries` 锁定查询次数。
- 每个接口有请求级测试，断言 HTTP 状态、统一响应结构、错误码与分页字段。
- 用例之间禁止共享数据，数据用 factory 在用例内构造。
- 修复缺陷先写能复现缺陷的失败测试。
- `uv run pytest` 必须通过；依赖数据库的测试本机无法运行时在回复中写明未运行的测试。
