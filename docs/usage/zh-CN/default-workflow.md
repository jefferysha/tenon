# Default 七阶段工作流

Default workflow 是 Tenon 的完整治理路径。每个阶段都有明确输入、产出、允许的回边和出口条件。

Tenon 自有的 skill 只有一个 `tenon`：它读任务冻结的工作流计划，按
`tenon status <change> --json` 的 `step.next` 执行当前步骤。每一步加载哪些技能全部写在
`templates/workflows/default.yaml` 里，按轨道分支；manifest 的 `mandatory_skills` 只是同一份
数据的路由投影，启用 Track matrix 时作为自动 overlay。

每步声明的技能（default，按轨道）：

| Step | pm | frontend | backend | free |
| --- | --- | --- | --- | --- |
| `open` | openspec-propose | openspec-propose | openspec-propose | openspec-propose |
| `explore` | brainstorming · grilling · domain-modeling | openspec-explore · brainstorming · grilling · domain-modeling | openspec-explore · brainstorming · grilling · domain-modeling · codebase-design | brainstorming |
| `spec` | openspec-propose · brainstorming · writing-plans · grilling · domain-modeling | openspec-propose · writing-plans | openspec-propose · writing-plans | openspec-propose · writing-plans |
| `build` | prototype · frontend-design | test-driven-development · frontend-design | test-driven-development | test-driven-development |
| `verify` | browser-qa · web-design-guidelines · design-taste-frontend · verification-before-completion | verification-before-completion · e2e-testing · browser-qa · web-design-guidelines · design-taste-frontend | verification-before-completion | verification-before-completion |
| `ship` | — | finishing-a-development-branch | finishing-a-development-branch | finishing-a-development-branch |
| `archive` | — | — | — | — |

`chat` 轨（Dashboard 不选轨道时的缺省）不声明任何技能：它的文档契约照常治理产出，但不要求
上游技能字节，这样没有轨道的 default 解析在干净 checkout 上也成立。

## Open

创建独立 Change，写 proposal、initial design 和 tasks。这里不提前实现代码，也不把未来任务伪装成已确认计划。

## Explore

读取 Open 当前 digest，进行外部研究、现有能力检查、方案比较、技术设计和 ADR。出口必须具备 design artifact、文档登记和 review receipt。

## Spec

把设计转成 OpenSpec delta requirement/scenario 和可执行计划。计划必须列文件、行为、测试、回滚和上下文切分；前端/后端 full 任务先设计纵向 tracer bullet。

## Build

真实实现遵循项目规则和测试先行。每完成一个任务立即运行窄测试，再扩大验证范围。Build 完成后冻结
`build:v1:<git|workspace>:<revision_hash>:<repository_hash>:<worktree_hash>` token；它同时绑定 revision、
物理 repository 和 worktree。旧裸 Git SHA/裸 workspace baseline 不会自动回填，必须回 Build 重新捕获。
缺失、非法、陈旧或无法证明来源时，Verify、readiness、HTTP/SSE 与 AFK 统一返回
`verify-build-revision-untrusted`，修复标识为 `return-to-build-and-capture-current-revision`。不要手动 `set build_sha`。

`pre_verify_review_result=pass` 是 Build 的通过结论，`tenon set` 写入前核对本步声明的就绪证据。
每条轨道的 Build 都声明了可核对的证据：frontend 是必需测试 `typecheck` + `unit`，backend 是 `unit`，
pm / free / chat 是必需评审者 `spec-consistency`（`block_at: medium`，逐条比对实现与 proposal /
design / delta spec / tasks，语言无关）。证据不齐时写 `pass` 被拒，并点名缺的测试或评审者。

必需测试的命令是 npm 脚本（`npm test`、`npm run test:integration` 等）而项目里没有这个脚本时，这条测试是
「未配置」，不是失败：`tenon test run` 拒跑、不落记录，并给出配置方式；`step.next` 在本步或上一步
（配置是一次工作区改动，要赶在 Build 冻结候选版本之前）入口就以 `fix`（`test-unconfigured`）提出。配置方式：
在 package.json 加上运行本项目真正这类测试的脚本；项目不用 npm 时在 Dashboard 工作流页改这条测试的
command（存为全局 default 覆盖，只对之后新建的任务生效，已开始的任务按冻结计划执行）。

