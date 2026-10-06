# 智能体在终端生成并注册

## 背景
v0.1.10：官方 agent = 随包 9 个 md，同步到用户配置 builtin/ 只读；`tenon agent` 只有 next/prompt/record；页面「新建智能体」只填名称生成骨架；运行时只是提示词，宿主用通用子代理跑，tools 白名单不生效；默认工作流没挂任何执行者；列表按工具猜角色。

## 需求
- R1 定义增加 `role: executor|reviewer`（必填，缺省按旧规则推断并提示迁移）与 `version`（semver，可选）。解析器仍是闭集，新键加入闭集；旧文件照常读取。
- R2 来源三层：official（随发行包，`templates/agents/manifest.json` 记录 name/version/digest/role）/ custom（用户级）/ project（项目 `.tenon/agents/`，进 git，团队共享；同名优先级 project > custom，official 不可被覆盖，冲突列出）。
- R3 CLI：`tenon agent list [--role] [--source] [--json]`、`show <name>`、`new [<name>] --role --description --skills --tools --model --hosts [--scope user|project] [--from <official>]`（交互式补全缺项；非交互全参数可用）、`add <file> [--scope]`、`validate <file|name>`（校验 frontmatter、技能存在、工具名按宿主合法、正文非空）、`copy <from> <to>`、`rm <name>`（被工作流引用时拒绝并列出）、`export <name> --host claude|codex`。
- R4 起草技能 `tenon:agent-author`：在 Claude Code / Codex 终端里，按用户描述起草 agent 正文（结构：职责、只做与不做、方法、自检、报告格式与 tenon-result 块），然后调用 `tenon agent add` 校验注册；技能不写任何状态文件。
- R5 宿主原生文件：任务冻结 agent 时，为当前宿主生成 `.claude/agents/tenon-<name>.md`（name/description/tools/model）或 `.codex/agents/tenon-<name>.toml`；写入所有权清单，归档与卸载时清理；`tenon agent prompt` 返回 `subagent_type: tenon-<name>` 让宿主用专属子代理执行（tools 白名单真正生效）；无法生成时回退通用子代理并在记录里标明。
- R6 默认工作流挂执行者：各轨道 build 挂 builder（按 tasks 并行），explore 挂 researcher，verify 加 code-size（reads_tests）；对话/自由轨道 verify 加 security 为 advisory。
- R7 Dashboard 只展示：去掉「新建智能体」；列表按角色分组（读 role 字段），行显示来源（官方/项目/自定义）与版本；详情显示字段表、正文渲染、被哪些工作流/阶段使用、最近运行；自定义与项目级可编辑正文（保存走现有摘要校验），官方只读可「复制为自定义」；空态给出 `tenon agent new` 可复制命令。
- R8 文档：docs/usage 中英加「智能体」章节（官方来源、终端生成、宿主文件、在工作流中使用）。

## 验收
- 终端 `tenon agent new sql-review --role reviewer ...` 后 Dashboard 列表立即出现，来源为自定义。
- 在 Claude Code 里用 agent-author 起草并注册一个评审者，工作流挂上后任务运行时宿主使用 `tenon-<name>` 子代理，工具白名单生效（记录里可见）。
- 默认工作流新建任务：build 出现 builder 执行者，verify 出现 code-size 评审者。
- 归档后宿主 agent 文件被清理；卸载只删自己生成的文件。
