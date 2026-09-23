---
name: tenon
description: "按任务冻结的工作流逐步执行：路由、恢复、每步照 `tenon status --json` 的下一步做。"
---

# /tenon — 工作流执行入口

每一步做什么全部来自工作流数据。本文件只讲怎么读那份数据、怎么照做；default 与自定义工作流
一视同仁，这里不出现任何轨道名或阶段名。

## 何时用

- `<tenon-dispatch> action: invoke-skill skill: tenon` 或用户输入 `/tenon` 时进入。
- 纯聊天不创建任务，直接回答。

## Codex 的技能读取（硬规则）

- 插件技能一律按 `tenon:<id>` 加载，让宿主读插件 cache 里的 `skills/<id>/SKILL.md`；
  同名的 `~/.agents`、`~/.claude`、项目副本一概不读（已激活任务时 hook 会拒绝）。
  技能不可用就跑 `tenon setup --codex` 或 `tenon update --codex`，不用同名外部技能代替。
- 每个技能一次完整读取，并把内部结果整体转发给宿主，使 `exit_code` 可审计：

```javascript
const result = await tools.exec_command({ cmd: "<读取 SKILL.md 的命令>", workdir: "<绝对项目目录>" });
text(result);
```

  等价的 `text(await tools.exec_command({ ... }));` 也接受。不要用 `text(result.output)`：
  它丢内部退出码。`max_output_tokens` 要装得下全文；被截断的读取不算证据，之后
  `tenon document record` 会报 `lacks exact host confirmation`。

## 模式（取 `step.mode`）

| 模式 | 来源 | 规则 |
| --- | --- | --- |
| `interactive` | 缺省 | 有 `allowed` 的字段用 AskUserQuestion 问（Codex：一个纯文本问题后结束回合）。每次 `transition` / `complete` 前展示产出、测试结果与评审发现，等用户说「继续」。评审门：`request-review` 后展示并结束回合，放行语是「确认继续」。 |
| `continuous` | 本任务已有交互授权（`tenon session activate --continuous`） | 有 `recommended` 的选择不停；评审门在 `request-review` 后用 `tenon review acknowledge <c> --delegated`。必需测试或评审者不通过时走回退边修问题，绝不「接受偏差」。 |
| `afk` | `TENON_AFK=1` | 同 continuous；`await-review` 直接以当前步骤状态结束本轮。 |

三种模式都一样：技能、文档、测试、评审者、门禁、读取回执，一项都不跳过；推送、PR、部署等
外部动作需要本次任务里已有明确授权；交互式技能自己跑它的对话。

## 进入

1. `command -v tenon`，没有就停下并给出重装提示。
2. dispatch `intent: new` → 起一个 kebab-case 名；`intent: select` 或 `selection_required: true`
   → 要用户给出**一对**确切的候选（名字 + 工作流），然后结束回合；`intent: resume` → 只接手
   点名的那个任务。没有 dispatch 的手动 `/tenon`：`tenon list --json`，多于一个就问。
3. 新建：`tenon init <c> --workflow <w> --track <t> --preset full`（用户可以点别的 preset）；
   随后 `tenon session activate <c> --host-session <host_session_id> [--continuous]`。恢复只跑同一条
   activate。`<host_session_id>` 取 dispatch 里的 `host_session_id`；dispatch 带了它就必须传，
   否则下一轮的「确认继续」认不出本会话的任务，会被当成新任务。dispatch 没有它时才省略该参数。
4. 用 `tenon workflow plan <c> --json` 的步骤标签建 Todo，当前项取 `current_step`。
5. 进入循环。

## 循环

```
repeat:
  S = tenon status <c> --json | .step
  S.next[0].action == stop → 报告 message，结束
  把 S.next 里与 next[0] 同 action 的项一起做完（一波），按下面的动作表
  做完 transition / complete → 重新加载 tenon（新的步骤访问），按模式继续或暂停
```

## 动作表（闭集，与 `step.next` 一一对应）

