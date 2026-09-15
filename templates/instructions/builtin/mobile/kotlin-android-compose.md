---
id: kotlin-android-compose
category: mobile
title: Kotlin + Jetpack Compose
directory: android/
directory_label: Android 工程根目录
variables:
  - key: file.soft
    default: 300
  - key: file.hard
    default: 500
  - key: composable.soft
    default: 60
  - key: composable.hard
    default: 120
---
## 移动端（Kotlin + Jetpack Compose）

### 技术栈

Kotlin 2.4 + Jetpack Compose（Compose BOM 2026.09）+ Material 3 + Android Gradle Plugin 9.4 + Gradle Kotlin DSL + Hilt。

- 构建只用 Gradle Wrapper，依赖版本统一写在 `gradle/libs.versions.toml`，Compose 库版本只由 BOM 决定。
- 网络用 Retrofit + OkHttp + kotlinx.serialization；异步用 Kotlin 协程与 Flow。
- 静态检查用 detekt + ktlint，接入 `./gradlew check`；警告视为错误（`allWarningsAsErrors = true`）。

### 分层结构

```
android/
├── settings.gradle.kts
├── build.gradle.kts
├── gradle/libs.versions.toml
├── app/                         # Application、MainActivity、导航图、Hilt 入口
├── core/
│   ├── network/                 # Retrofit / OkHttp、/api/v1 前缀、统一响应解包、错误类型
│   ├── data/                    # 本地存储与通用数据工具
│   ├── designsystem/            # Material 3 主题、颜色与字体 token、通用组件
│   └── testing/                 # 测试替身、MainDispatcherRule
└── feature/
    └── <feature>/               # 一个功能一个 Gradle 模块
        ├── ui/                  # Route / Screen 可组合函数、ViewModel、UiState
        ├── domain/              # 用例、领域模型、仓储接口（纯 Kotlin）
        └── data/                # 仓储实现、远程与本地数据源、DTO 映射
```

依赖规则（由 Gradle 模块依赖强制）：

- `app` → `feature:*` → `core:*`；`feature` 模块之间禁止互相依赖，跨功能跳转由 `app` 的导航图完成。
- 功能内部 `ui` → `domain` ← `data`：`data` 实现 `domain` 的仓储接口，`ui` 禁止引用 `data`。
- `domain` 禁止引用 Android SDK 与 Compose。

### 编码规范

- ViewModel 用 `@HiltViewModel` 构造函数注入，只暴露一个 `StateFlow<UiState>`；`UiState` 为不可变 `data class` 或 `sealed interface`。
- 一次性事件（导航、提示）用 `Channel` 转 `Flow` 暴露，禁止用 `StateFlow` 表达会被重复消费的事件。
- 界面收集状态用 `collectAsStateWithLifecycle()`；Route 可组合函数连接 ViewModel，Screen 可组合函数只接收状态与回调，禁止把 ViewModel 传给子组件。
- 可组合函数内禁止业务逻辑与数据请求；副作用放在 `LaunchedEffect` / `DisposableEffect`，昂贵计算用 `remember` / `derivedStateOf`。
- 公开的可组合函数第一个可选参数为 `modifier: Modifier = Modifier`；`LazyColumn` 的 `items` 必须提供稳定 `key`。
- 协程只在 `viewModelScope` 或注入的作用域中启动，调度器通过 Hilt 注入；禁止 `GlobalScope` 与 `runBlocking`。
- 禁止 `!!`；可空值用 `?.`、`?:` 显式处理。
- `core:network` 把 `{code, msg, data}` 解包为 `ApiResponse<T>`，`code` 非成功时抛出类型化异常，在仓储层转换为领域错误；分页解码为 `PageResult<T>`（`page`、`pageSize`、`total`、`items`）。
- 时间在接口层解析为 `Instant`，展示时再转换为本地时区。
- 用户可见文字写进 `strings.xml`，禁止硬编码；图标与图片提供 `contentDescription`。
- 令牌等敏感数据加密存储，禁止写入日志。
- `./gradlew check` 必须通过（编译、detekt、ktlint、单元测试）。

### 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| Kotlin 文件 | {{file.soft}} 行 | {{file.hard}} 行 |
| 单个可组合函数 | {{composable.soft}} 行 | {{composable.hard}} 行 |

- 行数按文件总行数计算（含空行和注释）。
- 达到「必须拆分」而不能拆分时，在回复中给出理由，并在文件注释中说明。
- 优先按职责拆分：子可组合函数、UiState 与映射、用例、数据源。

### 测试要求

- ViewModel 与用例用 JUnit + `kotlinx-coroutines-test`（`runTest`、`MainDispatcherRule`）+ Turbine 断言 Flow 的状态序列，覆盖加载、成功、空数据、失败。
- 仓储用手写假数据源测试，网络层用 OkHttp `MockWebServer` 验证统一响应解包与错误码映射，禁止访问真实网络。
- Screen 用 Compose UI 测试（`createComposeRule`）传入各状态断言界面，元素通过 `testTag` 或语义属性定位。
- 核心流程写仪器测试，改动涉及时 `./gradlew connectedCheck` 必须通过。
- 修复缺陷先写能复现缺陷的失败测试。
- `./gradlew check` 必须通过；本机无法运行仪器测试时在回复中写明未运行的测试。
