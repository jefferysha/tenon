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

- [x] `main` 包含全部工作；CI push 成功。（4dd532ed，CI run 34891235494）
- [x] GitHub Release 与 public acceptance 成功，版本号全部一致。（tag v1.1.0 → 4dd532ed；candidate 34893645128、writer 34895580900、public acceptance 34895640345 均 success。真实宿主 E2E 发现的问题修复后发布 v1.1.1 → ff43678a；CI 34900976342、candidate 34903045427、writer 34904581145、public acceptance 34904618718 均 success。继续真实执行发现交互门问题，修复后发布 v1.1.2 → 35481522；CI 34908792500、candidate 34910566013、writer 34912116129、public acceptance 34912151246 均 success。v1.1.3 → bf5cff4e（安装网络重试、解锁后明确告知）；CI 34915146877、candidate 34916792381、writer 34918322103、public acceptance 34918351145 均 success。在 v1.1.3 上继续真实 Codex 任务 X2 发现技能读取证据问题，发布 v1.1.4 → a3351189（Codex `text(await exec)` 读取计入证据、未确认 producer 的错误给出恢复方法）；CI 34920624741、candidate 34922053099、writer 34923506556、public acceptance 34923533592 均 success。X2 在 v1.1.4 上跑到 archived 途中发现中文 delta spec 缺 SHALL/MUST 拖到 Verify 才暴露、待确认评审的未识别回复无提示，最终交付 v1.1.5 → a0a7f0a4；CI 34927495007、candidate 34929499474、writer 34930601856、public acceptance 34930633366 均 success，2026-09-15 04:54 UTC 发布）
- [x] Claude Code、Codex 官方安装成功，`tenon doctor` 与 Dashboard 健康。（v1.1.1：Claude 插件 1.1.1 无加载错误、70 skills/4 hooks；Codex 插件 1.1.1 enabled；doctor 19 green + 2 预期黄灯；Dashboard version 1.1.1。v1.1.2：Claude 插件 1.1.2 errors=[]、70 skills/4 hooks；Codex 插件 1.1.2 enabled，active runtime host=codex v1.1.2 valid；doctor 20/21 green，仅 AFK Claude 凭证黄灯；Dashboard version 1.1.2。Codex 安装前两次因代理网络瞬时失败（git fetch ETIMEDOUT、SSL_ERROR_SYSCALL），第三次成功，已补网络重试修复 f7375184）
- [x] 自定义 workflow：UI 创建的 workflow/track/技能配置在执行中生效，每个执行阶段有对应技能调用与产出证据。（C1 api 轨道、C2 docs 轨道，见 research/e2e-custom-workflow.md）
- [x] default workflow：两个真实任务的阶段、门禁、文档与 transition 证据齐全。（D2 free 轨道修复 upcoming() 全程到 archived；D1 backend 轨道 filterByPriority 走到 ship，因沙箱无远程无法提供 pr_url 如实停下；见 research/e2e-default-workflow-and-codex.md）
- [x] Codex：一个真实受治理任务的多阶段执行证据齐全。（X1 add-rename-task：open→explore→spec→build→verify→ship，全部评审门禁终端批准；Explore 期间发现交互门重复加锁并在 v1.1.2 修复、确认后 agent 不重试在 v1.1.3 修复；ship 因无远程无法提供 pr_url 如实停下；见 research/e2e-default-workflow-and-codex.md）
- [x] 所有发现的问题有修复提交与回归测试；最终交付版本经官方安装复验。（v1.1.1–v1.1.5 共五次补丁发布，每个修复都带回归测试；v1.1.5 本地镜像 CI 门禁 28/28、CI 34927495007 通过；官方安装 v1.1.5 后 Claude 插件无加载错误、Codex 插件启用、doctor 无红灯、Dashboard 1.1.5、已安装 hooks 冒烟 13/13；在正式安装的 v1.1.5 上用 Claude Code 跑通 D3 count-open-tasks（default/free 七个阶段到 archived，两次本地提交）；Codex X2 remove-task 在 v1.1.3→v1.1.4 上跑到 archived，含一次真实 verify-fail 回退；见 research/e2e-default-workflow-and-codex.md）
