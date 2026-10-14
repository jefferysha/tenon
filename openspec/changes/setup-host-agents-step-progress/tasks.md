# 任务

## 立项

- [x] 写 proposal / design / tasks：记录会话中途生成子代理导致 not found 的证据、Todo 工具缺失的证据、与另一款终端一次性安装式开发工具的对比、范围与非目标。

## 调研

- [x] 核实 Claude Code 子代理加载时机、用户级与项目级的优先级、hook `systemMessage` 的显示行为；Codex 对应能力。 (explore)
- [x] 对照 `tenon setup` / `tenon update` / `tenon sync` / `tenon uninstall` 的职责，选定子代理文件的写入命令与位置，写进设计。 (explore)
- [x] 定旧项目级文件、所有权清单与本机排除的迁移清理方案，写进设计。 (explore)

## 规格

- [x] 写 `host-native-subagents` 的 delta spec（终端安装写用户级、会话内不写、一致性判定与原因、项目层退回、旧文件清理）。 (spec)
- [x] 写 `effective-workflow-plan` 的 delta spec（`tenon workflow progress` 与 `step-progress` hook 打印步骤清单，不依赖宿主 Todo 工具）。 (spec)
- [x] 写实施计划与测试计划：改动顺序、验收命令、受影响的单测与集成测试。 (spec)
- [x] 第二轮：写 `change-start-point`、`task-worktree-isolation` 的 delta spec 与 `workflow-skill-enforcement` 的修改；`host-native-subagents` 补未派发运行的登记。 (spec)
- [x] 第二轮：更新 proposal / design / 技术设计 / ADR 与实施计划，覆盖任务起点、新任务 worktree、worktree 构建版本、退回边技能门。 (spec)
- [x] 第三轮：`task-worktree-isolation` 补「宿主为子代理与会话建的检出不计入工作区指纹」；同步 proposal / design / 技术设计 / ADR / 实施计划，并修正其中已过时的兼容性与 hook `if` 过滤表述。 (spec)
- [x] 第四轮：`host-native-subagents` 改为用户级子代理目录跟随 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`、所有权按目录分组、退回提示给出所检查的目录；同步 proposal / design / 技术设计 / ADR / 实施计划。 (spec)
- [x] 第五轮：`task-worktree-isolation` 写明 `TENON_INIT_IN_PLACE=1` 原地建立不输出原因（`--in-place` 照常输出）；`change-start-point` 补上 `start_sha` 入选候选的提交时间条件（不晚于 `created_at` + 60 秒）；同步 proposal / design / 技术设计 / ADR / 实施计划。 (spec)

## 实现

- [x] kernel：用户级宿主文件写入与用户级所有权清单（`<configRoot>/agents/host-owned.json`），过期文件删除，符号链接拒绝。 (build)
- [x] cli：新增 `tenon agent install [--host]` 与 `tenon agent uninstall [--host]`；`tenon setup` / `tenon update`（含已是最新版）成功后调用安装；`agent add/new/copy/rm` 改为只提示。 (build)
- [x] cli：删除 `tenon init` 与 `tenon agent prompt` 中的生成调用；prompt 改为比较用户级文件与冻结定义，返回通用子代理时记录原因并提示。 (build)
- [x] cli + server：回收逻辑改为旧项目级文件清理，在 `tenon init` 与归档/删除任务时执行。 (build)
- [x] cli：新增 `tenon workflow progress <change>`。 (build)
- [x] hook：新增 `hooks/step-progress.sh` 并注册到 `hooks/hooks.json`；实测 Codex 是否接受 `if` 字段。 (build)
- [x] 修改 `skills/tenon/SKILL.md` 第 5 步与 `run-agent` 行；更新 `docs/usage/agents.md` 中英文版。 (build)
- [x] 更新与新增 kernel / cli / server 单测与集成测试、hook 测试。 (build)
- [x] kernel：`start_sha` 字段（CLI init、Dashboard 建任务、triage 物化都写入）与起点候选取最新的解析，全部使用方经同一入口；三个决定起点的字段经 CLI 不可改写。 (build)
- [x] kernel + cli：`tenon init` 建任务 worktree（判定、创建、失败回滚、本机排除、`base_branch` / `isolation` / `start_sha`），继承信任条目，执行测试目录 `setup`；目录 schema 增加 `setup` 并配置本仓。 (build)
- [x] cli + hook + skill：`tenon list`、按名读取的报错与 `hooks/router.sh` 找到 worktree 任务；skill「进入」与恢复改为切进 worktree；`finish-change` 附带 `cleanup`。 (build)
- [x] cli + kernel：`isolation=worktree` 的构建版本改绑工作区指纹；更新 `docs/CONTRACT.md`。 (build)
- [x] kernel + cli：退回边不要求归属 agent 的技能；`tenon agent record --subagent none` 登记 `not-dispatched`。 (build)
- [x] 更新使用文档与 CLI 参考中英文版（新任务 worktree、准备命令、Codex 开新会话、清理命令、新命令与新选项）；`CONTEXT.md` 增加术语。 (build)
- [x] 测试环境统一导出 `TENON_INIT_IN_PLACE=1`（vitest 全局 setup 与 shell 测试），确认既有测试与 N-1 兼容检查无回归。 (build)
- [x] 把本任务用到与新增的测试文件与套件登记进测试计划（`tenon test register`，照 `next`）。 (build)
- [x] kernel：完整工作区指纹跳过未被 git 跟踪的 `.claude/worktrees/`（被跟踪的照算）；更新 `host-local.ts` 说明、`docs/CONTRACT.md` 与测试，确认 N-1 指纹一致性检查仍过。 (build)
- [x] kernel + cli：用户级子代理目录跟随 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`（`hostAgentsDir`，只认绝对路径），安装、卸载、`setup` / `update` 与 `agent prompt` 判定共用；所有权清单按目录分组；`prompt` 退回时给出所检查的目录；更新测试（只用临时目录与注入的环境变量）、帮助文本与 `docs/usage/agents.md` 中英文版。 (build)
- [x] cli 测试：把 `init.test.ts` 里「新任务建在 worktree 里」一组用例搬到 `init-worktree.test.ts`、其中「信任继承与 setup」一组搬到 `init-worktree-setup.test.ts`，两者共用的夹具抽到 `init-worktree-test-support.ts`（并加入 `packages/cli/tsconfig.json` 的 `exclude`，不进 CLI dist）；用例原样搬、不改断言，新文件登记进测试计划。 (build)
- [x] 工具：仓库卫生检查为本任务调研步的 researcher 报告（`.pipeline-agent-reports/10167049-5af1-4624-bd94-53b2548a9153.md`，在途与归档两个路径）加一条窄豁免，只放行第一个参考身份；报告带登记摘要不能改写，做法与已有调研记录的豁免一致，并补 node 测试。 (build)

## 验证

- [x] cli、kernel、server 单测与集成测试、hook 测试（`npm run test:hooks`）、bundle 与 N-1 兼容检查、类型检查、lint 全过。 (verify)
- [x] 本地跑齐 `package.json` 的 `check:*`（至少 `check:repository-hygiene`、`check:openspec`、`check:docs`、`check:architecture`）。 (verify)
- [x] 真机验收：在带着本机 `CLAUDE_CONFIG_DIR` 的环境里 `tenon agent install` 后开新会话，会话里新建任务并派发 `tenon-researcher` 成功；`tenon transition` 后终端出现步骤清单，失败的 `tenon transition` 不出现清单。 (verify)
- [x] 真机验收：主检出会话里新建任务落在 `.worktrees/<change>`，`EnterWorktree` 切入后 activate 与评审确认生效（确认 hook 的 `cwd`）；主检出 `tenon list` 能看到它。 (verify)

## 交付

- [ ] 提交交付物。 (ship)

## 完结

- [ ] 归档变更。 (archive)
