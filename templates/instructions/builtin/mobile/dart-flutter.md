---
id: dart-flutter
category: mobile
title: Dart + Flutter
directory: mobile/
directory_label: Flutter 工程根目录
variables:
  - key: file.soft
    default: 300
  - key: file.hard
    default: 500
  - key: build.soft
    default: 60
  - key: build.hard
    default: 120
---
## 移动端（Dart + Flutter）

### 技术栈

Flutter 3.47（Dart 3.13）+ Riverpod 3（`riverpod_generator`）+ go_router + Dio + freezed / json_serializable。

- 依赖用 `flutter pub add` 管理，提交 `pubspec.lock`；`pubspec.yaml` 的 `environment` 固定 Dart 与 Flutter 版本范围。
- `analysis_options.yaml` 引入 `package:flutter_lints/flutter.yaml`，并开启 `strict-casts`、`strict-inference`、`strict-raw-types`。
- 代码生成统一用 `dart run build_runner build --delete-conflicting-outputs`，生成文件提交入库。

### 分层结构

```
mobile/
├── pubspec.yaml
├── analysis_options.yaml
├── lib/
│   ├── main.dart                # ProviderScope 与应用入口
│   ├── app/                     # MaterialApp.router、路由表、主题
│   ├── core/
│   │   ├── network/             # Dio 客户端、/api/v1 前缀、统一响应解包、错误类型
│   │   ├── design_system/       # 主题、颜色与字体 token、通用组件
│   │   └── utils/
│   └── features/
│       └── <feature>/
│           ├── presentation/    # 页面与组件（Widget）
│           ├── application/     # Notifier：界面状态与业务流程
│           ├── domain/          # 实体、值对象、仓储接口（纯 Dart）
│           └── data/            # 仓储实现、DTO、远程与本地数据源
├── test/
└── integration_test/
```

依赖规则：

- `presentation` → `application` → `domain` ← `data`：`data` 实现 `domain` 的仓储接口，`presentation` 禁止引用 `data`。
- `domain` 禁止导入 `package:flutter`、Dio 与任何数据源实现。
- 功能之间只能通过对方 `application` 暴露的 provider 交互，禁止导入对方 `data` 与 `presentation`；`core` 禁止导入 `features`。
- 导入方向写成测试（扫描 `lib/features/` 的 import 语句）强制，禁止靠约定。

### 编码规范

- 状态用 Riverpod 3 代码生成（`@riverpod`）：可变状态写 `Notifier` / `AsyncNotifier` 类，只读派生写函数 provider。
- `build` 方法中用 `ref.watch`，事件回调中用 `ref.read`；禁止在回调里 `watch`，禁止在 `build` 里发起请求或修改状态。
- 异步状态用 `AsyncValue` 的 `when` / `switch` 同时处理加载、错误、数据三种情况。
- 状态类不可变（freezed 或全部 `final` 字段 + `copyWith`），禁止在 Notifier 外修改状态对象。
- 能加 `const` 的构造函数与组件一律加 `const`；复杂界面拆成独立 Widget 类，禁止用返回 Widget 的私有方法拼界面。
- 禁止 `!` 空断言，确需时写注释说明为何非空；`dynamic` 只允许出现在 JSON 边界。
- `await` 之后使用 `BuildContext` 前必须检查 `context.mounted`；不等待的 Future 显式包 `unawaited()`。
- Dio 拦截器统一拼接 `/api/v1`，把 `{code, msg, data}` 解包，`code` 非成功时抛出 `ApiException(code, msg)`；分页解析为 `PageResult<T>`（`page`、`pageSize`、`total`、`items`）。
- JSON 用 json_serializable 生成，时间解析为 UTC `DateTime`；接口 DTO 与领域实体分开定义。
- 路由用 go_router 类型化路由，禁止在组件里拼接路径字符串。
- 用户可见文字用 `flutter gen-l10n` 的 ARB 文件管理，禁止硬编码；交互元素提供 `Semantics` 标签，点击区域不小于 48×48。
- 禁止 `print`，日志统一经封装的日志工具输出；令牌存 `flutter_secure_storage`，禁止写入日志。
- `dart format --set-exit-if-changed .`、`flutter analyze`、`flutter test` 必须通过。

### 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| Dart 文件 | {{file.soft}} 行 | {{file.hard}} 行 |
| 单个 `build` 方法 | {{build.soft}} 行 | {{build.hard}} 行 |

- 行数按文件总行数计算（含空行和注释），生成的 `*.g.dart` / `*.freezed.dart` 不计。
- 达到「必须拆分」而不能拆分时，在回复中给出理由，并在文件注释中说明。
- 优先按职责拆分：子 Widget、Notifier、仓储、DTO 映射。

### 测试要求

- Notifier 与用例用 `ProviderContainer` + provider `overrides` 注入假仓储测试，覆盖加载、成功、空数据、失败。
- 组件测试用 `testWidgets` 渲染各状态并断言用户可见内容，元素通过 `Key` 或语义标签定位。
- 网络层用 mocktail 替换 Dio 适配器，覆盖统一响应解包与错误码映射，禁止访问真实网络。
- 核心流程写 `integration_test`，改动涉及时 `flutter test integration_test` 必须通过。
- 修复缺陷先写能复现缺陷的失败测试。
- `flutter analyze` 与 `flutter test` 必须通过；本机无法运行集成测试时在回复中写明未运行的测试。
