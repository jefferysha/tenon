---
id: php-laravel
category: backend
title: PHP + Laravel
directory: backend/
directory_label: 后端工程根目录
variables:
  - key: class.soft
    default: 300
  - key: class.hard
    default: 500
  - key: method.soft
    default: 40
  - key: method.hard
    default: 80
---
## 后端（PHP + Laravel）

### 技术栈

PHP 8.5 + Laravel 13 + Composer + PostgreSQL；静态检查 Larastan（level max），格式化 Laravel Pint，测试 Pest 5。

- 依赖只用 Composer，提交 `composer.lock`；`composer.json` 的 `require.php` 固定 `^8.5`。
- 业务配置只通过 `config()` 读取，`env()` 只允许出现在 `config/` 文件中；密钥写环境变量，禁止提交 `.env`。
- 表结构变更遵循「数据库」章节；禁止使用 Laravel 迁移与在代码里建表、改表。

### 分层结构

```
backend/
├── composer.json
├── composer.lock
├── app/
│   ├── Domain/
│   │   └── <Context>/
│   │       ├── Models/              # Eloquent 模型：表映射、关联、类型转换、查询 scope
│   │       ├── Actions/             # 单一职责业务动作：一个类一个 handle()
│   │       └── Data/                # 不可变数据对象（readonly class）
│   ├── Http/
│   │   ├── Controllers/Api/V1/      # 控制器：取已校验数据、调用 Action、返回统一响应
│   │   ├── Requests/                # FormRequest：校验与授权
│   │   └── Resources/               # API Resource：输出字段转换
│   ├── Exceptions/                  # 业务异常
│   └── Support/                     # 统一响应、分页转换
├── bootstrap/app.php                # 路由、中间件、异常渲染注册
├── routes/api.php                   # /api/v1 路由
└── tests/
    ├── Arch/
    ├── Unit/
    └── Feature/
```

依赖规则：

- `Http` → `Domain\<Context>\Actions` → `Domain\<Context>\Models`；`Data` 在 `Http` 与 `Actions` 之间传递。
- `Domain` 禁止引用 `App\Http`、`Illuminate\Http\Request` 与 FormRequest；Action 只接收 `Data` 对象与标量。
- 上下文之间只调用对方的 Action，禁止直接修改对方的模型。
- 上述规则写成 Pest 架构测试（`arch()->expect('App\Domain')->not->toUse('App\Http')`），禁止靠约定。

### 编码规范

- 每个文件以 `declare(strict_types=1);` 开头；属性、参数、返回值全部声明类型；`Data` 使用 `readonly class`。
- 输入校验只写在 FormRequest；控制器用 `$request->validated()` 构造 `Data` 后调用 Action，禁止在控制器里写业务判断。
- 业务逻辑只写在 Action 中；模型只放关联、scope、类型转换；禁止在观察者、模型事件、`boot()` 中写业务规则。
- `AppServiceProvider` 中启用 `Model::shouldBeStrict(! app()->isProduction())`，杜绝懒加载 N+1 与静默丢弃属性；关联数据显式 `with()`。
- 模型显式声明 `$fillable`，禁止 `$guarded = []`。
- 写操作在 Action 内用 `DB::transaction()` 包裹；乐观锁以 `version` 为条件更新，影响行数为 0 时抛冲突异常。
- 在 `bootstrap/app.php` 的 `withExceptions` 中把业务异常、校验失败、未认证统一渲染为 `{code, msg, data}`。
- 所有接口挂在 `/api/v1` 下；分页转换为 `PageResult`（`page`、`pageSize`、`total`、`items`），禁止直接返回 Laravel 分页器的默认 JSON。
- 查询只用 Eloquent / 查询构造器的参数绑定；`DB::raw` 与 `whereRaw` 必须绑定参数，禁止字符串拼接 SQL。
- 队列任务保持幂等并声明重试次数与超时。
- 时间统一使用 `CarbonImmutable`（`Date::use(CarbonImmutable::class)`），应用时区 UTC，数据库为 `timestamptz`。
- 日志用 `Log` 门面结构化上下文，禁止记录密码、令牌等敏感信息。
- `vendor/bin/pint --test`、`vendor/bin/phpstan analyse`、`vendor/bin/pest` 必须通过。

### 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| PHP 类 | {{class.soft}} 行 | {{class.hard}} 行 |
| 单个方法 | {{method.soft}} 行 | {{method.hard}} 行 |

- 行数按文件总行数计算（含空行和注释）。
- 达到「必须拆分」而不能拆分时，在回复中给出理由，并在类注释中说明。
- 优先按职责拆分：独立 Action、`Data` 对象、查询 scope、Resource。

### 测试要求

- 测试框架：Pest 5；`tests/Arch` 放分层架构测试，`tests/Unit` 测 Action 与 `Data`，`tests/Feature` 测 HTTP 接口。
- 测试数据库使用真实 PostgreSQL（CI 服务或 Testcontainers），表结构由 `sql/` 脚本初始化，用例用 `DatabaseTransactions` 回滚；禁止用 SQLite 替代。
- 每个 Action 覆盖成功与每个业务失败分支；每个接口用 `getJson` / `postJson` 断言 HTTP 状态、统一响应结构、错误码与分页字段。
- 参数校验失败、未认证、业务异常三类错误响应都要有 Feature 测试。
- 测试数据用模型工厂在用例内构造，外部服务用 `Http::fake()` / `Queue::fake()` 隔离。
- 修复缺陷先写能复现缺陷的失败测试。
- `vendor/bin/pest` 必须通过；依赖数据库的测试本机无法运行时在回复中写明未运行的测试。
