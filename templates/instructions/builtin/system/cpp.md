---
id: cpp
category: system
title: C++
directory: native/
directory_label: C/C++ 工程根目录
variables:
  - key: lib
    default: core
  - key: file.soft
    default: 500
  - key: file.hard
    default: 800
  - key: function.soft
    default: 50
  - key: function.hard
    default: 100
---
## 系统（C++）

### 技术栈

C++20 + CMake（`cmake_minimum_required(VERSION 3.28)`）+ vcpkg 清单模式 + clang-tidy + clang-format；测试 GoogleTest + CTest。

- 依赖只写在 `vcpkg.json`，并用 `builtin-baseline` 固定版本；通过 `CMakePresets.json` 的 `toolchainFile` 接入 vcpkg，禁止依赖本机碰巧安装的库。
- 构建只用 CMake 预设：`debug`（AddressSanitizer + UndefinedBehaviorSanitizer）、`tsan`（ThreadSanitizer，用于并发代码）、`release`。
- 格式化以仓库根 `.clang-format` 为准，静态检查以 `.clang-tidy` 为准。

### 分层结构

```
native/
├── CMakeLists.txt
├── CMakePresets.json            # 接入 vcpkg 工具链与各构建预设
├── vcpkg.json                   # 依赖清单与 builtin-baseline
├── cmake/                       # 警告、sanitizer 等可复用 CMake 模块
├── include/{{lib}}/             # 公开头文件：对外 API
├── src/                         # 实现与内部头文件
└── tests/                       # GoogleTest 测试，gtest_discover_tests 注册到 CTest
```

依赖规则：

- `tests` 通过 `include/{{lib}}/` 的公开 API 测试；内部实现放在 `{{lib}}::detail` 命名空间，不出现在公开头文件的签名中。
- 公开头文件禁止包含 `src/` 的内部头文件，禁止暴露第三方库类型（需要时用 pimpl 隔离）。
- 外部依赖只通过 `find_package` + `target_link_libraries` 使用。

### 编码规范

- `CMAKE_CXX_STANDARD 20`、`CMAKE_CXX_STANDARD_REQUIRED ON`、`CMAKE_CXX_EXTENSIONS OFF`；
  编译选项 `-Wall -Wextra -Wpedantic -Werror -Wshadow -Wconversion -Wnon-virtual-dtor`（MSVC 用 `/W4 /WX`）。
- 所有资源用 RAII 管理；禁止裸 `new` / `delete`，独占所有权用 `std::unique_ptr`（`std::make_unique`），确实共享才用 `std::shared_ptr`。
- 不拥有的参数用引用、`std::span`、`std::string_view` 传递，并保证其生命周期覆盖使用期；裸指针只表示可空的非拥有引用。
- 优先零法则；自定义析构时同时处理拷贝与移动（五法则），移动操作标注 `noexcept`。
- 坚持 `const` 正确性；返回值必须被检查的函数标注 `[[nodiscard]]`。
- 异常禁止跨越 ABI 边界：对外的 C 接口与插件边界捕获全部异常并转换为错误码；库内部统一一种错误处理方式并在 README 写明。
- 头文件禁止 `using namespace`；公开符号放在 `{{lib}}` 命名空间。
- 禁止 C 风格转换；`reinterpret_cast` 必须写注释说明原因；常量用 `constexpr`，禁止用宏定义常量。
- 并发用 `std::jthread`、`std::mutex` + `std::scoped_lock`，禁止分离线程；共享数据的保护方式写在类注释中。
- 标准算法与 ranges 能表达时优先使用，避免手写下标循环越界。
- `clang-format --dry-run --Werror` 与 `clang-tidy`（启用 `bugprone-*`、`cppcoreguidelines-*`、`modernize-*`、`performance-*`）必须通过。

### 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| C++ 源文件 / 头文件 | {{file.soft}} 行 | {{file.hard}} 行 |
| 单个函数 | {{function.soft}} 行 | {{function.hard}} 行 |

- 行数按文件总行数计算（含空行和注释）。
- 达到「必须拆分」而不能拆分时，在回复中给出理由，并在文件注释中说明。
- 优先按职责拆分：独立类、自由函数、`detail` 实现文件。

### 测试要求

- 测试框架：GoogleTest + gMock，用 `gtest_discover_tests` 注册到 CTest。
- 每个公开类与函数覆盖正常路径、错误路径（异常或错误码）、边界输入；依赖通过接口注入并用 gMock 替身隔离。
- 所有测试在 `debug` 预设下运行，由 AddressSanitizer / UndefinedBehaviorSanitizer 检出内存与未定义行为问题；并发代码另在 `tsan` 预设下运行。
- 修复缺陷先写能复现缺陷的失败测试。
- `cmake --preset debug && cmake --build --preset debug && ctest --preset debug --output-on-failure` 必须通过。
