# 安装与宿主配置

本指南完成 Tenon 的一次性安装、宿主选择、运行时检查和第一轮验证。安装时必须显式选择宿主，避免把 Codex、Claude Code 或其他平台的 hook/skill 目录混在一起。

## 目标

完成后，你会得到一个用户级、可更新、可回滚的 Tenon 安装；选定宿主能在新会话加载对应 adapter，`tenon` CLI 能找到受管 runtime，Dashboard 能在本机 loopback 打开。

## 前置条件

- Node.js 22 或更高版本；
- Git；
- Codex 用户先安装官方 CLI：`npm install -g @openai/codex`，并运行 `codex --version` 验证；
- 对用户级插件目录有写权限；
- 可选：Docker，用于 AFK 隔离执行。

先确认基础环境：

```bash
node --version
git --version
```

不要把仓库内 `node_modules/.bin` 当成用户安装结果。setup 的目标是安装稳定 launcher 和受管 release，让多个项目共享同一份已验证 runtime。

## 步骤

### 1. 一步安装并选择宿主

新用户无需 clone、安装 monorepo 依赖或本地 build。安装 Codex：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.5/install.sh | /bin/bash -s -- --codex
```

安装 Claude Code：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.5/install.sh | /bin/bash -s -- --claude
```

首次安装前可执行零写入预览。它会列出完整的宿主 Marketplace 命令和包内 setup 计划，但不会调用
Codex/Claude，也不会写 Tenon、宿主或项目状态：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.5/install.sh | /bin/bash -s -- --codex --dry-run
```

版本化脚本只使用不可变稳定版本 `v0.1.5` 的预构建资产，不 clone 仓库、不执行源码编译。

Claude Code 宿主会把本仓库作为插件市场 clone，其默认 clone 超时为 120 秒。网络较慢时先放宽再安装，例如 `CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS=1800000`；clone 超时会让该宿主处于未装插件状态，放宽后重跑安装即可。
脚本只负责注册 Tenon Marketplace、安装并验证完整 payload，然后调用包内
`tenon setup --<host>`。已经安装的用户可以直接再次运行 `tenon setup --codex`
修复宿主接线；更新时运行 `tenon update --codex`（或 `--claude`）。手动更新和显式启用的
自动更新复用同一个整包事务，不再拆出第二套 CLI 自更新通道。

Tenon 版本号已重置为从 0.1.0 开始，已退役的 1.x Release 与标签全部删除。机器上仍是 1.x 安装时，
每个宿主各运行一次版本化的 `v0.1.5/install.sh` 命令。1.x 上的 `tenon update` 只会报告降级且不做
任何改动：那段拒绝逻辑属于已经发布的 1.x，无法事后修补；因此也不能用第二次命令或 Dashboard/校验
脚本副作用冒充一键升级。从 v0.1.0 起，之后每次常规升级只运行一条
`tenon update --codex`（或 `--claude`），交付身份始终是稳定 release tag。

setup 始终启动 Dashboard 并等待 readiness。curl/CI 安装不会自动打开浏览器，而会打印已验证 URL 与
`tenon dashboard --open`；交互式首次 setup 可以自动打开，手动更新和后台更新都不自动打开。

#### Codex 账号认证

插件安装与账号认证是两个独立步骤。Codex setup 成功后，Tenon 只读运行
`codex login status`；它不会自动登录、读取 `auth.json` 内容或保存凭证。尚未登录时任选一条：

```bash
# ChatGPT 方案包含 Codex
codex login

# 远程或无浏览器终端
codex login --device-auth

# Platform API Key：先在 https://platform.openai.com/api-keys 创建
printenv OPENAI_API_KEY | codex login --with-api-key

