# backend-quality 评审报告：fix-hook-cross-session-isolation（含补审）

## 覆盖摘要

本轮已读源码和 diff，没有运行测试，也没有改动任何文件。第一轮读过的文件加上补审，共约 60 个文件（含新增）。

- **A 部分（会话隔离）**
  - `hooks/active-change.sh`、`pending-marker.sh`、`review-ack.sh`、`gate.sh`
  - `confirm-clear.sh`、`confirm-clear-prompt.sh`
  - `interactive-skill-gate.sh`、`skill-tracker.sh`、`skill-start.sh`、`codex-skill-receipt.sh`
  - `decision-recorder.sh`、`test-nudge.sh`
  - `prompt-intent.sh`（放行语整条匹配）
  - `session-start.sh`、`auto-update.sh`
  - `review-revoke.ts`、`session.ts`、`session-handover.ts`
- **B 部分（源码开发安装）**
  - `source-install.ts`、`dev-host.ts`、`update-dev-guard.ts`、`update-native.ts`、`doctor-source-drift.ts`
  - `dev-source-identity.ts`、`dev-install-marker.ts`
  - `release-store-codecs.ts`、`release-store.ts`
  - `upstream-skills/ensure.ts`
  - `hooks/source-drift.sh`
  - `tools/lib/runtime-roots.mjs`、`decoy-host-roots.mjs`
- **C 部分（步骤测试豁免）**
  - kernel 的 `plan.ts`、`evaluate-v2.ts`、`review-waivers.ts`
  - `evaluate.ts` 里的 `testItemSettled`
  - `test-register.ts`、`agent.ts`、`agent-prompt.ts`、`agentGate.ts`
  - `verdictFieldGate.ts`、`statusStep.ts`、`statusStepNext.ts`、`statusStepTests.ts`、`statusStepAgents.ts`
  - server 的 `testSystemDto*.ts`、`workflowOrchestration.ts`
  - dashboard 的 `testPolicyDecoders.ts`、`testsTabModel.ts`（只看了 WORST 和 traceRank）

未覆盖项：

- 所有 `*.test.ts` 的内容没有逐个核对，失败路径的测试覆盖未验证。
- 入库的 dist 产物不审。
- `update-native.ts` 只读了 diff，没有读完整的更新流程。
- `kernel/test-system/plan-waivers.ts` 只看了注释和摘要函数。

**补审后的变化：**
- 隔离逻辑一致性良好：放行语整条匹配的清单只有一份（`prompt-intent.sh`），对话回复和 AskUserQuestion 答案共用。
- AskUserQuestion 答案只认显式放行语。
- 标记归属判定和认领流程在 `pending-marker.sh` 里是唯一入口。
- `release.json` 的 `devSource` 做了严格 schema 校验，和 `stableTarget` 互斥。
- 没有 `devSource` 的 release id 与历史算法逐字节相同。
- hook 里的会话 id 校验统一，路径遍历和命令注入没有发现新问题。

**发现 7 的结论：** 级别改为 low，原因与第一轮不同。
- 策略路径：`kindStatus` 里 `waived`（已批准）映射为 done，`waiver-pending` 映射为 waiting，与 kernel 一致。已批准的豁免在 kernel 里是放行，所以这里不是聚合成 pass 的 bug。
- 展示缺陷：`TestItemSnapshot.status` 取的是原始 `item.status`，`waiver` 字段没传出去。`testEvidenceSnapshot.ts:78` 和 `workflowOrchestration.ts:testStatus` 因此把已批准豁免的内联步骤测试仍当作 `failed`。门禁已放行，画布上却是红的。
- `testsTabModel.ts` 的 `traceRank` 已区分已批准和未批准的豁免，没有问题。

## 发现清单

