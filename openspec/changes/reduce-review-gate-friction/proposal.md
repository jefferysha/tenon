# 提案

## Why

评审门（`gate: review`）的人工确认本应只落在真正需要用户拍板的地方，现在却有三类摩擦让用户频繁、无意义地回复「确认继续」：

1. **轮次内的回退边也要人工确认。** 验证没过、还有轮次时，`verify-fail` 回到实现几乎是唯一合理的走法，`max_rounds` 已经封顶了代价；再要一次人工确认只是例行签字，还会把用户训练成条件反射式放行，冲淡真正关键的确认（进 ship、接受剩余阻断、批准豁免、轮次用完后的去向）。
2. **只读命令被误拦。** 评审 / 交互待处理期间，gate 只认不含任何 shell 元字符的单条只读命令；`git status --short | grep …`、`cd x && ls` 这类纯只读组合也被拦，而拦截提示又让 agent「先交用户确认」，为一次读取多跑一轮人。
3. **三种待处理标记共用一条拦截提示。** 评审标记被称作「交互标记」，并声称「AskUserQuestion 完成后解封」；对评审标记这不成立（只有明确批准的回答才写回执），agent 照做会绕圈或重复提问。

## What Changes

- **轮次内回退边免人工确认**：受轮次上限约束的评审步（评审门且有回退边），在轮次未用完时，离开它的回退边不再需要 approved review receipt；`next` 直接给出 `transition`，不再给 `request-review` / `await-review`。不新增回退边就绪检查（新执行模型本来就没有）。轮次用完后的行为不变（回退边被拒，出路摆给用户）。前进边、剩余阻断、测试豁免、`not-applicable` 声明仍只认人工确认。
- **成功转换后清掉本任务的评审标记**：避免升级前遗留的请求在转换后残留标记、放行语也解不开。
- **gate 只读判定支持组合命令**：待处理期间，由 `|`、`&&`、`||`、`;` 连接、且每一段都在只读白名单内的命令视为只读；引号感知切分；重定向（`/dev/null` 与 `2>&1` 除外）、命令替换、反引号、后台 `&`、换行一律仍判为非只读；超长命令不解析、直接判非只读。白名单本身不扩大（`cd` 段除外，它不写任何东西）。
- **按标记种类给出拦截提示**：评审标记的提示改为「展示产出，等用户回复放行语或在 Dashboard 确认」，不再提 AskUserQuestion 解封；确认 / 交互标记保留现有说法。提示里点明组合只读命令现在可用。
- 同步更新宣称「回退边也需人工确认」的规则与文档：`templates/workflow.md`、`skills/tenon/SKILL.md`、`AGENTS.md` 的 Tenon 段、`docs/usage/*` 中英文、相关主 spec。

**非目标**

- 不改委托确认（`--delegated`）在 Claude Code 中不可用的问题（待用户另行决定）。
- 不改前进边、剩余阻断、豁免与 `max_rounds` 的人工确认语义；不改轮次计数方式。
- 不扩大只读白名单的单命令集合（除 `cd`），不改受保护写入路径规则。

**可验证结果**

- 默认工作流验证失败且轮次未用完时，`tenon status --json` 的 `next` 是 `transition verify-fail`；直接 `tenon transition <c> verify-fail` 成功，不产生评审标记；升级前遗留的回退边评审请求在转换后标记被删除。
- 轮次用完后 `verify-fail` 的转换照旧被拒。
- 评审待处理时 `git status --short | grep -v x`、`cd sub && ls` 放行，`rg x . > out`、`ls; touch y`、`cat a | sh`、`echo $(id)` 拦截。
- 评审标记的拦截提示不再包含「AskUserQuestion」解封说法。

## Capabilities

### New Capabilities

无

### Modified Capabilities

- `verify-round-limit`：回退边在轮次未用完时免人工确认；`next` 给 `transition` 而非评审请求。
- `plugin-runtime`：`verify-fail` 不再要求 exact review receipt。
- 规格步确认是否还有 gate 只读判定 / 拦截提示所属的 capability 需要 delta。

## Impact

- 内核：`packages/kernel/src/workflow/transition-application.ts`（回执要求的豁免判定）、`transition-rounds-gate.ts` 附近的回退边判定；CLI 与 Dashboard 服务共用同一用例。
- CLI：`packages/cli/src/commands/statusStepExits.ts`（`next` 的回退动作）、`transition.ts`（回退边就绪检查，复用 `review.ts` 的 `checkVerifyFailReadiness`）、相关消息。
- Hook：`hooks/gate.sh`（只读组合判定、按种类的提示），`tools/test-hooks.sh` 用例。
- 文档与规则：`templates/workflow.md`、`skills/tenon/SKILL.md`、`AGENTS.md`、`docs/usage/{,zh-CN/}*`、`CONTEXT.md` 如有相关术语。
- 契约：评审回执的适用范围变窄（回退边在轮次内不再消费 / 要求回执），属于行为契约变更；已有任务里待处理的回退边评审请求在升级后应仍可正常完成（兼容）。
- 安全边界：gate 只读判定放宽到组合命令，必须保持「不能借只读名义写入」的失败关闭性质。