# 两种路径都用同一命令复核
codex login status
```

ChatGPT 方案登录通常无需另配 API Key；Platform API Key 使用独立的按量计费。不要把 Key 直接
拼进命令参数、日志或 Issue。非 TTY/CI 安装不会因为尚未登录而阻塞。

这些命令有两层真实验收。CI 安装固定版本的真实 Codex CLI，从精确候选 checkout 构造隔离 Git 镜像，
为该镜像创建同一个稳定版本 tag，并在独立临时 `HOME`、`CODEX_HOME`、`TENON_RUNTIME_HOME` 和
Dashboard 端口中运行版本化安装器。不可变公开 tag 创建后，公网验收只下载该 tag 的 `install.sh`。
两条路径都会检查稳定 launcher、doctor、受管
runtime、Dashboard API 与 HTML 产品身份、新 Codex app-server 对插件/入口 Skill/hooks 的发现，
并重复执行相同安装，证明 release 与 listener 均未变化。

验收不会读取或复制用户的 Codex 凭据，也不会替用户信任 hook。因此新 Codex 进程会把 Tenon
hooks 报告为 `untrusted`，直到用户执行下方 `/hooks` 步骤；这是预期的人工安全边界，不是安装失败。

Marketplace bootstrap 是当前可用且推荐的一步安装入口。仓库可以把薄 npx 包作为 digest 已验证的
GitHub Release 资产构建，但发布自动化绝不执行 `npm publish`。只有另行明确授权、使用维护者持有的
npm publisher scope 完成公开发布后，文档才会展示真实的
`npx --yes @<publisher>/tenon setup --codex` 命令；它不会复制第二套 runtime，最终仍执行同一个
Marketplace 安装事务。未发布前不要猜 npm 包名。

不同宿主的 hook 能力不完全相同。文档和 Dashboard 会按 adapter fidelity 说明哪些门是原生强制、哪些依赖会话提示或显式 CLI。

不要省略宿主参数。`tenon setup` 需要知道要写入哪个宿主的 skills、hooks 和 manifest；这不是能从当前 shell 可靠猜出的信息。

### 2. 新开宿主会话

setup 完成后关闭旧会话，再创建新会话。已启动的 Codex 或 Claude Code 通常不会热加载刚写入的 SessionStart、skills 和 hook 配置。

### 3. 检查受管 runtime

```bash
tenon doctor
tenon runtime status
tenon dashboard --open
```

`doctor` 应报告 CLI、skill bundle、hook 和 runtime 的真实状态。Dashboard 默认使用 `127.0.0.1:18765`；如果端口占用，先确认进程身份，不要盲目结束其他项目。

### 4. 理解安装目录

发行版使用不可变 release 目录和稳定 launcher。自动更新切换 release 指针，而不是覆盖项目内 Change 文档。项目仓库只保存 `.pipeline` 配置、`openspec/changes` 和实际证据。

具体绝对路径由操作系统的用户级标准目录决定。不要在项目根复制一份私有 CLI 作为“后门”，否则自动更新、回滚和 skill trust tier 会产生两个互相漂移的真相源。

## 预期结果

- `tenon doctor` 不会把缺失 runtime、损坏 skill 或失效 hook 报成绿色；
- `tenon runtime status` 显示当前激活 release 和校验状态；
- `tenon dashboard --open` 打开 Tenon，而不是其他占用端口的应用；
- 新建 Change 时治理文档默认使用中文；
- 显式 `--document-locale en` 的新 Change 固定使用英文模板。

## 受管运行时位置

payload、状态与配置使用操作系统标准应用目录：

- macOS：`~/Library/Application Support/tenon/`；
- Linux：带 `tenon` 命名空间的 XDG data/state/config；
- Windows：Local AppData 保存 data/state，Roaming AppData 保存 config。

Tenon 不把自有状态写进 `~/.claude` 或 `~/.codex`。项目注册表和凭证位于 Tenon config root，
runtime selection、audit、Dashboard token 与 pidfile 位于 state root。隔离测试或运维需要改根目录时，
只使用 `TENON_RUNTIME_HOME`；它会整体重定向 data/state/config，不存在 Dashboard 专属第二套 Home。

稳定命令 launcher 通常位于 `~/.local/bin/tenon`。宿主 Marketplace/cache 目录属于宿主私有实现。

## 验证

在任意已初始化项目执行：

```bash
tenon doctor
tenon runtime status
tenon list --json
```

验证 Dashboard 时，除 HTTP 200 外还要核对页面标题、导航和项目根。端口可访问不代表服务身份正确。

## 常见失败

- `command not found`：重新打开 shell，检查 launcher 是否在 PATH；
- skill 缺失：运行 `tenon doctor`，再执行对应宿主的 repair/setup；
- hook 未生效：关闭旧会话并新建会话；
- Dashboard 打开了其他应用：核对页面标题和实际监听进程；
- setup 报已有不同宿主配置：使用明确的 `--codex` 或 `--claude`，不要手工混合目录；
- runtime 校验失败：先运行 `tenon runtime status`，再按受控流程 repair/rollback；
- Docker 不可用：只影响声明需要 AFK/sandcastle 的路径，不应阻断普通交互式 Change。
- 从旧产品身份升级：旧仓库只发布迁移桥；它先安装并复验 Tenon，再等待新会话证明，最后才删除旧登记和仍与所有权摘要一致的旧 launcher。

## 下一步

继续完成[第一个受治理任务](./quickstart.md)。更新和回滚见[更新、恢复与卸载](./updates-recovery-and-uninstall.md)。
