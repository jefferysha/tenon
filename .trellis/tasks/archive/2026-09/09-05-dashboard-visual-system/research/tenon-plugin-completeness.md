# Research: Tenon 插件完整性与发布边界

- Query: 检查 Tenon 作为插件的 manifest、安装/bootstrap、hooks、commands、adapters、runtime/package 发布边界、升级/卸载/恢复、安全与可观测性；识别缺失功能与后续验证问题。
- Scope: internal
- Date: 2026-09-05

## Findings

### 已覆盖的主链路

1. 两套宿主 manifest 都声明 `skills` 与 `hooks`，Codex manifest 另外声明 interface、写能力和默认提示（`.codex-plugin/plugin.json:1-28`；Claude 版本为 `.claude-plugin/plugin.json:1-10`）。但 manifest 没有声明 CLI、Dashboard、runtime、adapter 或版本兼容矩阵；这些能力依赖发布包内的约定和 installer 校验，属于需要继续验证的隐式契约。
2. npm bootstrap 是薄入口：只接受 `setup --codex|--claude`，下载固定 release ref 的 `install.sh`，限制 30 秒、256 KiB、GitHub raw host，并校验 SHA-256 后交给 `/bin/bash`（`packages/npm-bootstrap/bin/tenon-bootstrap.mjs:8-12,34-45,48-75,78-100`）。它明确不保存凭证、不安装第二套 runtime（`packages/npm-bootstrap/README.md:1-24`）。
3. 根 installer 具备事务 journal、安装前 inventory、第三方状态变化保护、插件/marketplace 删除后置条件、官方 source/ref/clean checkout 校验，并在安装后检查 plugin version、enabled 状态和关键 release assets（`install.sh:790-930`）。这为升级失败恢复提供了较强基础。
4. hooks 是一组稳定 launcher ABI（`hooks/hooks.json:1-56`），覆盖 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse；README 将 Codex 的一次性 hook trust、各 adapter 的 A/B/C 保真度和 Amp 未做真实凭证会话 E2E 验证明确写出（`README.md:198-215`）。
5. uninstall 使用 `.pipeline-owned.json` 的 path→hash 所有权清单，用户修改文件保留、结构化配置 scrub、stub 明示跳过，并要求 `--yes`；HOME 根有硬守卫（`packages/cli/src/commands/uninstall.ts:1-18,64-95,164-205`）。文档同时把宿主插件移除与项目资产 scrubber 分开（`docs/usage/zh-CN/updates-recovery-and-uninstall.md`）。
6. 发布边界在 README/安全模型中定义为：仓库 workspace 不宣称公开 global npm CLI；npx 仅作为 GitHub Release asset，release candidate 绑定精确 40 位 SHA、artifact digest、逐资产 SHA-256 和只读验证 job，writer 不 checkout/执行仓库代码（`README.md:248-263,268-275`；`docs/usage/zh-CN/security-model.md`）。

### 缺失或应优先深入调查的功能

**P0（发布前必须取得证据）**

- **真实宿主安装/升级/回滚矩阵。** 当前 acceptance 测试大量模拟 host CLI；README 明确 Amp 没有凭证 E2E 证据，A/B/C 也存在 advisory 或 commit-time 降级。研究问题：Codex、Claude、Gemini、Continue、Cline、Amp 的真实版本组合是否能加载 hooks、skills、CLI 与 dashboard？验证路径：干净临时 HOME + 真实宿主 CLI，逐宿主执行 setup、启动新会话、触发 SessionStart/PreToolUse/PostToolUse，再执行 update、故障注入和 rollback，保存退出码、inventory、runtime status 和脱敏日志。
- **发布 payload 完整性与可复现性。** installer 只显式检查若干文件存在（`install.sh:923-930`），而 manifest 未声明 CLI/runtime/dashboard 的 payload schema。研究问题：`build:npx-package`、release workflow、marketplace checkout 与 plugin root 是否是同一 digest；是否存在“文件存在但 bundle 过期/跨包版本不一致”？验证路径：对 release candidate 运行 `check:release-workflows`、`check:npx-package`、`verify-skills.sh`，解包后逐资产 hash 与 source commit 对比，执行 `tenon doctor/runtime status`。
- **安全边界的运行时观测。** 文档声明 loopback、Host 校验、随机 handshake、项目根限制和 Tap 默认关闭，但本次静态盘点未建立统一事件/指标清单。研究问题：安装、激活、hook 拒绝、runtime 回滚、Dashboard mutation 和敏感数据脱敏是否可追溯且不会泄露 prompt/token？验证路径：开启各类失败注入，检查 audit/state 文件权限、事件字段、日志脱敏、端口监听和进程归属；核对 `doctor --json` 与 runtime journal 是否能解释每次状态变化。

