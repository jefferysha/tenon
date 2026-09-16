---
id: swift-swiftui
category: mobile
title: Swift + SwiftUI
directory: ios/
directory_label: iOS 工程根目录
variables:
  - key: app
    default: App
  - key: file.soft
    default: 300
  - key: file.hard
    default: 500
  - key: body.soft
    default: 80
  - key: body.hard
    default: 150
---
## 移动端（Swift + SwiftUI）

### 技术栈

Swift 6.4（Swift 6 语言模式）+ SwiftUI + Observation + Swift Package Manager。

- 依赖只用 Swift Package Manager，提交 `Package.resolved`；禁止混用 CocoaPods / Carthage。
- 编译设置开启完整严格并发检查（Swift 6 语言模式），警告视为错误（`SWIFT_TREAT_WARNINGS_AS_ERRORS = YES`）。
- 最低部署版本在工程中统一固定，调用更高版本 API 必须用 `if #available` 分支。
- 静态检查用 SwiftLint，格式化用 swift-format，接入构建阶段。

### 分层结构

```
ios/
├── {{app}}.xcodeproj
├── {{app}}/
│   ├── App/                     # @main 入口、依赖装配、根导航
│   ├── Features/
│   │   └── <Feature>/
│   │       ├── Views/           # SwiftUI 视图：只负责展示与转发用户操作
│   │       ├── Models/          # @Observable 视图模型与界面状态
│   │       └── Services/        # 该功能的用例与数据访问
│   ├── Core/
│   │   ├── Networking/          # APIClient：/api/v1 请求、统一响应解包、错误类型
│   │   ├── Persistence/         # 本地存储与 Keychain 封装
│   │   └── DesignSystem/        # 颜色、字体、间距 token 与通用组件
│   └── Resources/               # Assets.xcassets、Localizable.xcstrings
├── {{app}}Tests/                # Swift Testing 单元测试
└── {{app}}UITests/              # XCUITest 界面测试
```

依赖规则：

- `Views` → `Models` → `Services` → `Core`，只能单向依赖；`Core` 禁止引用 `Features`。
- 功能之间禁止直接引用对方的 `Models` / `Services`，跨功能通过 `Core` 中定义的协议或 `App` 层导航衔接。
- 功能模块拆成本地 Swift Package 时，由 target 依赖强制上述方向。

### 编码规范

- 视图模型写成 `@MainActor @Observable final class`，视图用 `@State` 持有、通过初始化参数或 `@Environment` 传递；
  新代码禁止 `ObservableObject` / `@Published`。
- 网络与磁盘操作写成 `async` 函数，界面状态只在主 actor 上修改；新代码禁止 `DispatchQueue.main.async`，禁止无理由使用 `Task.detached`。
- 禁止强制解包 `!`、`try!`、`as!` 与隐式解包可选类型；可选值用 `guard let` / `if let` 处理。
- `body` 只描述界面，禁止在其中发起请求、写日志或修改状态；复杂界面拆成独立子视图，不写返回视图的长方法。
- `APIClient` 用 `URLSession` 的 async API，统一拼接 `/api/v1`，把 `{code, msg, data}` 解包为 `APIResponse<T>`，
  `code` 非成功时抛出 `APIError.business(code:msg:)`；分页解码为 `PageResult<T>`（`page`、`pageSize`、`total`、`items`）。
- JSON 解码器统一使用 `.iso8601` 日期策略；领域模型与接口 DTO 分开定义。
- 错误定义为遵循 `Error` 的枚举，在视图模型中转换为用户可读的界面状态；禁止用 `try?` 静默吞掉错误。
- 依赖通过初始化参数与协议注入，单例只允许出现在 `App` 装配层。
- 令牌等敏感数据只存 Keychain，禁止写入 `UserDefaults` 或日志。
- 用户可见文字写进 String Catalog（`Localizable.xcstrings`），禁止硬编码。
- 可访问性：纯图标按钮提供 `accessibilityLabel`，文字支持动态字体。
- 列表使用稳定的 `id`（`Identifiable`），禁止用下标作为标识。
- SwiftLint 与 `xcodebuild test` 必须通过。

### 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| Swift 文件 | {{file.soft}} 行 | {{file.hard}} 行 |
| 单个 `body` | {{body.soft}} 行 | {{body.hard}} 行 |

- 行数按文件总行数计算（含空行和注释）。
- 达到「必须拆分」而不能拆分时，在回复中给出理由，并在文件注释中说明。
- 优先按职责拆分：子视图、视图模型、服务、扩展文件。

### 测试要求

- 单元测试用 Swift Testing（`import Testing`、`@Test`、`#expect`），视图模型与服务通过协议替身测试成功、空数据、失败分支。
- `APIClient` 用自定义 `URLProtocol` 拦截请求，覆盖统一响应解包、业务错误码与网络错误，禁止访问真实网络。
- 核心流程用 XCUITest 编写界面测试，元素通过 `accessibilityIdentifier` 定位。
- 异步测试使用 `async` 测试函数，禁止用固定 `sleep` 等待。
- 修复缺陷先写能复现缺陷的失败测试。
- `xcodebuild test -scheme {{app}} -destination 'platform=iOS Simulator,name=<模拟器>'` 必须通过；本机无法运行时在回复中写明未运行的测试。
