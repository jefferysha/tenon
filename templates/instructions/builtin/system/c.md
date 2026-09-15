---
id: c
category: system
title: C
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
## 系统（C）

### 技术栈

C17 + CMake（`cmake_minimum_required(VERSION 3.28)`）+ clang-format + clang-tidy；测试 Unity + CTest。

- 构建只用 CMake 预设（`CMakePresets.json`），提供 `debug`（开启 AddressSanitizer / UndefinedBehaviorSanitizer）与 `release` 两套。
- 第三方依赖固定版本，通过 `FetchContent` 或 git 子模块引入 `third_party/`，禁止依赖本机碰巧安装的库。
- 格式化以仓库根 `.clang-format` 为准，静态检查以 `.clang-tidy` 为准。

### 分层结构

```
native/
├── CMakeLists.txt               # 项目、C 标准、编译选项、子目录
├── CMakePresets.json            # debug / release 预设
├── include/{{lib}}/             # 公开头文件：只放对外 API 声明
├── src/                         # 实现与内部头文件（*_internal.h）
├── tests/                       # Unity 测试，每个模块一个 test_<module>.c
└── third_party/                 # 固定版本的外部依赖
```

依赖规则：

- `tests` 只通过 `include/{{lib}}/` 的公开 API 测试，确需测试内部函数时通过专门的内部测试目标链接。
- `include/` 中的头文件禁止包含 `src/` 的内部头文件，也禁止暴露第三方库的类型。
- 外部依赖只通过 CMake target（`target_link_libraries`）使用，禁止直接写第三方路径。

### 编码规范

- `CMAKE_C_STANDARD 17`、`CMAKE_C_STANDARD_REQUIRED ON`、`CMAKE_C_EXTENSIONS OFF`；编译选项 `-Wall -Wextra -Wpedantic -Werror -Wshadow -Wconversion -Wvla`。
- CMake 只用 target 级命令（`target_include_directories`、`target_compile_options`），禁止全局 `include_directories` / `add_definitions`。
- 每个可能失败的调用都检查返回值（`malloc`、`fopen`、`read`、`write` 等）；函数错误以枚举状态码返回，禁止忽略。
- 每块堆内存都有明确所有者：成对提供 `{{lib}}_xxx_create` / `{{lib}}_xxx_destroy`，在声明处注释由谁释放；释放后把指针置为 `NULL`。
- 禁止变长数组与 `alloca`；禁止 `strcpy`、`strcat`、`sprintf`、`gets`，拷贝与格式化必须显式传入缓冲区长度（`snprintf`、`memcpy` + 长度检查）。
- 对大小做算术前先检查溢出；尺寸与下标用 `size_t`，数据格式字段用 `<stdint.h>` 定长类型。
- 仅在本文件使用的函数与变量声明为 `static`；公开符号统一加 `{{lib}}_` 前缀；禁止可变全局变量，确需共享状态时说明线程安全性。
- 不修改的指针参数声明为 `const`；头文件自包含并使用 include guard。
- 宏只用于条件编译与头文件保护，常量用 `enum` 或 `static const`，禁止带副作用的函数式宏。
- 调试构建默认开启 sanitizer，CI 必须跑 `debug` 预设的全部测试。
- `clang-format --dry-run --Werror` 与 `clang-tidy`（启用 `bugprone-*`、`cert-*`、`clang-analyzer-*`）必须通过。

### 文件长度

| 文件类型 | 超过则评估拆分 | 超过则必须拆分 |
| --- | --- | --- |
| C 源文件 / 头文件 | {{file.soft}} 行 | {{file.hard}} 行 |
| 单个函数 | {{function.soft}} 行 | {{function.hard}} 行 |

- 行数按文件总行数计算（含空行和注释）。
- 达到「必须拆分」而不能拆分时，在回复中给出理由，并在文件注释中说明。
- 优先按职责拆分：独立模块（`.c` + 内部头文件）、辅助函数、数据表。

### 测试要求

- 测试框架：Unity，每个测试文件用 `add_test` 注册到 CTest。
- 每个公开函数覆盖正常路径、每个错误返回码、边界输入（空指针、零长度、最大长度）。
- 分配与释放成对的接口必须有测试，在 `debug` 预设下由 AddressSanitizer 检出泄漏与越界。
- 修复缺陷先写能复现缺陷的失败测试。
- `cmake --preset debug && cmake --build --preset debug && ctest --preset debug --output-on-failure` 必须通过。
