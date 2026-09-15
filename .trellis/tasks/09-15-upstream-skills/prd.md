# 技能从上游来源安装

## Goal

Tenon 调用的所有第三方 skill 都从各自的上游来源安装完整、最新的版本，安装 Tenon 和每次更新 Tenon 时同步更新；
Tenon 不再维护截断的第一方副本，只维护自己的工作流技能。

## Background (confirmed, see `research/current-skill-bundle.md`)

- 插件里 62 个 skill 全部登记为 Tenon 自带；第三方来源的 skill 都是 13–24 行的精简改写
  （例如 hue 14 行，上游 869 行并带参考模板和校验脚本），Tenon 自己的工作流技能（tenon-* 等）是完整的。
- 精简版从前身仓库 2026-07-24「self-contained host-selectable pipeline」开始出现；设计文档把「每个 skill 单独安装」判为
  版本分裂、外部漂移、首装不完整而否决，要求必需技能都在同一个发布包内；没有文档说明为什么把上游内容换成精简改写。
- 62 个 skill 中 11 个是 Tenon 自有，51 个是第三方精简改写；上游来源已逐个核对（`research/current-skill-bundle.md`）：
  obra/superpowers、Fission-AI/OpenSpec、affaan-m/ECC、mattpocock/skills、anthropics/skills、vercel-labs/agent-skills、
  vercel-labs/skills、shadcn-ui/ui、alchaincyf/huashu-design、dominikmartn/hue、Nutlope/hallmark、Leonxlnx/taste-skill；
  许可证均为 MIT 或 Apache-2.0，没有禁止再分发的。
- 需要处理的例外：`zoom-out` 上游已删除；`verify`、`run` 只是 Claude Code 内置技能，没有公开来源；`uiuxdesign-pro` 找不到对应；
  `tailwind-css-patterns`、`code-review` 只有不确定的候选；上游改名 `react-best-practices` → `vercel-react-best-practices`、
  `shadcn-ui` → `shadcn`；`openspec-propose`、`openspec-apply-change` 是 Tenon 定制版，语义与上游不同；
  `code-review`、`security-review`、`run`、`verify` 与 Claude Code 内置技能同名。
- `skills/EXTERNAL-SKILLS.md` 目前写着安装「绝不下载第三方技能市场」，需要改掉。
- 标准安装工具 `npx skills`（vercel-labs/skills）：默认跟随上游默认分支最新、不锁提交；有全局与项目锁文件记录来源和哈希；
  `update` 比对哈希后重装变化的 skill；默认开启遥测。
- 技术约束：Codex 的技能读取证据只信任插件缓存 / 激活发布 / 开发目录中的 skill（`packages/cli/src/codexSkillTrust.ts:222-247`）；
  发布包组装与来源校验会对 skill 目录做哈希。

## Key Decisions

- 2026-09-15 用户要求：所有 Tenon 调用的 skill 从源端安装，安装最新版本，不是 Tenon 自己维护；安装和每次更新 Tenon 时都要更新。
  这推翻了「必需技能内容固定在发布包内」的旧设计。
- 2026-09-15 用户确认：51 个第三方精简改写没有保留必要，全部删除，工作流直接使用开源 skill（流程相同）。
- 2026-09-15 用户确认：找不到明确上游的 skill 先删除——`zoom-out`（上游已删）、`verify`、`run`、`uiuxdesign-pro`，以及只有不确定
  候选的 `tailwind-css-patterns`、`code-review`；同时去掉工作流与契约中对它们的引用。上游改名的使用上游新名
  （`vercel-react-best-practices`、`shadcn`）。
- 2026-09-15 用户确认：Tenon 自有 skill 只保留一个由工作流数据驱动的 `tenon`；7 个阶段 skill、`simple-task`、`learn-record`、
  `tenon-researcher` 删除；Tenon 定制的 `openspec-propose`、`openspec-apply-change` 换回上游版本。整合工作由子任务
  `09-15-data-driven-runner` 负责，本子任务负责第三方 skill 的上游安装与精简改写的删除。
- 2026-09-15 用户确认：由 Tenon 自己按来源清单从 GitHub 拉取最新版本，放进 Tenon 的可信技能目录供 Claude Code 与 Codex 加载，
  记录实际提交与内容哈希；不使用 `npx skills`，不写入宿主全局或项目的技能目录（`~/.claude/skills`、`~/.agents/skills` 等）。

## Requirements

- R1 来源清单：每个非 Tenon 自有的 skill 记录上游来源（仓库、目录、许可证）、Tenon 使用的逻辑 id 与上游 id 的对应关系。
- R2 安装：安装 Tenon 时由 Tenon 从 GitHub 获取每个 skill 上游默认分支的最新完整内容（含参考文件、脚本、示例），
  放到 Tenon 的可信技能目录，Claude Code 与 Codex 都从这里加载并计入技能证据；不修改宿主全局或项目的技能目录，
  不影响 Tenon 之外的会话。
- R3 更新：每次更新 Tenon 时重新获取所有上游 skill 的最新版本；记录每个 skill 实际安装的版本（提交或发布版本）、内容哈希、时间。
- R4 删除精简副本：仓库中第三方 skill 的精简改写全部移除；Tenon 自有 skill（tenon、tenon-*、simple-task、learn-record 等）保留。
- R5 许可证：安装前检查上游许可证；不允许再分发或许可证缺失的 skill 不安装并在 doctor 中报告。
- R6 失败处理：某个上游不可达或内容无效时，明确报告哪个 skill 失败；已安装的旧版本保持可用，不留下半装状态。
- R7 可见：`tenon doctor` 与 Dashboard 显示每个 skill 的来源、版本、许可证、安装时间、是否为最新。
- R8 工作流兼容：default 工作流与技能门、文档产出者契约引用的 skill id 在改为上游 skill 后继续可用；上游 skill 改名或删除时报告。

## Acceptance Criteria

- [ ] 官方安装 Tenon 后，`hue` 等第三方 skill 与上游最新版本内容一致（含参考文件与脚本），不再是精简版。
- [ ] 上游仓库有新提交后再更新 Tenon，对应 skill 更新到新提交，安装记录中的版本与哈希随之变化。
- [ ] 在 Claude Code 与 Codex 中跑一个真实 default 任务：上游安装的 skill 被加载并计入技能证据，门禁行为正常。
- [ ] 模拟一个上游不可达：安装 / 更新报告该 skill 失败，其他 skill 与旧版本不受影响。
- [ ] 仓库中不再存在第三方 skill 的精简改写；`tenon doctor` 显示每个 skill 的来源、版本、许可证。

## Out of Scope

- Tenon 自有工作流技能的来源方式（继续随仓库维护）。

- 2026-09-15 按推荐确定（用户授权后续按推荐执行）：更新时不要求用户确认；只从来源清单中列出的仓库获取；每次记录提交与内容哈希；
  doctor 与 Dashboard 显示自上次更新以来变化的 skill（含上游提交链接）；获取失败保留旧版本。
