# v1.1.0 生产发布与真实宿主端到端验证

## Goal

把全部已验证工作合入 `main`，发布可安装的生产版本，并在真实 Claude Code 与 Codex 中用 Tenon 完成真实任务；过程中发现的问题全部修复，最终交付一个可以直接用于真实开发的完整插件。

## 约束

- 安装与验证走生产路径：官方 GitHub Release + `install.sh --claude|--codex`，不使用只在测试 fixture 中存在的捷径。
- Dashboard 不调用模型；工作流技能配置必须在 Dashboard UI 上真实完成（浏览器操作），执行在真实宿主会话中完成。
- 发布流水线（CI → release-candidate → writer → release → public acceptance）的门禁不得绕过或降级。
- 发现问题即修复；若已发布版本存在缺陷，以新补丁版本交付，不改写已发布标签。

## Requirements

- R1 合并：`main` 快进到集成分支，任务记录完整入库。
- R2 发布阻塞：high 级依赖漏洞、repository-hygiene、oracle 双跑回归、版本号一致性（根、workspace、两个插件 manifest、marketplace、install.sh、文档固定版本）、发布说明。
- R3 发布：推送 `main`，CI 通过，按流水线发布 `v1.1.0`，公开验收通过。
- R4 安装：本机用官方 `install.sh` 为 Claude Code 与 Codex 安装，runtime、doctor、Dashboard 健康；Codex hook trust 按官方边界处理。
- R5 自定义 workflow E2E（Claude Code）：在 Dashboard UI 新建 workflow、多个 track、为各阶段配置技能与门禁；在真实项目中用该 workflow 创建 change，真实执行多个阶段；逐阶段核对技能调用记录与产出（文档/字段/产物/transition 记录）。
- R6 default workflow E2E（Claude Code）：至少两个真实场景任务（例如功能开发、缺陷修复），走完真实阶段并核对产出与门禁。
- R7 Codex 兼容：Codex 中至少完成一个受治理任务的真实多阶段执行，hooks/skills/transition 生效。
- R8 问题修复：R4–R7 中发现的所有缺陷修复并补测试；若影响已发布版本，发布补丁版本并重新安装、复验。

## Acceptance Criteria

- [ ] `main` 包含全部工作；CI push 成功。
- [ ] GitHub Release 与 public acceptance 成功，版本号全部一致。
- [ ] Claude Code、Codex 官方安装成功，`tenon doctor` 与 Dashboard 健康。
- [ ] 自定义 workflow：UI 创建的 workflow/track/技能配置在执行中生效，每个执行阶段有对应技能调用与产出证据。
- [ ] default workflow：两个真实任务的阶段、门禁、文档与 transition 证据齐全。
- [ ] Codex：一个真实受治理任务的多阶段执行证据齐全。
- [ ] 所有发现的问题有修复提交与回归测试；最终交付版本经官方安装复验。
