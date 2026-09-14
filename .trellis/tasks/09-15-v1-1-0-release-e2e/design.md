# 技术设计

## 发布路径

`install.sh` 与 `tenon setup` 只接受官方 GitHub Release（API 校验已发布、非 draft、tag → commit 链），宿主 marketplace 必须是 `jefferysha/tenon@vX.Y.Z`。因此不做本地捷径安装：

1. `main` 推送 → `CI` push 成功（ci.yml 全量门禁）。
2. `release-candidate.yml`（workflow_dispatch，`ref` = main 精确 SHA，`tag` = `v1.1.0`）→ 版本一致性、依赖、hygiene、构建新鲜度、N-1 bundle、文档站、全量测试、oracle、真实 Codex clean install → 产出 approval evidence。
3. `release-writer.yml`（workflow_run）创建 tag 并派发 `release.yml` 与 `release-public-acceptance.yml`。
4. 本机以官方一行命令安装 `--claude` 与 `--codex`。

发布后发现缺陷：修复 → 版本 `1.1.1` → 同一路径重发 → 重新安装复验。

## E2E 环境

- 沙箱项目：`/Users/a1234/Documents/code-manager/projects/tenon-e2e-*`，独立 git 仓库，真实小型应用代码（Node/TS），不在 tenon 仓库内。
- Claude Code：真实 `claude -p` 会话（本机已登录），加载官方安装的 Tenon 插件与 hooks；工作目录为沙箱项目。
- Codex：真实 `codex exec`（本机已登录）；hook trust 按官方 `/hooks` 边界处理，必要时以 Codex 支持的非交互 trust 配置完成，并记录方式。
- Dashboard：官方安装启动的 `127.0.0.1:18765`；UI 操作通过 Playwright 浏览器真实点击/拖拽完成。

## 证据

每个阶段记录：`tenon status/history --json`、`.pipeline-transitions/`、技能调用事件、文档 ledger、产物目录、工作区文件 diff、宿主会话输出摘要；Dashboard 截图用于 UI 配置与运行状态核对。证据写入本任务 `research/`（不含 token 或凭证）。

## 缺陷处理

每个缺陷：复现步骤 → 根因 → 修复 + 回归测试 → 相关门禁 → 合入 main。若缺陷只影响测试环境搭建而非产品，记录为环境说明，不改产品。