**P1（完整性与可运维性）**

- **卸载覆盖面与跨宿主所有权。** lite scrubber 对 `opencode/pi/codex/tap` 等 kind 明示为 stub（`uninstall.ts:85-89`），这虽诚实但意味着“完整插件卸载”仍可能留下受管投影。研究问题：每个 adapter 的配置是否有 ownership/hash 记录、用户修改能否保留、重复卸载是否幂等？验证路径：为 12 个 adapter 建立真实 fixture，安装→修改→dry-run→卸载→重复卸载，逐项检查受管文件、平台根目录和用户自有字段。
- **升级并发与旧会话语义。** 文档规定原子切换、旧会话继续使用旧 Skills/hooks、新会话才使用新版本（`docs/usage/zh-CN/updates-recovery-and-uninstall.md`），但需要真实验证。研究问题：更新中启动 setup、两个 updater 并发、Dashboard 正在运行、旧 launcher 残留时是否 fail-closed 且可恢复？验证路径：并发运行 update/repair，注入 SIGTERM/网络中断/半写 journal，确认 active 指针、锁、旧 release 和恢复 journal。
- **命令与 adapter 能力声明统一。** 根 README 的 12 宿主矩阵是产品声明；各 adapter README/settings/install.sh 是实现声明。研究问题：是否每一行能力、降级、配置目录、trust 语义都有自动一致性检查？验证路径：生成 adapter contract inventory，比较 `adapters/*/README.md`、`settings.json/hooks.json`、install 脚本和 `tools/test-adapters.sh`，补真实 CLI smoke 证据，尤其 Amp/Cline/Continue。

**P2（体验与长期维护）**

- **Manifest schema/version/compatibility。** 两份 plugin.json 版本字段和描述不同，且没有 schema version、minimum host version、runtime API version 或 capabilities 的机器可读声明。建议研究官方 Codex/Claude manifest 版本演进与可声明字段，设计发布前 schema lint 和 host compatibility gate。
- **可观测性产品面。** CLI 有 doctor/runtime status，Dashboard 有机器诊断，但没有在已查看文档中发现统一 telemetry opt-in、事件保留/轮换或导出格式。建议定义本地-only audit schema、敏感字段 redaction contract、保留上限和 `doctor` 可解释性测试；不得默认外传。

## Related specs

- `.trellis/spec/kernel/backend/*`：状态、错误、编排和质量约束，适合核对 runtime/恢复语义。
- `.trellis/spec/cli/frontend/*`：CLI 目录、状态与类型约束。
- `.trellis/spec/server/backend/*`：Dashboard/API 安全与服务端边界。
- `.trellis/spec/guides/cross-layer-thinking-guide.md`：跨 manifest→installer→runtime→host projection 的一致性检查。

## Caveats / Not Found

- 本次为内部静态研究，未执行真实宿主 CLI、网络发布、升级/回滚或 destructive uninstall；不能把 acceptance fixture 结果当作真实宿主通过证据。
- 按研究代理边界未读取 `implement.jsonl`/`check.jsonl`，未修改代码、spec 或配置；只写入本研究文件。
- 未找到单一机器可读的“完整插件 payload manifest”，也未找到覆盖所有宿主的统一 capability/telemetry schema；这是后续调查的高价值缺口。
