---
id: kotlin-spring-boot
category: backend
title: Kotlin + Spring Boot
directory: backend/
directory_label: 后端工程根目录
variables:
  - key: app
    default: app
  - key: company
    default: example
  - key: file.soft
    default: 300
  - key: file.hard
    default: 500
  - key: function.soft
    default: 40
  - key: function.hard
    default: 80
---
## 后端（Kotlin + Spring Boot）

### 技术栈

Kotlin 2.4 + Spring Boot 4.1 + Gradle（Kotlin DSL）+ PostgreSQL + Spring Data JPA，JVM 工具链 Java 21。

- 构建只用 Gradle Wrapper（`./gradlew`），依赖版本统一写在 `gradle/libs.versions.toml`，禁止在构建脚本里写死版本号。
- 启用 `kotlin("plugin.spring")` 与 `kotlin("plugin.jpa")`，编译参数开启 `-Xjsr305=strict`，警告视为错误（`allWarningsAsErrors = true`）。
- 静态检查用 ktlint + detekt，接入 `./gradlew check`。
- 表结构变更遵循「数据库」章节，应用启动时禁止自动建表或改表。

### 分层结构

六边形架构，按限界上下文分包：

```
backend/
├── settings.gradle.kts
├── build.gradle.kts
├── gradle/libs.versions.toml
└── src/main/kotlin/com/{{company}}/{{app}}/
    ├── Application.kt               # Spring Boot 入口
    └── <context>/
        ├── domain/                  # 实体、值对象、领域服务、领域错误、出站端口接口（纯 Kotlin）
        ├── application/             # 用例：入站端口实现、命令/查询、事务边界
        ├── adapter/
        │   ├── in/web/              # REST Controller、请求/响应 DTO、参数校验
        │   └── out/persistence/     # JPA 实体、Spring Data 仓储、出站端口实现
        └── config/                  # 本上下文的 Bean 装配
```

依赖方向：

- `adapter/in` → `application` → `domain`；`adapter/out` → `domain`（实现出站端口）。
- `domain` 禁止引用 Spring、JPA、Jackson 与 `kotlinx.coroutines`；`application` 禁止引用 `adapter`。
- 上下文之间只通过对方 `application` 暴露的用例接口调用，禁止直接使用对方的 `domain` 实体或持久化类。
- 依赖方向由 ArchUnit 测试强制（见测试要求），禁止靠约定。

### 编码规范

- 依赖通过主构造函数注入并声明为 `private val`；禁止字段注入与 `lateinit var` 注入。
- 默认使用 `val` 与只读集合；值对象用 `data class` 或 `@JvmInline value class`，实体保持封装，状态变更只通过方法。
- 禁止 `!!`；可空值用 `?.`、`?:`、`requireNotNull` / `checkNotNull` 显式处理。
- 用例结果用 `sealed interface` 表达成功与各类业务失败；不可恢复错误抛业务异常，由 `@RestControllerAdvice` 映射为统一响应 `{code, msg, data}`。
- 所有接口使用 `/api/v1` 前缀；分页返回 `PageResult`（`page`、`pageSize`、`total`、`items`）。
- 协程（`suspend`、`Flow`）只在 `adapter` 层使用；禁止 `GlobalScope`，生产代码禁止 `runBlocking`。
- `@Transactional` 只放在 `application` 用例方法上，只读查询用 `@Transactional(readOnly = true)`。
- 参数校验在 `adapter/in/web` 用 Jakarta Validation，注解写 use-site target（`@field:NotBlank`）。
- JPA 实体只放在 `adapter/out/persistence`，禁止用 `data class` 作 JPA 实体；禁止 `FetchType.EAGER`，关联查询用 fetch join；
  乐观锁用 `@Version` 映射 `version`；`spring.jpa.hibernate.ddl-auto` 只能是 `none` 或 `validate`。
- 扩展函数只用于映射与小工具，禁止把业务规则写成扩展函数。
- 日志使用 SLF4J 占位符，禁止输出密码、令牌等敏感信息。
- 时间统一使用 `Instant` / `OffsetDateTime`，数据库为 `timestamptz`。
- `./gradlew build` 必须通过（编译、ktlint、detekt、测试）。

### 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| Kotlin 文件 | {{file.soft}} 行 | {{file.hard}} 行 |
| 单个函数 | {{function.soft}} 行 | {{function.hard}} 行 |

- 行数按文件总行数计算（含空行和注释）。
- 达到「必须拆分」而不能拆分时，在回复中给出理由，并在文件注释中说明。
- 优先按职责拆分：值对象、领域服务、独立用例、映射函数。

### 测试要求

- 测试框架：JUnit 6 + MockK（Spring 上下文中用 springmockk 的 `@MockkBean`）+ AssertJ；集成测试用 Testcontainers 2 启动真实 PostgreSQL。
- `domain` 必须有纯单元测试，不启动 Spring 容器；`application` 用 MockK 替换出站端口，覆盖 `sealed` 结果的每个分支。
- `adapter/out/persistence` 用 `@DataJpaTest` + Testcontainers 验证映射、fetch join、乐观锁冲突。
- `adapter/in/web` 用 `@WebMvcTest` 验证参数校验、统一响应与异常映射；协程代码用 `kotlinx-coroutines-test` 的 `runTest`。
- 用 ArchUnit 写分层测试：`domain` 不引用 Spring / JPA / 协程，`application` 不引用 `adapter`。
- 测试函数用反引号描述行为（`` fun `returns conflict when version is stale`() ``）；修复缺陷先写能复现缺陷的失败测试。
- `./gradlew build` 必须通过；集成测试依赖 Docker，本机无法运行时在回复中写明未运行的测试。
