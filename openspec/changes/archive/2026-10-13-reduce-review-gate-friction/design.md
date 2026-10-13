# 设计

> 详细设计见 `docs/superpowers/specs/reduce-review-gate-friction-design.md`，决策见 `docs/adr/reduce-review-gate-friction.md`。本文件只保留经调研验证后的要点。

## 决定（调研后）

- **豁免点在内核转换用例。** `transition-application.ts` 在同一把 Change 锁内判定回执；把现有轮次门扩展为三态（不适用 / 轮次内 / 已用完），轮次内的回退边不要求 approved review receipt。CLI（`commands/transition.ts:178`）与 Dashboard（`server/transition.ts:240`）都接了 `roundsOf`，单点生效；`roundsOf` 缺席时照旧要求回执。
- **不新增回退边就绪检查。** 调研证实新执行模型的任务在请求侧与转换侧本来都没有「验证报告已写出」检查（`checkVerifyFailReadiness` 只对旧模型在途任务生效，`review.ts:155`）；回退不越过任何质量门，代价由 `max_rounds` 封顶。
- **成功转换后清掉本任务的评审标记。** 调研证实 `tenon transition` 不删 `.pipeline-pending-review`，升级前遗留的请求会让标记残留且放行语解不开；内核转换用例提交后直接调用 `clearReviewMarkerOfChange`，失败只记 `review-marker` 告警。
- **`next` 对唯一回退边在轮次内直接给 `transition`**；多条回退边仍 `choose-exit`；轮次用完后的分支不变。
- **gate 只读判定独立成 `hooks/lib/read-only-command.sh`**：引号感知切段（`|` `||` `&&` `;`）、`cd` 段放行、剥离 `/dev/null` 与 `2>&1`、2048 字符上限；收紧 `git … --output`、`rg --pre`、`sed -n` 非行号打印、`file -C`。评审标记下的自审批拦截挪到只读放行之前。
- **评审待确认期间 gate 放行恰好 `tenon transition <change> <event>`**，由 CLI 判定（无回执的前进边、用完后的回退边仍被拒），让「前进评审待确认时用户要求回退」能直接执行。
- **拦截提示按标记种类分开。** 评审提示列放行语与 Dashboard 确认，不提 AskUserQuestion。
- **design-system 的 `review-changes` 同样适用；Dashboard「退回到…」不改；轮次内 `review request --event <回退>` 仍允许。**

## 风险

- 豁免方向写错会让前进边绕过人工确认：内核测试覆盖「前进边仍需回执」「用完后回退仍拒」「`roundsOf` 缺席仍需回执」「放弃边不变」。
- 只读切分偏差可能把写入放成只读：成组反例测试，保持「宁可误拦」；超长命令 3 秒内拦截。
- 规则与文档多处描述「回退边也需确认」，漏改会让 agent 继续请求不必要的评审：规格步按调研报告 §1b 清单逐处改，含生成物（`npm run generate:identity`）与 dist 重打包。
- 主检出上另一任务（setup-host-agents-step-progress）未提交改动触及 hooks 与 CLI，合入时可能冲突。

## 待验证问题

- gate 只读判定与拦截提示归属的主 spec capability（规格步确定，没有就新建）。