| `action` | 做什么 |
| --- | --- |
| `stop` | 报告 `message` 后结束。 |
| `load-tenon` | 重新加载本技能（Claude 用 Skill 工具；Codex 按上面的读取规则整读一次）。 |
| `read-documents` | 逐个读完 `documents` 列出的文件，再 `tenon document read <c> all`。 |
| `run-agent` | 逐项：`tenon agent prompt <c> <agent> --json` → 在宿主里跑回来的提示词（Claude 用 Agent 工具；Codex 用子任务或 `codex exec`；没有子代理的宿主就在主线顺序跑）→ 把报告写到返回的 `report_path`（正文末尾一个 `tenon-result` 代码块）→ `tenon agent record <c> <run_id>`。同一波并行。带 `status: running` 与 `run_id` 的项是已经开始的那次运行：不要重新 prompt，等它跑完把报告写到给出的 `report_path`，再 `tenon agent record <c> <run_id>`。 |
| `load-skill` | 加载本波每个技能，按下面的「上游技能怎么用」执行。 |
| `scaffold-document` | 文件不存在时先 `tenon document scaffold <c> <kind> [--capability <cap>]`，再动笔写内容：骨架里的 `[待填写…]` / `[pending…]` 占位要全部替换成真内容，留着占位符登记会被拒。 |
| `record-document` | `tenon document record <c> <kind> <path> --producer <producer>`。 |
| `register-field` | `tenon artifact register <c> <field> <path> --producer <producer>`。 |
| `set-field` | 先按下面的「决定」定值，再 `tenon set <c> <field> <value>`。 |
| `validate-spec` | `tenon spec apply <c> --dry-run`；退出码 2 就按报错改 delta spec 再跑。 |
| `apply-spec` | `tenon spec apply <c>`。 |
| `run-test` | `tenon test run <c> <test>`；`fail` 先改代码再重跑，不改就重跑没有意义。 |
| `fix` | 逐条解决 `blockers[]`（改代码或文档），然后回到循环。`source: tasks` 的 blocker 带 `items`（截至本步仍未勾的任务原文）：把这些任务真的做完，再在 tasks.md 里勾上。 |
| `request-review` | `tenon check <c>` → `tenon review request <c> --event <event>` → 把产出与结论摆给用户。 |
| `await-review` | interactive：结束回合等人。continuous：`tenon review acknowledge <c> --delegated`。afk：结束本轮。 |
| `choose-exit` | 按下面的「出口」挑一条边。 |
| `transition` | `tenon transition <c> <event>`。 |
| `complete` | `tenon transition <c> <event>`——走完终态自边，状态机到此结束。归档由下一条 `finish-change` 单独下发，不要在这里抢跑 `openspec archive`。 |
| `finish-change` | `command` 不是 `null` 时照原样跑（`openspec archive <c> --skip-specs --yes --json`），把 change 目录搬进 `openspec/changes/archive/`。`commit` 不是 `null` 时再提交：`git add -A -- <commit.paths…>` 后 `git commit -m "<commit.message>"`，paths 原样用、不增不减（宿主不让写 `.git` 时如实告诉用户这一步留给他，不要说已提交）；`commit` 为 `null`（不是 git 仓）就不提交。 |

## 决定、字段、出口

- 带 `allowed` 的字段是一次决定：interactive 把 `recommended` 排在第一位问；continuous / afk
  直接用 `recommended`。决定在动手之前下发（build 的 `build_mode` / `isolation` 先于实现技能），
  按你接下来真的要用的方式填，之后照它执行。
- `kind: outcome` 的字段只在本步必需测试与评审者都过了之后才出现在 `next` 里；它们没有 `recommended`，填 `required` 给的值。`pre_verify_review_result` / `verify_result` 是通过结论：CLI 写入前核对本步证据，被拒就按错误里点名的测试或 agent 去补，不要换个写法绕过。
- `direct_override` 是 full 预设下 `build_mode=direct` 的风险确认，没有推荐值：interactive 问人，continuous / afk 不选 `direct`（取 `build_mode` 的推荐值即可免去这一项）。
- `pr_url`、`prd_path` 和各类文件路径只填真值，绝不编造。`pr_url` 是真实的 http(s) PR 地址；仓库没有 远端时 `next` 会推荐 `no-remote`（本地交付、没有 PR，CLI 会复核确实没有远端）。有远端却开不了 PR 就停下说明。
- 不要为了「隔离」自己建分支、worktree 或提交；宿主没给就用 `isolation=in-place`。
- 出口：`ready` 的前进边直接走；回退边只在它的含义成立时走（必需测试或评审者不通过 → 回到实现
  的那条边；已确认的需求变了 → 回到规格的那条边）；interactive 先问。走到终态的
  `scope-expanded` 表示目标超出了这个工作流：之后新建一个 `default` 任务，并
  `tenon set <new> depends_on <old>`。

## 上游技能怎么用

- 任务已经存在且已绑定：不要 `openspec new change`，也不要另选或另建 change。
- 文档写在 `step.documents` 给的 `path` 上；缺结构先 `scaffold-document`。
- `path` 为 `null` = 这一条的路径还要你拍板：按 `path_template` 里剩下的占位符定值再 scaffold
  （delta-spec 缺 `{capability}`，即 `tenon document scaffold <c> delta-spec --capability <x>`）。
- 只经 `record-document` 登记。技能自带的「归档」「同步规格」「推送」「建 PR」等收尾动作，
  只有 `step.next` 点名时才做。
- tasks 只勾当前步骤标题下的复选框；它的重新登记会出现在 `step.documents.updates` 里。

## 出错时

| 情况 | 怎么办 |
| --- | --- |
| 没有 `tenon` | 停下，给重装提示 |
| 技能加载不了 | 停下，提示 `tenon setup --<host>` / `tenon update --<host>` |
| `lacks exact host confirmation` | 按上面的读取规则重新加载产出者技能，再登记一次 |
| `stop` 且 `code: retired-skills` | 告诉用户新建任务；旧任务可以在工作台归档或删除 |
| 评审待确认、回复不是放行语 | 继续等；hook 会打印解锁提示 |