## Verify

独立检查测试、类型、构建、浏览器、安装和安全边界。Verify 不修改实现；失败走 `verify-fail` 返回 Build，返工后重新冻结基线。

## Ship

`tenon spec apply <change>` 把已验证的 delta spec 应用进主规格并写下 applied spec 回执，
再准备真实交付。若 Change 带主规格迁移 receipt，
必须先生成身份和摘要绑定的机器应用结果；`tenon check` 与 `ship-complete` 的运行时 typed guard
都会复核它。代码合并、push、Pages 上线等外部动作必须以实际成功为准。

## Archive

重读 proposal、design、ADR、spec、plan、verification report 和 applied spec，确认任务清零后归档。Archive 之后自动更新不得改写历史字节。

## 两条回边

- `requirements-changed`：Build → Spec，用于需求或设计语义改变；
- `verify-fail`：Verify → Build，用于实现或验收失败。

## Review 边界

Explore、Spec、Verify 的 review 必须绑定 exact phase 和 exact event。同一份确认不能同时授权 `verify-pass` 与 `verify-fail`。持续授权只改变确认记录方式，不改变 guard。

Verify 对冻结的 `build_sha` 只开启一个自动 Review attempt。代码/标准、规格、安全、E2E、
浏览器与视觉验收是同一 attempt 的不同 lane，共用次数上限；E2E 不单独再算一次 Review。
任何 Review Skill、reviewer agent 或 E2E runner 都必须在 attempt 已激活后才能派发。
Build 中的 TDD、单元测试、类型检查、lint 和窄集成测试属于实现反馈，不消耗 Review 次数。

如果 Verify 报告构建修订不可信，沿 `verify-fail → build` 回边重新实现并运行
`build-complete`；新的 canonical transition record 会提供 token 的来源证明。

## 阶段产物总览

| Phase | 关键产物 | 主要出口条件 |
| --- | --- | --- |
| open | proposal、initial design、tasks | 身份与范围明确 |
| explore | 技术设计、研究、ADR | 取舍完成并 review |
| spec | delta spec、实施计划 | 需求可验证并 review |
| build | 实现、测试、冻结基线 | 当前任务完成 |
| verify | 独立验证报告 | exact-event review |
| ship | applied spec、交付准备 | 已验证规格已应用 |
| archive | 不可变历史 | 全部证据可读取 |

Open 创建状态、默认 OpenSpec 骨架和文档账本。模板只是待填写结构，不代表对应 Skill 已执行。

Explore 的研究结论必须回到产品事实、仓库实现或一手资料。方案比较要写清选择、拒绝项、风险和验证方法。

Spec 使用稳定英文 OpenSpec 操作词，但 requirement、scenario 和说明正文默认中文。设计语义变化必须回到 Spec 修订并重新 review。

Build 可以修改实现和测试，但不能在 Verify 中边验边改。受治理文档改变后要重新登记 digest。

Verify 至少回答：运行了什么、结果是什么、基线是哪一版、失败如何复现。前端交付必须使用真实浏览器。

Ship 不重新解释需求，也不引入新实现。应用 delta 时发现主 spec 冲突，应返回受控修订路径。

Archive 保留最终状态与证据链。插件自动更新不能批量翻译或格式化历史归档。

## Review 顺序

```text
check → review request --event <event> → acknowledge → transition
```

持续授权允许 CLI 写入 delegated acknowledgement，但前提仍是产物、Skill 证据、文档读取和 guard 全部真实通过。

回边不是删除失败记录。旧报告、receipt 和 transition history 应保留，新一轮基线和结果追加到同一个 Change 的历史。

## Todo 与阶段所有权

`tasks.md` 是唯一 Todo 真相源。一级标题对应七个 phase，未来阶段任务可以展示，但不会反向阻塞当前出口。每个 phase 只能勾选自己的任务并重新登记文档。

## 查看当前事实

```bash
tenon status <change> --json
tenon document status <change>
tenon check <change>
```

三条命令分别回答状态、文档证据和出口 guard；任何一条通过都不等于自动推进。
