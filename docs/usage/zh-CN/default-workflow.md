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
每条轨道的 Build 都声明了可核对的证据：frontend、backend、chat、free 要求项目测试目录里的 `unit` 套件通过（Build 的
`test_policy`），pm / free / chat 另有必需评审者 `spec-consistency`（`block_at: medium`，逐条比对实现与 proposal /
design / delta spec / tasks，语言无关）。证据不齐时写 `pass` 被拒，并点名缺的测试或评审者。

每条轨道都挂了[智能体](./agents.md)：调研步骤的执行者是 `researcher`；实现步骤的执行者是 `builder`
（按独立任务各起一个子代理，合成一份报告），先于该步的评审者运行；验证步骤声明 `code-size` 测试
（`tenon test code-size --json`，新增行数不超过 2000 为通过）并挂必需评审者 `code-size` 读取它的结果。
新增行数确实超限且用户决定豁免时，用 `tenon test waive <change> --test code-size --reason …` 登记；评审确认这道门时一并批准，
批准前不放行。
对话与自由轨道的验证再加参考评审者 `security`，它的问题不拦截。执行者没有 `done` 之前不能离开步骤。

评审者按风险挂载。`security` 声明了 `attach_on: [auth, dependency, contract]`（见[智能体](./agents.md)），所以在验证要求它的轨道上，
只有任务的改动碰到鉴权、依赖清单或接口契约路径时才挂上；一个都没碰到的任务不会等它、也不会派发它。同一个任务也可以先走更轻的
[`standard` 通道](./routing-and-workflows.md#标准通道)，改动长大了再升级到本工作流。

步骤自己的必需测试（`tests`）命令是 npm 脚本而项目里没有这个脚本时，这条测试是「未配置」，不是失败：`tenon test run`
拒跑、不落记录，并给出配置方式；`step.next` 在本步或上一步（配置是一次工作区改动，要赶在 Build 冻结候选版本之前）入口
就以 `fix`（`test-unconfigured`）提出。默认工作流里仍是必需的步骤测试只有 `code-size`（每条轨道的验证）和设计体系校验
（pm 的交付）；项目自己的测试来自测试目录，所以一个普通项目不会为了满足工作流去补 `typecheck` 或 `test:integration` 脚本。

步骤还可以声明 `test_policy`，它是测试体系在工作流这一侧的部分（项目的 `.tenon/tests/catalog.yaml` 说明测试怎么跑，
任务的 `test-plan.yaml` 说明本任务动了哪些套件和测试文件，策略说明每一步必须看到什么）。`kinds` 必须登记进计划
（该种类的套件或已批准的豁免），`run` 必须在当前代码上跑过并通过，`run_if_registered` 只在计划登记了该种类时才要求，
`scope` 是最小运行范围（`changed` 认任何范围，`full` 只认全量运行），`files: registered` 在本任务新增或修改的测试文件
没有登记进计划时阻塞，`scenarios`（`required` / `passing`）要求每个 OpenSpec 场景都映射到测试用例，`coverage`、`flaky`、
`browsers` 追加门槛。没有 `test_policy` 的步骤行为与之前完全一致，已开始的任务按冻结计划执行，步骤自己的 `tests` 与策略并存可用。

`integrity: notice | block`（缺省 `notice`）决定测试完整性报告在这一步的去向。报告把任务和它的起点对比，指出全量运行的用例数下降与跳过数上升、
被删或被跳过的测试、被删的断言、被改写的快照、被改的基线、新增的已知失败和降低的覆盖率门槛（十种信号见
[CLI 参考](cli-reference.md)的「测试完整性」，命令是 `tenon test integrity <change>`）。默认工作流与标准车道什么都没声明，所以
每个实现与验证步骤都是 `notice`：信号在 `status`、`test status` 和 Dashboard 测试页签里汇成一条 `test-integrity` 提示，从不阻塞。
在某个步骤上写 `integrity: block`，就让这些信号成为该步骤的阻塞（读不出 diff 时也阻塞，`files-diff-unavailable`）；没有逐条豁免，
有意删除就还原测试或改策略。`integrity: notice` 与不写这个键完全一样，不改变工作流指纹。Dashboard 工作流页在 `scenarios` 旁边编辑它。

零豁免默认值：**只强制 `unit`**（规格步登记，实现步按 `changed` 运行，验证步按 `full` 运行）。其余种类项目里有才跑：
`typecheck`、`integration`、`regression`、`e2e`、`playwright`、`a11y`、`visual`、`benchmark`、`smoke` 都是
`run_if_registered`，种子（`tenon test plan <change> --seed`、`tenon test register <change> --auto`）会把目录里这些种类的
套件（基准除外）登记进计划。覆盖率门槛（frontend / backend 验证，lines 80%）只对目录里声明了 `coverage` 的套件生效，
目录没声明覆盖率就不会被它挡；Playwright 要哪些浏览器由套件自己的 `browsers` 决定。`regression` 不需要单独的套件：
策略要求 `regression` 且 `scope: full` 时，全量运行的 `unit` 套件即满足。各轨道默认值（都可在 Dashboard 工作流页修改）：

| 轨道 | spec 登记 | build 运行（changed） | verify 运行（full） |
| --- | --- | --- | --- |
| chat / free | `unit` | `unit`；已登记则加 `typecheck` | `unit`；已登记则加 `regression` |
| frontend | `unit` | `unit`；已登记则加 `typecheck` | `unit`；已登记则加 `regression`、`e2e`、`playwright`、`a11y`、`visual`；套件声明了覆盖率时 lines 80% |
| backend | `unit` | `unit`；已登记则加 `typecheck` | `unit`；已登记则加 `integration`、`regression`、`benchmark`；套件声明了覆盖率时 lines 80% |
| pm | 每个 OpenSpec 场景都有映射 | 无 | 已登记则跑 `smoke` |

某个种类对整个项目都不适用（纯 JavaScript 项目没有类型检查）时，在目录里声明一次，不必每个任务各豁免一次：
`tenon test catalog not-applicable typecheck --reason '<原因>'` 会在 `.tenon/tests/catalog.yaml` 写入一条 `not_applicable`。
它要经一次人工确认才生效：`tenon review request` 把它和计划里的豁免一起列出（键 `not-applicable:<kind>`），用户的确认
（`tenon review acknowledge`，不含 `--delegated`）批准它，`approved_by` 记录批准人；在此之前策略仍要求这个种类，
报 `waiver-unapproved`。只有单个任务不适用时仍用 `tenon test waive`。

项目还没有测试目录时，`tenon init`（声明了 `test_policy` 的工作流）会自己跑 `tenon test discover --write` 并在 stderr 说明；
请审阅生成的 `.tenon/tests/catalog.yaml` 后提交。discover 认领 `src/`、`test/`、`tests/`、`__tests__/` 和项目根目录下的单测文件
（`*.test.*`、`*.spec.*`）。`tenon test register <change> --auto` 一条命令做完剩下的：缺目录先识别，把没有套件认领的测试文件
并进套件的 `files` glob，生成计划初稿并登记这些文件。

`tenon status` 的 `step.next` 按固定顺序推进测试体系：`test-discover`（无目录）→ `test-plan-seed` → `test-plan-map`
（缺的种类、未映射的场景）→ `test-register-files`（未登记的测试文件）→ `run-tests`（`tenon test run <change> --stage`）
→ `test-report`（把追溯矩阵写进验证报告）。它们排在本步文档之后、评审者之前；已经运行过却不满足策略的阻塞变成
`fix`，评审门上有回退边则走回退边。豁免与目录里的 `not_applicable` 要人工批准：`tenon review request` 列出待批准的项，用户的确认
（`tenon review acknowledge`，不含 `--delegated`）恰好批准这些。测试计划、基线、已知失败清单和运行记录只经
`tenon test …` 写入，写门拒绝直接编辑和 shell 重定向，`tenon` 命令与普通 git 操作放行。声明 `reads_tests` 的
评审者，提示词还附带最新的失败用例、flaky 用例、覆盖率对照门槛与基准变化。

阻塞带稳定的码（`test-catalog-missing`、`test-plan-missing`、`test-kind-missing`、`test-file-unregistered`、`test-not-run`、
`test-failed`、`test-stale`、`no-tests-ran`、`coverage-below`、`scenario-uncovered` 等）、短标签、完整原因和修复命令。

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
- `verify-fail`：Verify → Build，用于实现或验收失败（验证轮次用完后这条边被拒，见[验证轮次上限](#验证轮次上限)）。

## Review 边界

Explore、Spec、Verify 的 review 必须绑定 exact phase 和 exact event。同一份确认不能同时授权 `verify-pass` 与 `verify-fail`。持续授权只改变确认记录方式，不改变 guard。

Verify 的轮次有上限，见下面的[验证轮次上限](#验证轮次上限)。Build 中的 TDD、单元测试、类型检查、lint 和窄集成测试属于实现反馈，不算一轮。

如果 Verify 报告构建修订不可信，沿 `verify-fail → build` 回边重新实现并运行
`build-complete`；新的 canonical transition record 会提供 token 的来源证明。

## 验证轮次上限

Verify 最多验证 2 轮。`templates/workflows/default.yaml` 里每条轨道的验证步都声明了 `max_rounds: 2`。一轮 = 进入验证步一次：第一次进入是第 1 轮，每次 `verify-fail` 回到 Build、再经 `build-complete` 进入验证，就多一轮。

第 2 轮仍有必需测试或必需评审者不通过时，Tenon 不再自动回退。`step.next` 不再给 `verify-fail` 这条边：它要么 `stop`（`rounds-exhausted`），要么请用户接受剩余阻断；`tenon transition <change> verify-fail` 也会被拒。之后由用户决定：

- 用人工确认接受剩余的评审者阻断（失败的必需测试要改走步骤测试豁免）；
- 用 `tenon set <change> max_rounds <N>` 调高上限，再回到 Build；
- 经 `requirements-changed` 回到规格。这条边声明在 Build 上而不是 Verify 上，所以从 Verify 出发要分两步，第一步同样要用户先决定：用 `tenon set <change> max_rounds <N>` 调高上限，经 `verify-fail` 回到 Build，再在 Build 上执行 `tenon transition <change> requirements-changed`。任务落到规格之后，计数从第 1 轮重新开始，用户可以再把 `max_rounds` 调回去；
- 终止任务。

agent 不会自行调高上限，也不会绕过它。命令、`step.rounds` 和剩余阻断的接受见 [CLI 参考](./cli-reference.md#验证轮次上限)。

上限是工作流步骤的 `max_rounds` 键，写在 `gate` 旁边：

```yaml
- id: verify
  gate: review
  max_rounds: 2
```

这个键只能声明在设了 `gate: review`、且至少有一条回退边（回到更早步骤的边，如 `verify-fail`）的步骤上。声明在别处会让工作流解析失败，错误点名步骤和原因（Build 没有评审门，不受上限约束，它的 `requirements-changed` 始终可用）。取值是 1 到 20 的整数，`0`、`21`、`two`、`1.5` 同样被拒。受限步骤没有声明这个键时（自定义工作流的步骤，或这个键出现之前就已冻结的任务），按 2 处理。上限随工作流计划冻结，之后再改工作流文件不影响在途任务；`tenon set <change> max_rounds <N>` 只覆盖单个任务。Dashboard 工作流页读写定义时会保留这个键，但没有编辑控件。

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
check → review request --event <event> → 用户确认 → transition
```

确认只来自用户：回复放行语（“确认继续”“继续执行”等），由 hook 写入回执；在 Dashboard 确认（`tenon dashboard --open`）；
或在没有 UserPromptSubmit hook 的宿主上，由用户本人在自己的终端运行 `tenon review acknowledge <change>`。agent 不得代为执行
这种手动形式，宿主 gate 会拒绝。

持续授权允许 CLI 写入 delegated acknowledgement（`--delegated`），但前提仍是产物、Skill 证据、文档读取和 guard 全部真实通过，
且它不批准待批准的测试豁免。

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