1. **medium**，`packages/cli/src/commands/session.ts:134`（`writeTerminalSessionBinding`）
   - 问题：先删其他会话的绑定，再写本会话的绑定。写失败时两边都没有绑定。两个会话并发 `activate` 时可能各自删掉对方的绑定，最终同时绑定同一个 Change，违背一对一。
   - 修法：先写本会话绑定，成功后再删其他会话的绑定，整个过程放在 Change 锁内。

2. **medium**，`hooks/pending-marker.sh:15`
   - 问题：交互标记是单文件，后写者整份替换先写者（设计里已承认）。被替换会话的交互门静默失效。
   - 修法：按会话分文件，例如 `.pipeline-pending-interaction.<session>`，或者在 spec 里明确写出这个残余风险。

3. **medium**，`hooks/source-drift.sh:119`、`hooks/source-drift.sh:130`、`hooks/source-drift.sh:134`
   - 问题：git 顶层路径 `$top` 没有转义就拼进提示命令，并写入会话上下文。路径含空格时命令不可复制执行，含换行等控制字符时还能改写提示文本。TypeScript 端 `resolveSourceRepo` 已拒绝控制字符，shell 端没有。
   - 修法：用 `printf %q` 给路径加引号，或者路径含控制字符时不输出提示。

4. **low**，`hooks/source-drift.sh:55`、`hooks/source-drift.sh:59`
   - 问题：文件名含换行时，shell 端按行读路径，摘要会错位。TypeScript 端 `computeWorktreeDigest` 遇到这种路径会直接抛错。两边行为不一致，shell 端表现为误报漂移。
   - 修法：shell 端遇到含换行的路径就跳过并停止提示，行为和 TypeScript 端对齐。

5. **low**，`hooks/gate.sh:404`
   - 问题：`review_marker_relevant_to_active_change` 把未经校验的 `json_get session_id` 传给下游。下游会再校验，行为正确，但和交互分支的 `pipeline_hook_session_id` 口径不统一。
   - 修法：这里也改用 `pipeline_hook_session_id "$INPUT"`。

6. **low**，`hooks/active-change.sh:90`
   - 问题：绑定文件超过 1024 个后，所有 Change 都被保守判为「已被别的会话绑定」。本会话会静默变成「没有任务」，不拦截也不记证据，没有任何提示。绑定目录只增不删。
   - 修法：在 `session activate` 或 doctor 里给出绑定目录过大的警告，并清理过期绑定。

7. **low**，`packages/server/src/testEvidenceSnapshot.ts:78`、`packages/server/src/typesTestSnapshot.ts:7`、`packages/server/src/workflowOrchestration.ts:97`
   - 问题：`TestItemSnapshot.status` 没带 `waiver` 字段。已批准或待批准豁免的内联步骤测试，在 Dashboard 测试页签和编排画布上仍显示 failed，而 CLI 和门禁已按 settled 处理。
   - 修法：在快照里增加 `waiver?: 'waived' | 'waiver-pending'`，让 `testStatus` 把 `waived` 映射为 done，`waiver-pending` 映射为 waiting；同步更新 dashboard 解码器。

8. **low**，`packages/cli/src/runtime/dev-install-marker.ts:90`
   - 问题：`writeInstallChannelMarker` 的临时文件是 `install-channel.tmp-<pid>`，`renameSync` 失败时没有清理，会留下孤儿文件。
   - 修法：用 try/finally，失败时 `rmSync` 临时文件。

9. **low**，`packages/cli/src/commands/update-dev-guard.ts:31`
   - 问题：runtime 读取失败且没有标记时按稳定版继续更新（fail-open）。注释里已说明是有意设计，但此时一次后台 update 仍可能覆盖开发安装，而标记丢失正是这种场景的前提。
   - 修法：可选，runtime 读取失败又找不到标记时只警告不更新，或者在文档里明确这个权衡。

10. **low**，`packages/cli/src/commands/source-install.ts:137`
    - 问题：`npm run build` 的 `spawnSync` 没有超时。参数是数组，没有 shell 注入。
    - 修法：可选，加超时或取消机制。

