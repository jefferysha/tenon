---
id: ruby-rails
category: backend
title: Ruby + Rails
directory: backend/
directory_label: 后端工程根目录
variables:
  - key: class.soft
    default: 250
  - key: class.hard
    default: 400
  - key: method.soft
    default: 20
  - key: method.hard
    default: 40
---
## 后端（Ruby + Rails）

### 技术栈

Ruby 4.0 + Rails 8.1（API 模式）+ Bundler + PostgreSQL；测试 RSpec + FactoryBot，静态检查 RuboCop（rubocop-rails、rubocop-rspec）与 Brakeman。

- `.ruby-version` 固定 Ruby 版本，依赖只用 Bundler，提交 `Gemfile.lock`。
- 密钥用 `Rails.application.credentials` 或环境变量，禁止提交明文密钥。
- 表结构变更遵循「数据库」章节；禁止生成与运行 Rails 迁移，禁止在代码里建表、改表。

### 分层结构

```
backend/
├── Gemfile
├── Gemfile.lock
├── app/
│   ├── controllers/
│   │   └── api/v1/             # 控制器：strong params、调用 service / query、渲染统一响应
│   ├── models/                 # ActiveRecord：表映射、关联、校验、scope
│   ├── services/<context>/     # 写操作业务流程：一个类一个公开 call
│   ├── queries/<context>/      # 复杂读查询对象
│   └── serializers/            # 输出结构，字段 camelCase
├── config/routes.rb            # namespace :api { namespace :v1 { … } }
└── spec/
    ├── models/
    ├── services/
    ├── queries/
    └── requests/
```

依赖规则：

- `controllers` → `services` / `queries` → `models`；`serializers` 只被 `controllers` 使用。
- `services` 与 `queries` 禁止读取 `params`、`request`、`session`；`models` 禁止调用 `services`。
- 上下文之间只调用对方的 service / query，禁止跨上下文直接修改模型。
- 所有 API 控制器继承 `Api::V1::BaseController`，统一处理认证、异常与响应格式。

### 编码规范

- 每个文件首行 `# frozen_string_literal: true`。
- 控制器保持薄：用 `params.expect(...)` 取参数，调用 service / query，渲染 serializer；禁止在控制器里写业务判断。
- service 对外只暴露 `call`，返回表示成功或失败的结果对象；禁止在模型回调（`after_save` 等）与 concern 中写业务流程。
- 开启 `config.active_record.strict_loading_by_default = true`，关联数据显式 `includes` / `preload`，杜绝 N+1。
- 写操作在 service 中用 `ActiveRecord::Base.transaction` 包裹；乐观锁使用 `lock_version` 或以 `version` 为条件更新，冲突时返回冲突错误。
- `Api::V1::BaseController` 用 `rescue_from` 把业务异常、校验失败、记录不存在统一渲染为 `{code, msg, data}`。
- 所有接口挂在 `/api/v1` 下；分页返回 `PageResult`（`page`、`pageSize`、`total`、`items`）。
- 查询使用哈希条件或绑定参数（`where(status: value)`、`where("created_at > ?", time)`），禁止把参数插值进 SQL 字符串。
- 时间用 `Time.current`，`config.time_zone = "UTC"`，数据库为 `timestamptz`。
- 日志禁止记录密码、令牌等敏感信息，敏感参数加入 `filter_parameters`。
- `bundle exec rubocop`、`bin/brakeman --no-pager`、`bundle exec rspec` 必须通过。

### 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| Ruby 类 / 模块 | {{class.soft}} 行 | {{class.hard}} 行 |
| 单个方法 | {{method.soft}} 行 | {{method.hard}} 行 |

- 行数按文件总行数计算（含空行和注释）。
- 达到「必须拆分」而不能拆分时，在回复中给出理由，并在类注释中说明。
- 优先按职责拆分：独立 service、query 对象、值对象、serializer。

### 测试要求

- 测试框架：RSpec + FactoryBot；每个接口有 request spec，断言 HTTP 状态、统一响应结构、错误码与分页字段。
- 每个 service 覆盖成功与每个失败分支（校验失败、权限不足、并发冲突）；query 对象断言结果与查询次数。
- model spec 覆盖校验与 scope；测试数据用 FactoryBot 在用例内构造，禁止依赖共享 fixtures。
- 测试数据库使用真实 PostgreSQL，表结构由 `sql/` 脚本初始化，用例在事务中执行并回滚。
- 外部 HTTP 调用用 WebMock 拦截，禁止访问真实网络。
- 修复缺陷先写能复现缺陷的失败测试。
- `bundle exec rspec` 必须通过；依赖数据库的测试本机无法运行时在回复中写明未运行的测试。
