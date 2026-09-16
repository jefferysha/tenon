---
id: java-spring-boot-ddd
category: backend
title: Java + Spring Boot DDD
directory: backend/
directory_label: 后端工程根目录（Gradle 多模块）
variables:
  - key: app
    default: app
  - key: company
    default: example
  - key: class.soft
    default: 300
  - key: class.hard
    default: 500
  - key: method.soft
    default: 40
  - key: method.hard
    default: 80
---
## 后端（Java + Spring Boot DDD）

### 技术栈

Java 21 + Spring Boot 4.1 + Gradle（Groovy DSL）+ PostgreSQL + Spring Data JPA，多模块工程。

- 构建只用 Gradle Wrapper（`./gradlew`），提交 `gradle/wrapper/`；禁止要求本机安装 Gradle。
- 依赖版本由 Spring Boot BOM 与 `gradle/libs.versions.toml` 统一管理，禁止在子模块里写死版本号。
- 根 `build.gradle` 用 `java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }` 固定 Java 版本。
- 表结构变更遵循「数据库」章节，应用启动时禁止自动建表或改表。

### 分层结构

严格 DDD 分层与模块划分：

```
backend/
├── settings.gradle
├── build.gradle
├── {{app}}-domain/          # 领域层：聚合、实体、值对象、领域服务、领域事件、仓储接口
├── {{app}}-application/     # 应用层：用例服务、命令/查询对象、事务边界、DTO 装配
├── {{app}}-infrastructure/  # 基础设施层：JPA 实体与仓储实现、外部系统适配
├── {{app}}-interfaces/      # 接口层：REST Controller、请求/响应模型、参数校验、异常映射
└── {{app}}-bootstrap/       # 启动模块：Spring Boot 入口与配置装配
```

依赖方向（由 Gradle 依赖强制）：

- `interfaces` → `application` → `domain`
- `infrastructure` → `domain`（实现仓储接口），`infrastructure` → `application`（仅在实现应用层端口时）
- `bootstrap` 依赖全部模块，只做装配
- `domain` 不依赖任何其他模块，不引用 Spring、JPA、Jackson 等框架类型

规则：

- 按限界上下文分包：`com.{{company}}.{{app}}.<context>.<layer>`。
- 聚合通过聚合根修改，跨聚合只按 id 引用；一个事务只修改一个聚合，跨聚合一致性用领域事件。
- 业务规则写在领域对象和领域服务中；应用服务只编排、不写业务判断；Controller 只做协议转换。
- 领域模型与 JPA 持久化模型分离：JPA `@Entity` 只放在 infrastructure，通过映射器与领域对象互转。
- 仓储接口定义在 domain，以领域语言命名；Spring Data 接口只在 infrastructure 内部使用。

### 编码规范

- 使用构造器注入，依赖声明为 `final`；禁止字段注入。
- 值对象、命令、查询、DTO 优先使用 `record`；领域实体保持封装，禁止公开 setter 暴露内部状态。
- 事务注解只放在应用层服务方法上；只读查询使用 `@Transactional(readOnly = true)`。
- 禁止在 Controller 或领域层捕获异常后吞掉；业务异常继承统一业务异常基类，由 `@RestControllerAdvice` 映射为统一响应 `{code, msg, data}`。
- 所有接口使用 `/api/v1` 前缀；分页返回 `PageResult`（`page`、`pageSize`、`total`、`items`），禁止直接返回 Spring Data 的 `Page`。
- 参数校验使用 Jakarta Validation 注解，在接口层完成。
- 返回集合时返回空集合而不是 `null`；可能缺失的单值使用 `Optional`，但不用于字段和参数。
- JPA：禁止 `FetchType.EAGER`；避免 N+1，关联查询使用 fetch join 或实体图；乐观锁使用 `@Version` 映射 `version` 字段；
  `spring.jpa.hibernate.ddl-auto` 只能是 `none` 或 `validate`。
- 日志使用 SLF4J 占位符，禁止输出密码、令牌等敏感信息。
- 时间统一使用 `OffsetDateTime` / `Instant`，数据库为 `timestamptz`。
- 构建时 `./gradlew build` 必须通过（编译、测试、静态检查）。

### 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| Java 类 / 接口 / record | {{class.soft}} 行 | {{class.hard}} 行 |
| 单个方法 | {{method.soft}} 行 | {{method.hard}} 行 |

- 达到「必须拆分」而不能拆分时，在回复中给出理由，并在类注释中说明。
- 优先按职责拆分：值对象、领域服务、策略、独立用例服务。

### 测试要求

- 测试框架：JUnit 6 + AssertJ + Mockito；集成测试用 Testcontainers 2 启动真实 PostgreSQL，禁止用 H2 等内存库替代。
- `domain` 模块的聚合、值对象、领域服务必须有纯单元测试，不启动 Spring 容器。
- `application` 服务用 Mockito 替换仓储接口，验证编排、事务边界与领域事件发布。
- `infrastructure` 仓储实现用 `@DataJpaTest` + Testcontainers 验证映射、fetch join、乐观锁冲突。
- `interfaces` 层用 `@WebMvcTest` + MockMvc 验证参数校验、统一响应与异常映射，业务异常与校验失败两类错误响应都要覆盖。
- 在 `bootstrap` 模块用 ArchUnit 写分层测试：`domain` 不引用 Spring / JPA / Jackson，模块依赖方向与上文一致。
- 测试方法命名 `should_<结果>_when_<条件>`，一个测试只验证一个行为；修复缺陷先写能复现缺陷的失败测试。
- `./gradlew build` 必须通过；集成测试依赖 Docker，本机无法运行时在回复中写明未运行的测试。