11. **low**，`packages/cli/src/upstream-skills/ensure.ts:24`
    - 问题：`existsSync(join(repo, 'skills', id, 'SKILL.md'))` 的 `id` 来自 `sources.yaml`。我没有核实 `parseUpstreamSkillSources` 是否限制了 id 字符集，id 含 `..` 时可能越出 `skills/` 目录。风险仅限本机仓库自己的清单。
    - 修法：确认解析器限制 id 为 `[A-Za-z0-9._-]` 且不含路径分隔符，否则在这里补校验。

## 残余风险

- 发现 1 和 2 的并发问题只靠 rename 原子性和「后写者胜出」，没有跨进程锁。没有端到端的并发测试证据。
- 发现 11 里 id 字符集是否受限，我没有核实。
- `update-native.ts` 完整更新流程、`plan-waivers.ts` 的批准逻辑只读了 diff，未做全量审阅。
- 已知限制（没声明 `test_policy` 的步骤不读豁免、`diff-risk` 不读豁免、代码规模豁免）按约定不重复报。

```tenon-result
{"findings":[{"severity":"medium","location":"packages/cli/src/commands/session.ts:134","message":"先删其他会话绑定再写本会话绑定：写失败则两边都无绑定，并发 activate 会双双绑定同一 Change；应先写后删并在 Change 锁内完成"},{"severity":"medium","location":"hooks/pending-marker.sh:15","message":"交互标记单文件后写者整份替换，被替换会话的交互门静默失效；应按会话分文件或在 spec 明示风险"},{"severity":"medium","location":"hooks/source-drift.sh:119","message":"git 顶层路径未转义就拼进提示命令并写入会话上下文，含空格或控制字符时命令不可用且可改写提示；应 printf %q 或遇控制字符不输出（TS 端已拒绝控制字符，shell 端没有）"},{"severity":"low","location":"hooks/source-drift.sh:55","message":"文件名含换行时 shell 摘要错位而 TS 端 computeWorktreeDigest 直接抛错，两边行为不一致；shell 端应跳过并停止提示"},{"severity":"low","location":"hooks/gate.sh:404","message":"review 分支直接用未校验的 json_get session_id，与交互分支的 pipeline_hook_session_id 口径不统一；统一用后者"},{"severity":"low","location":"hooks/active-change.sh:90","message":"绑定文件超过 1024 个时本会话被静默判为无任务（不拦截、不记证据）且无提示；应在 activate 或 doctor 里警告并清理过期绑定"},{"severity":"low","location":"packages/server/src/testEvidenceSnapshot.ts:78","message":"TestItemSnapshot 不带 waiver 字段，已批准或待批准豁免的内联步骤测试在 Dashboard 与编排画布 testStatus 里仍显示 failed，而 CLI 与门禁按 settled 放行；快照加 waiver 并在 testStatus 映射 waived=done、waiver-pending=waiting"},{"severity":"low","location":"packages/cli/src/runtime/dev-install-marker.ts:90","message":"writeInstallChannelMarker 的 rename 失败时临时文件 install-channel.tmp-<pid> 不清理；用 try/finally 清掉"},{"severity":"low","location":"packages/cli/src/commands/update-dev-guard.ts:31","message":"runtime 读取失败且无标记时按稳定版继续更新（fail-open，注释已说明有意设计），后台 update 仍可能覆盖开发安装；可选改为只警告或在文档写明权衡"},{"severity":"low","location":"packages/cli/src/commands/source-install.ts:137","message":"npm run build 的 spawnSync 无超时；可选加超时或取消机制"},{"severity":"low","location":"packages/cli/src/upstream-skills/ensure.ts:24","message":"sources.yaml 的技能 id 直接拼进 join(repo,'skills',id,'SKILL.md')，未核实 parseUpstreamSkillSources 是否限制字符集；确认限制为安全字符集或在此补校验"}]}
```
