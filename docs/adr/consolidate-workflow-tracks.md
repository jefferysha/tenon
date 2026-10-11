# 架构决策记录：工作流收敛为一个 default，轻重与领域都用轨道表达

> 说明：本文为满足本任务冻结的文档契约而写（该契约要求调研步登记一份由 brainstorming 产出的 ADR）。brainstorming 本身只产出设计文档、不产出 ADR，这条契约是错的，将在后续「文档机制重做」任务中删除。本文只列决定，细节以设计文档 `docs/superpowers/specs/consolidate-workflow-tracks-design.md` 为准，不重复其内容。

## 背景

轻重被拆成工作流（default / standard / simple）、领域被拆成轨道，「轨道」在代码里又有两套（路由登记表与工作流分支），路由写死、读不到新增工作流，不走 OpenSpec 的任务目录让 `check:openspec` 失败。详见设计文档「背景」。

## 决策

1. 内建只留 `default`（轨道：轻量、产品、前端、后端）与 `design-system`；删除 standard、simple、对话、自由。——设计文档 §1
2. 轨道只存在于工作流分支；分支新增 `spec: openspec | none` 与 `route`；删除路由登记表与 `.pipeline/tracks.yaml`。——§1
3. 轻量轨道承接 standard 的步骤、探针与评审；超限新建重型轨道任务并 `depends_on`。——§2
4. 路由只定领域，轻重由 `tenon assess` 评估后用户确认；并列或命中自定义分支时让用户选。——§3
5. 所有轨道完结都移进 `openspec/changes/archive/`；删除「隐藏」，新增 `tenon task terminate`；工作台「已结束」列出归档任务并标出任务结果。——§4
6. 在途任务靠冻结快照走完，旧入口报错并给出替代命令。——§5
7. 文档机制重做与测试设置简化拆为后续任务。——§7

## 备选方案

见设计文档「备选方案」：保留独立轻量工作流、原地换轨道、升级 OpenSpec 用 `skip_specs`、按关键词直接进轻量、保留对话与自由、「搁置」分类、布尔 `openspec`、文档机制并入本任务——均已否决。

## 后果

- 工作流 YAML 分支键扩展、路由缓存升为 `router.v6`、CLI 删除 `task archive / unarchive` 并新增 `task terminate / finish` 与 `assess`；`docs/CONTRACT.md` 与发布说明需同步。
- 产品、前端、后端三个轨道在后续任务前暂保留现有文档契约。
- 任务状态目录仍在 `openspec/changes/` 下，不用 OpenSpec 的项目也会出现该目录（已知不足）。
