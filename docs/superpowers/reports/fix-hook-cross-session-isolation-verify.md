# 验证报告

## 验证范围

change `fix-hook-cross-session-isolation`（default 工作流，后端轨道）的全部改动，按四份 delta spec（`interaction-and-skill-provenance`、`plugin-runtime`、`step-test-waiver`、`verify-round-limit`）验收。本报告是第五轮验证的版本：第四轮之后用户提出验证轮次上限并决定并入本任务（F 部分），实现后本任务上限先设为 1；第 1 轮因 oracle 夹具失败用完，用户决定调高到 2 修夹具，本轮是第 2 轮，也是最后一轮。各轮的命令与结果按轮次记录在各节末尾。

- **A 部分**：
  - hook 按会话解析「本会话任务」，覆盖评审门、自动确认、技能顺序门、动画门与证据记录。
  - 一个 Change 只绑一个会话。
  - 交互标记 v2 带归属。
  - 放行语只认整条短回复。
  - `tenon review revoke` 与 kernel 账本 replay 修正。
- **B 部分**：
  - `tenon setup --<host> --from-source` 源码开发安装，含开发版身份、自动拉取上游技能、防覆盖、`--to-stable`。
  - 源码仓库漂移检查：SessionStart 提示、`tenon doctor` 的 `source:drift`、`/api/health` channel。
- **验证中发现并修复的测试环境泄漏**：
  - 测试与验收辅助代码曾把启动器导出的本机运行时根（`TENON_RUNTIME_ROOTS`、`TENON_RUNTIME_*_ROOT`）与插件根（`PLUGIN_ROOT`、`CLAUDE_PLUGIN_ROOT`、`TENON_HOST_PLUGIN_ROOT`、`TENON_CODEX_PLUGIN_ROOT`）传给子进程。
  - 经 `tenon test run` 执行时，bench 夹具因此把临时项目写进了用户真实的 `projects.json`；adapters、hooks 套件则因此用到了已装插件。
  - 已修复，见下文。
- **C 部分（第一轮验证时发现、用户确认后加入）**：步骤测试豁免 `tenon test waive --test <步骤测试>`。
  - 第一轮验证时，必需步骤测试 `code-size` 超限且没有豁免途径。按用户决定走 verify-fail → build → requirements-changed → spec，补规格后实现，再回到验证。
  - 同时 `.gitignore` 忽略本机 `.claude/`。
- **本机切换到源码开发安装**（B 部分 Task 17）：用户在规格门确认后已执行。
  - 结果：dev runtime `sha256-b396edf3…`，`identity:release` 黄、`source:drift` 绿，`/api/health` 的 channel 为 `dev`。
  - 回退锚点：正式 release `sha256-54347c64…`，回退用 `tenon update --claude --to-stable`。
  - 因此第二轮验证的测试、hook 与评审门判定都由仓库源码执行。
- **D 部分（第二轮验证评审后、用户逐条确认后加入）**：四个评审者的 14 条阻断级问题的修正，见设计文档 §9 与实施计划 Part D。
  - hook：交互标记按会话分文件；gate 任何时候都拒绝 agent 执行不带 `--delegated` 的手动 `tenon review acknowledge`；gate 评审分支统一用 `pipeline_hook_session_id`；漂移提示的仓库路径含控制字符时不输出、命令里加引号。
  - kernel / CLI：步骤测试豁免的批准绑定被批准的代码候选；豁免理由在评审者提示与 `test-waived` 提示里标注为登记者自述、截短；文件拆分（`step-test-waivers.ts`、`evaluate-inline.ts`、`statusStepExits.ts`、`session-binding.ts`、`kernel/state/markers.ts`）；Dashboard 快照带豁免状态。
  - CLI 小项与文档：`session activate` 先写本会话绑定再移交、在 Change 锁内完成；上游技能 id 校验；安装通道标记写失败清临时文件；工作流宪法、`adapters/contract.md` 与各适配器说明改为三条确认路径。
  - 第三轮验证时本机的源码开发安装是 runtime `sha256-7116a525…`（revision 48，展示版本 `0.3.2+dev.b0f9236`），hook 与 CLI 都是 D 部分之后的源码。
- **E 部分（第三轮验证评审后、用户确认 verify-fail 后修正）**：第三轮四个评审者里 spec-consistency 与 security 各报一条阻断，主线逐条核实属实。builder 报告 `8f00c1b9…`。
  - security（medium）：gate 拒绝 agent 手动 `tenon review acknowledge` 的预筛在去引号之前按原文找 `acknowledge`，`ackn""owledge` 这类词中拆分可以绕过。
    - 修正：判定前先把 shell 执行前就会还原的写法还原，再判定。还原顺序：JSON 转义的 ASCII → `\xHH` / `\NNN` / `\uHHHH` / `\UHHHHHHHH` 转义编码 → 续行、反斜杠、引号，以及 `$'…'` / `$"…"` 的 `$` → 花括号展开。
    - 花括号在预算内真展开，超出预算时失败关闭。还原出来的 `--delegated` 不算开关。
    - 判定读命令的上限从 512 KiB 降到 64 KiB：在上限附近的密集载荷下，gate 整体最坏实测 1.5 秒，低于 hook 的 5 秒时限。超过上限的命令只做字面检查，原文含 `acknowledge` 就拦。
    - 拒绝判定提前到受保护路径判定之前。命令段切分改为线性：旧实现在命令里填充分号时要跑 98 秒，超时会被宿主放行。
    - 仍覆盖不到的写法（函数头注释如实列出）：变量或命令替换拼出的字符串（含 eval、printf）、别名与 shell 函数、脚本文件里的调用、解释器内联程序（`-c` / `-e`）里构造的调用、靠文件系统通配符展开的路径、超过 64 KiB 且原文不含 `acknowledge` 字样的拆分或编码写法。
  - spec-consistency（high）：规格要求文档写明 `--from-source` 的已知风险，现有 5 处文档只有用法。修正：`docs/usage/cli-reference.md`、`docs/usage/contributor-development.md` 及各自的中文版、`docs/DIST-RELEASE.md` 各补一段已知风险说明。
- **F 部分（第四轮验证后用户提出、逐条确认后并入）**：验证轮次上限，见设计文档 §11、实施计划 Part F 与 delta spec `verify-round-limit`。
  - 第四轮评审的三条阻断（spec-consistency、security、backend-quality 各一）先由 builder `9cb026ca…` 修正（gate 判定拆到 `hooks/lib/ack-command.sh` 等，见 Part E Task E2）。
  - 工作流步骤键 `max_rounds`（1–20，只能声明在评审门且有回退边的步骤上，default 五条轨道的 verify 为 2，旧计划按 2）；任务字段 `max_rounds` 覆盖；轮次按 canonical 转换链计进入次数、回规格清零；`status --json` 的 `step.rounds`。
  - 用完后：`next` 不再给回退边，只剩评审者不通过时改发带 `residual` 的前进边评审请求，还有未豁免的失败测试时 `stop`（`rounds-exhausted`）；回退边在 CLI、kernel 转换用例与 Dashboard 三处被拒。
  - 剩余阻断：冻结进 `.pipeline-review-waivers.json`，人工确认接受，绑定评审者运行 id 与候选；委托、AFK 被拒；Dashboard 返回 409 `residual-pending`；历史行 `review.residual-accepted` 带摘要。
  - 就绪预审（规格一致性加后端质量、安全两份，只读）后加固：回规格出路写明两步路径；摘要去控制字符与双向字符；有链头缺读取依赖时报错；Dashboard 读不出冻结清单时拒绝；「删标记、重跑不清零」集成测试。规格措辞经 `requirements-changed` 修正（「高于当前轮次」）。
  - 文档、宪法（`templates/workflow.md`）与 tenon 技能写明：上限是用户的决定，agent 不自行调高。
  - 验证轮次上限第 1 轮发现 oracle 夹具在 default 工作流里进 3 次验证，改成两轮走完（builder `0857efa9…`）。
  - 本机源码开发安装已同步到 F 部分之后的源码（runtime `sha256-e92799e1…`，revision 50）。
- **本次没有验证的**：已污染状态的处理（A 部分 Task 11），按计划在交付步执行。

## 执行命令

全部在主检出、当前候选上经 `tenon test run` 执行，运行记录在 `.tenon/users/710227704-at-qq.com/tests/fix-hook-cross-session-isolation/`。

1. `tenon test run fix-hook-cross-session-isolation --stage`（build 步，三次）：
   - 第一次：tools-node、typecheck-e2e 失败。
   - 修复后第二次通过。
   - 改 hook 后第三次在当前代码上通过。
2. `tenon test run fix-hook-cross-session-isolation --stage`（verify 步，run `20261008T014452Z-da284b`）：hooks 2 条、adapters 10 条失败，详见「失败与阻塞」。
3. `tenon test run fix-hook-cross-session-isolation --suite hooks --suite adapters --suite tools-node`：修复后全部通过。
4. `tenon test run fix-hook-cross-session-isolation --stage`（verify 步，run `20261008T021704Z-c8100c`）：unit 1 条偶发失败，其余 8 个套件通过。
5. `tenon test run fix-hook-cross-session-isolation --suite unit`：10264 通过 / 0 失败。
6. `tenon test run fix-hook-cross-session-isolation code-size`：超阈值，登记豁免。
7. `tenon test run fix-hook-cross-session-isolation --suite bundle --suite lint-docs --suite lint-openspec --suite source-install --suite update-rollback --suite clean-install`（run `20261008T025556Z-756b32`）。
8. 本地复现与排查（不计入证据）：
   - `npx vitest run packages/cli/src/runtime/bootstrap.test.ts` 三次，均 40/40。
   - 带 `PLUGIN_ROOT` 运行 `npm run test:hooks`，复现了 hooks 那 2 条失败。
   - 在临时目录直接运行 `adapters/codex/install.sh --static`，正常投递 58 个技能，从而定位到 `TENON_*_PLUGIN_ROOT`。
   - `openspec validate fix-hook-cross-session-isolation --strict` 通过。
9. 两会话手工复现（不计入证据）。
   - 环境：隔离 HOME 与运行时根下建一个临时 git 项目，用只有「实现（评审门）→ 验证」两步的工作流建 change-a、change-b。
   - 绑定：分别用 `tenon session activate --host-session` 绑会话 A、会话 B。
   - 操作：会话 A 对 change-a 执行 `tenon review request`，再把宿主事件 JSON 喂给 `hooks/gate.sh` 和 `hooks/confirm-clear-prompt.sh`，模拟两个会话的写文件、跑命令和回复。
   - 对比：同一脚本分别用仓库源码和本机已装的旧版（release `sha256-54347c…`）各跑两种激活顺序，作为对照。

第二轮（加入步骤测试豁免之后，本机已是源码开发安装）：

10. `tenon test run fix-hook-cross-session-isolation --stage`（build 步，run `20261008T052317Z-136d02`）：8 个套件全过。
11. `tenon test run fix-hook-cross-session-isolation --stage`（verify 步，run `20261008T053726Z-438c29`）：9 个套件全过。
12. `tenon test run fix-hook-cross-session-isolation code-size`（run `20261008T055541Z-2d22c1`）：
    - 新增 9339 行，仍超上限，结果为失败。
    - 计划里有 `test:code-size` 豁免，步骤状态是 `waiver-pending`：`next` 不再要求重跑，交给验证评审门批准。
13. 其余登记套件补跑：bundle、lint-docs、lint-openspec、source-install、update-rollback、clean-install，结果见下表。
14. 两条 C 部分回归用例做过变异验证：临时让实现失效后用例转红，恢复后转绿，实现文件核对无残留。见 builder 报告 `53758c1c…`。

第三轮（D 部分修正之后）：

15. build 步运行后、进入验证前，工作区被本任务以外的进程改过：10-08 20:05 有 `packages/dashboard-app/src/workflow/*` 与 `src/index.css` 被改写成与 HEAD 相同的内容；20:31 `packages/dashboard-app/dist` 被重建，产物与源码不符。
    - 核查结果：当时没有任何已记录的 agent 会话在活动；当前只有本会话有 Tenon 心跳。
    - 处理：重跑 `npm run build`。dashboard dist 连续两次构建逐字节一致，`index.html` 引用的资源都在，且与已装的源码开发安装 payload 相同。
16. `tenon test run fix-hook-cross-session-isolation --stage`（build 步，run `20261009T031146Z-caf5db`）：8 个套件全过。
17. `tenon test run fix-hook-cross-session-isolation --stage`（verify 步，run `20261009T032720Z-32bf97`）：9 个套件全过。adapters 是 D 部分改了适配器说明之后第一次运行，397/397。
18. `tenon test run fix-hook-cross-session-isolation code-size`（run `20261009T034633Z-472519`）：新增 12459 行，结果为失败，步骤状态 `waiver-pending`。
19. 其余登记套件补跑（run `20261009T034654Z-6fca33`）：bundle、lint-docs、update-rollback、source-install 通过；lint-openspec 与前两轮相同，只因 `unify-stage-skill-canvas` 失败；clean-install 失败一次，单独重跑（run `20261009T040251Z-5b2f35`）通过，见「失败与阻塞」。
20. 本地排查（不计入证据）：
    - 用 IPv4、IPv6 回环各做一次最小 fetch 复现，都正常。
    - 复用被对端重置的 keep-alive 连接，只得到正常的 ECONNRESET，没有复现 EINVAL。
21. 第三轮验证评审：四个必需评审者逐条全覆盖（未达标的报告退回补齐后再登记）。
    - code-size、backend-quality 通过。
    - spec-consistency 与 security 各一条阻断，见「结果」。用户确认 verify-fail，回到实现修正（E 部分）。

第四轮（E 部分修正之后）：

22. builder（run `8f00c1b9…`）自测：`npm run test:hooks` 1888 通过、`npm run check:docs` 通过、`npm run build` 退出码 0。
23. `tenon test run fix-hook-cross-session-isolation --stage`（build 步，run `20261009T072541Z-d0e150`）：8 个套件全过。
24. `tenon test run fix-hook-cross-session-isolation --stage`（verify 步，run `20261009T074040Z-e45ff8`）：9 个套件全过，hooks 1888 / 1888（含 E 部分新增的拆分、编码、花括号与大命令性能用例）。
25. `tenon test run fix-hook-cross-session-isolation code-size`（run `20261009T080059Z-3fe3a9`）：新增 12979 行，结果为失败，步骤状态 `waiver-pending`。
26. 其余登记套件补跑（run `20261009T080122Z-f81355`）：bundle、lint-docs、clean-install、update-rollback、source-install 通过；lint-openspec 仍只因 `unify-stage-skill-canvas` 失败，本任务 change 通过。

第五轮（F 部分之后，本任务验证轮次上限下）：

27. F 部分 builder 自测（G1–G4 `b8152749…`、G5 `dccca583…`、核验 `e6b9a95d…`）：packages 全量 vitest 回归、`npx tsc -b` 六个包、`typecheck:web`、`check-architecture`、`check:comments`、`check:docs`、`test:hooks` 2124、`npm run build` 均通过；新测试先红后绿，写在实现之后的用例用临时改动做了变异验证。
28. `tenon test run fix-hook-cross-session-isolation --stage`（build 步，run `20261009T123817Z-f95420`、`20261009T154156Z-4da2c0`）：8 个套件全过。
29. 验证轮次上限第 1 轮（上限 1）：`--stage`（verify 步，run `20261009T155637Z-cb1d6e`）oracle 7 条失败，其余 8 个套件通过；`next` 给出 `stop`（`rounds-exhausted`），用户选「调高到 2 并修夹具」，见「失败与阻塞」。
30. 修夹具后 `--stage`（build 步，run `20261010T005629Z-a52b35`）：8 个套件全过。
31. 验证轮次上限第 2 轮：`--stage`（verify 步，run `20261010T011023Z-ee77af`）：9 个套件全过，oracle 105 / 105。
32. `tenon test run fix-hook-cross-session-isolation code-size`（run `20261010T012912Z-590bb7`）：新增 33043 行，结果为失败，步骤状态 `waiver-pending`。
33. 其余登记套件补跑（run `20261010T013038Z-e9b30f`）：bundle 87 / 87、lint-docs、clean-install、update-rollback、source-install 通过；lint-openspec 仍只因 `unify-stage-skill-canvas` 失败（`openspec validate --all --strict`：45 通过、1 失败），本任务 change 通过。

计划定稿后在当前候选上完整重跑的结果，由 `tenon test report` 写入下文的追溯矩阵。

## 结果

第五轮 verify 阶段（run `20261010T011023Z-ee77af`）与 build 阶段（run `20261010T005629Z-a52b35`）的结果；其余套件见第 33 条补跑。前几轮的数字（如第四轮 hooks 1888、oracle 107、code-size 新增 12979 行）已被本表取代。

| 套件 | 结果 |
| --- | --- |
| unit（packages vitest） | 10597 通过 / 0 失败 / 18 跳过（build 与 verify 两次运行相同） |
| dashboard-app-unit | 1874 通过 / 0 失败 |
| tools-node | 212 通过 / 0 失败 |
| docs-site-unit | 2 通过 / 0 失败 |
| hooks（`tools/test-hooks.sh`） | 2124 通过 / 0 失败 |
| adapters（`tools/test-adapters.sh`） | 397 通过 / 0 失败 |
| migration-cas | 13 通过 / 0 失败 |
| oracle-unit / oracle | 16 / 105 通过，0 失败（夹具改为两轮后少两步） |
| typecheck-packages / -web / -e2e | 退出码 0（build 步） |
| bundle | 87 通过 / 0 失败（run `20261010T013038Z-e9b30f`，与 lint-docs、lint-openspec、source-install、update-rollback、clean-install 同一次补跑） |
| lint-docs | 退出码 0 |
| source-install（真实 claude、codex，隔离 HOME） | 退出码 0 |
| update-rollback | 退出码 0 |
| clean-install | 退出码 0（第三轮曾偶发崩溃一次，见下） |
| lint-openspec | 退出码 1：45 项通过、1 项失败，失败项是未跟踪的 `unify-stage-skill-canvas`，本任务 change 通过；见下 |
| code-size（步骤测试） | 失败（metric-threshold）：新增 33043 行、删除 16605 行、314 个文件，上限 2000。`test:code-size` 豁免待验证评审门批准，状态 `waiver-pending`；拆分见「失败与阻塞」 |

第三轮验证评审（四个必需评审者，报告在 `.pipeline-agent-reports/`）：

| 评审者 | 报告 | 结论 | 阻断 |
| --- | --- | --- | --- |
| code-size | `8da926d8…` | 通过 | 0（6 条 low） |
| backend-quality | `63d5b7d4…` | 通过 | 0（7 条 low） |
| spec-consistency | `ae77daa7…` | 不通过 | 1 条 high：文档没有写 `--from-source` 已知风险 |
| security | `fe482d7a…` | 不通过 | 1 条 medium：词中拆分绕过手动 acknowledge 拒绝 |

两条阻断由 E 部分修正。

第五轮验证评审（验证轮次上限第 2 轮，四个必需评审者，Sonnet low；首份报告不全覆盖的退回补齐一次后登记）：

| 评审者 | 报告 | 结论 | 阻断 |
| --- | --- | --- | --- |
| code-size | `386018b2…` | 通过 | 0（3 条 low：`ack-command.sh` 与 `test-hooks.sh` 体量、5 个 kernel 文件接近行数上限） |
| spec-consistency | `f188ad61…` | 通过 | 0（4 条 low）；四份 delta spec 79 个 Scenario 逐条有实现与测试证据，322 个文件逐个归属，没有多做 |
| backend-quality | `05964aa7…` | 通过 | 0（10 条 low）；实现、配置与生成产物全部细审或复核，测试与文档约 170 个按用途核对、未逐个读 diff（测试已在本轮实际运行全绿，文档由 spec-consistency 逐个归属） |
| security | `4e054def…` | 通过 | 0（3 条 low）；触及信任边界的实现文件逐个读过或看过 diff，测试与纯文档未读 |

第二波参考评审者 architecture（`2b9edb48…`，阻断级别 high）：通过，3 条 low（`gate.sh` 两个按需加载库缺失时的方向相反、`stepRounds` 是纯转发、CLI 与 server 读历史文件的错误处理不一致）。它按模块归类覆盖，未逐个文件；kernel 运行时导入图 SCC 为 0，轮次判定只有 kernel 一份实现。参考评审者不阻断，按审查预算未退回。

security 首份报告把 F1（`session activate --host-session` 只校验格式，移交可删掉别的会话对同一 Change 的绑定）定为 medium。主线核实并提供了三条事实：改动前激活另一个 Change 即可同等自我脱离；自动移交的后果已写在 ADR 第 24、40、55 行与设计 §1；它建议的「要求等于宿主会话环境变量」在 Claude Code 上不可行（agent 的 shell 没有该变量）。评审者复核后降为 low，建议只在风险里补一句「该机制不鉴权调用者」，见「剩余风险」。

两会话手工复现（第 9 条）：

| 场景 | 旧版 | 源码 |
| --- | --- | --- |
| change-a 最后激活：会话 B 写文件 | 被 A 的评审标记拦（exit 2），即原问题 | 放行 |
| change-a 最后激活：会话 B 回复「确认继续」 | 批准了 A 的评审，标记被清 | A 仍待确认，标记仍在 |
| change-b 最后激活：会话 A 自己写文件 | 没被自己的评审门拦（exit 0） | 被拦（exit 2） |
| 会话 A 的长句「好的，确认继续吧，另外看看日志」 | — | 不放行 |
| 会话 A 整条回复「确认继续」 | — | 批准，A 放行 |
| `tenon review revoke` | 旧版没有该命令 | 回到待确认，A 再次被拦，B 不受影响 |
| 会话 B 激活 change-a | — | 绑定移交给 B：B 被 change-a 的评审门拦，A 不再被拦 |

源码在两种激活顺序下都是 17 项全部通过。

实现阶段内的评审各进行了一轮（sonnet-reviewer）：

- A 部分：2 条 medium，均已修复并补了红测试。
- B 部分 Task 1-13：2 条 medium，均为缺测试，已补。
- 就绪审查（B 部分 Task 14-16 与环境隔离修复）：0 条阻断。其中 1 条 low（漂移提示回显标记内容）已修复并加了测试。
- C 部分（主线亲审）：0 条阻断。
  - 豁免只对必需测试的新鲜失败生效。
  - 计划不可信时不读豁免。
  - 委托确认不批准豁免（`review-acknowledge.ts` 第 96 行，按键通用）。
  - `--test` 的 id 对照冻结工作流校验，理由上限 1000 字节。
  - 发现两条行为缺用例，已由第二次 builder 补上并做变异验证。

下文追溯矩阵里的场景都显示「未覆盖」，原因是本步测试策略不要求场景映射（`scenarios: off`），不挡出口。各场景对应的测试见实施计划的「Scenario 覆盖（delta spec → 测试）」一节（A、B 部分）与 Part C 的 Review Focus 与测试清单，没有逐条登记成映射。

## 失败与阻塞

- **hooks 2 条、adapters 10 条，已修复。** 两者只在经 `tenon test run` 执行时失败，根因是套件继承了启动器的插件根变量：
  - hook 取插件根时 `PLUGIN_ROOT` 优先于用例故意设成损坏的 `CLAUDE_PLUGIN_ROOT`，「插件根损坏」类用例实际跑的是已装插件。
  - Codex 安装器把 `TENON_CODEX_PLUGIN_ROOT` / `TENON_HOST_PLUGIN_ROOT` 当成已有的原生插件根，于是跳过了静态投递。
  - 修复：`tools/test-hooks.sh`、`tools/test-adapters.sh` 开头清掉这些变量；守卫测试 `tools/shell-suites-runtime-roots.node-test.mjs` 覆盖 4 个 shell 套件。
- **tools-node 1 条，已修复。** bench 夹具把临时项目登记进了真实的 `~/Library/Application Support/tenon/config/projects.json`。
  - 根因：`isolatedEnv` 只设了 `TENON_RUNTIME_HOME`，没删优先级更高的 `TENON_RUNTIME_ROOTS`。
  - 修复：新增 `tools/lib/runtime-roots.mjs`，并审计了全部隔离子进程构造点，另修了 4 处，每处都有测试。其中 vitest 全局 setup 原来只清 1 个变量，现在清 4 个。
  - 真实登记表里的 2 条测试残留已删除，备份为 `projects.json.bak-20261008-bench-leak`。之后检查过，真实运行时目录没有其他被测试写入的文件。
- **typecheck-e2e，已修复。** 主检出缺少已声明的依赖 `@axe-core/playwright`，补装后通过，锁文件没有变化。
- **unit 1 条偶发失败。** `packages/cli/src/runtime/bootstrap.test.ts` 里「serializes repair processes that race past the retry marker」只在全量运行负载下失败过一次：单独连跑 3 次都通过，重跑整套也通过。它测的是 bootstrap 修复锁的竞态，本任务没改这段逻辑。
- **lint-openspec，不归本任务。** 失败项是另一个暂停中的任务 `unify-stage-skill-canvas`：它停在调研阶段，还没有 delta spec，过不了严格校验（「Change must have at least one delta」）。本任务的 change 校验通过（`✓ change/fix-hook-cross-session-isolation`）。
- **clean-install 第三轮补跑时失败一次，单独重跑通过。**
  - 现象：`tools/clean-codex-install-acceptance.mjs` 跑到 192 秒时，Node 24.18 内置 undici 在 socket 的 `connect` 回调里调用 `setTypeOfService`，得到 EINVAL。Node 的 net 层在非 Windows 平台同步抛出，没有交给 fetch 的 Promise，于是整个进程崩溃。
  - 判断：时序相关的偶发，不是本任务的回归。
    - Node 与 libuv 自第二轮以来没变；验收脚本本任务没有改。
    - IPv4、IPv6 回环的最小复现都正常。
    - 同一份代码单独重跑通过（139.6 秒）。
    - 最可能的路径是健康检查连上一个正在退出的 Dashboard：握手完成后对端重置，setsockopt 返回 EINVAL。这条没有复现，只是推断。
  - 风险：同样的崩溃可能在其他用到 fetch 的验收脚本里偶发。作为后续任务记录，不在本任务里改。
- **code-size，待批准。** 第一轮登记的种类豁免 `kind:code-size` 对步骤测试无效。
  - 原因：Tenon 当时只能豁免策略要求的种类与追溯条目，`next` 永远要求重跑。
  - 处理：已撤销，改为 C 部分新增的步骤测试豁免 `test:code-size`，在验证评审门由用户批准。D 部分把批准绑定到被批准的代码候选，第二轮之前的批准没有候选，按待批准处理。
  - 理由（计划里登记的原文，数字是第二轮的）：范围经用户两次确认扩大，验证中又加入步骤测试豁免；新增行里约 2100 行是重新生成的打包产物，约 3300 行是测试，手写源码本身也超过 2000 行；拆分无效。
  - 第三轮的实际拆分（与探针同一口径 `isCodePath`，合计 12459 行、247 个文件）：重新生成的打包产物 3322 行（其中 `packages/cli/dist/tenon.mjs` 2704 行）、测试 5159 行、手写源码 3978 行。比第二轮多出约 3100 行：打包产物从约 2100 行增加到 3322 行，其余约 1900 行是 D 部分的修正与测试。
  - 第四轮的实际拆分（同一口径，合计 12979 行、247 个文件）：打包产物 3322 行、测试 5263 行、手写源码 4394 行。比第三轮多出的 520 行是 E 部分的 gate 修正与 hook 用例。结论不变：手写源码本身超过 2000 行。
  - 第五轮的实际拆分（同一口径，合计 33043 行、314 个文件）：重新生成的打包产物 18229 行（`packages/server/dist/dashboard.mjs` 9425 行、`packages/cli/dist/tenon.mjs` 8679 行，打包器重排输出放大了 diff）、测试 7093 行、手写源码 7721 行（含 `tools/test-hooks.sh` 1218 行，按命名口径算作源码）。比第四轮多出的约 2 万行里，约 1.5 万行是打包产物重排，其余是 F 部分的实现与测试。
  - 计划里登记的豁免理由仍是第二轮的数字（约 2100 行打包产物、约 3300 行测试），论断不变（手写源码本身超过 2000 行、拆分无效），数字偏小。重新登记会改计划摘要、让刚跑完的验证套件全部过期，所以没有改写，实际数字以本节为准，在验证评审门一并交给用户。
  - 口径修正：未跟踪的本机 `.claude/`（约 3060 行 Trellis 本地文件）原先被计入，现已加入 `.gitignore`，不再计入。

- **oracle 7 条，验证轮次上限的第 1 轮（2026-10-10），用户决定调高上限修复。**
  - 现象：`tools/oracle/fixtures/default-effects.sh` 的 `t6-de` 从 `#23 transition verify-fail` 起 7 步与老脚本不一致。
  - 根因：夹具在 default 工作流里进了 3 次验证（第 2 轮故意撞提交屏障后再 `verify-fail`），新的 `max_rounds: 2` 按设计拒绝第 2 轮的回退边。老脚本不认 `max_rounds`，夹具里不能调高上限，只能调整场景顺序。
  - 处置：本任务上限为 1，第 1 轮即用完，`next` 给出 `stop`（`rounds-exhausted`）并列出四条出路；用户选「调高到 2 并修夹具」，主线照指示执行 `tenon set … max_rounds 2`，经 `verify-fail` 回实现，把屏障场景挪到第 1 轮，两轮走完 A–F 六个场景。下一次验证是第 2 轮，也是最后一轮。

## 剩余风险

- **会话恢复后换了 id**：重新 activate 之前，本会话的拦截暂不生效，这是设计取舍，离开评审步仍需 canonical 回执。
- **交互标记并发覆盖**：D 部分起，宿主给了会话 id 时交互标记按会话分文件，并行等待互不覆盖；宿主不给会话 id 时仍是单个文件，后写的覆盖先写的，后果是少拦一次。
- **放行语只认整条短回复**：「好的，确认继续吧，另外……」这类长句不再放行，提示文案里已写明。
- **源码漂移摘要**：路径中含换行时会误报不一致，只会多一次提示，不会出错。
- **端到端回切**：真实宿主上 `update --to-stable` 的端到端只会在本机切换时第一次走到；验收脚本覆盖的是开发安装一侧。
- **仓库内其他在途任务**：`unify-stage-skill-canvas` 会让全仓 OpenSpec 校验持续失败，直到它补上 delta spec。
- **已污染状态**：另一个任务里误记的规格批准与串入的证据，计划在交付步用新的 `tenon review revoke` 和一条更正事件处理；在那之前，那个会话必须停在规格步。
- **步骤测试豁免的已知限制**：
  - 没声明 `test_policy` 的步骤（只可能出现在自定义工作流）登记得进豁免但不生效，文档已注明。
  - `diff-risk` 的升级信号不读豁免。
  - D 部分起，批准只对被批准时那份代码上的失败有效。批准之后代码变了、同一测试再失败，要先 `tenon review revoke` 再重新请求评审，`next` 会点名。
- **本机是源码开发安装**：之后改了源码，要重跑 `tenon setup --claude --from-source .` 才会生效；新会话开头的漂移提示会提醒。
- **验证轮次上限的已知限制**（F 部分，规格与设计已记录）：
  - agent 技术上能执行 `tenon set <c> max_rounds <N>` 调高上限，「不自行调高」只靠技能、宪法与同机同用户信任模型。
  - build 不受上限约束：在 build 上执行 `requirements-changed` 回规格会让轮次清零，但每次都要再过规格评审门的人工确认。
  - 设置过 `max_rounds` 的任务、带剩余阻断记录的冻结清单，升级前的运行时读不了（失败关闭）。本任务已设置该字段，交付后只能由新版运行时读取。
  - 转换记录链在中途断裂（记录缺失或损坏）时，按存储层既有契约截止而不报错，轮次会偏小。
  - Dashboard 的评审者面板与 `tenon agent next` 不读接受记录，接受剩余阻断后仍显示评审者不通过（只影响展示）；Dashboard 确认不展示待接受项，返回 409 `residual-pending`，只能在终端接受。
  - 接受只绑定评审者运行 id 与候选，不绑定报告摘要；评审台账本身不受 gate 保护。
  - 新会话换了宿主会话 id 后，在入口技能重新 activate 之前，放行语不会确认本任务（本轮实际遇到一次，属设计行为）；评审标记 30 分钟过期后放行语同样不生效，要重新 `review request` 写回标记（本轮也遇到一次）。
- **会话绑定移交不鉴权调用者**（第五轮 security F1，low）：`tenon session activate <c> --host-session <id>` 只校验 id 格式。同机同用户的 agent 可以传入另一个会话的 id，借移交删掉那个会话对同一 Change 的绑定，或让自己脱离评审标记的拦截。改动前激活另一个 Change 也能同等脱离；真正的边界是 canonical 回执，transition 仍需用户确认。
- **第五轮评审提出的其余 low**（不阻断，进后续）：`max_rounds` 行匹配不限缩进层级；预检与锁内轮次口径不一致时多一次往返；冻结清单 64 KiB 上限未按评审者数约束；旧任务 JSONL 回退不分 run；`source-drift.sh` 遇含换行的文件名会误报漂移；`approved_candidate` 只接受工作区指纹；AFK 与撤销审计在依赖缺省时不失败关闭（仅测试装配）；`setupHost.ts` 重复注释；`.gitignore` 的 `.claude/` 会忽略项目级共享设置；hook 输入的 `session_id` / `agent_id` 取第一个同名键不分层级。
- **oracle 夹具的既有问题**（本任务没改）：`default-effects` 头部写的 B（最终 verify-pass 成功）与 F（ship / archived）在改前改后都没有真正成功：老脚本先要 `agent_review_result=pass`，两侧都拒绝，靠已登记的 exit / stderr 差异放行。直接 `bash tools/oracle/run.sh` 会被 gate 误判为写受保护路径（脚本正文含 `.tenon` 字样），只能经 `npm run oracle` 运行。
- **已推迟到后续任务**（验证评审提出，主线或用户决定推迟）：
  - `review revoke` 不撤回已写入的豁免批准：需要把批准与确认回执关联。
  - 有待批准的豁免时，简短同意（「好」「可以」）也会批准它们（security low）。
  - statusline 与 inbox 只认单个交互标记文件（只影响展示）。
  - `update-dev-guard` 在 runtime 读取失败且没有标记时按正式版继续（fail-open）；`--from-source` 的构建没有超时。
  - 手动 `tenon review acknowledge` 的拒绝是对命令文本的静态判定。E 部分起，引号、反斜杠、转义编码与花括号展开都先还原再判定；仍覆盖不到的写法是：变量或命令替换拼出的字符串（含 eval、printf）、别名与 shell 函数、脚本文件里的调用、解释器内联程序（`-c` / `-e`）里构造的调用、靠文件系统通配符展开的路径、超过 64 KiB 且原文不含 `acknowledge` 字样的拆分或编码写法。
  - 失败关闭方向的误拦：引号里本不展开的花括号词、用反斜杠或转义编码拼出的 `--delegated`，会被按手动确认拦下；只读搜索命令里反引号后面的文字也可能被当成命令段而误拦。
  - gate 自审批候选提取里的命令拆分（HEAD 时就有，本任务没有改）用全局替换，bash 3.2 下对分隔符个数是平方级：16384 个分号的命令要跑 14 秒，超过 hook 的 5 秒时限后宿主按非阻断错误放行，评审 / 交互标记门会失效。手动 acknowledge 的拒绝已提前到它之前，不受影响。修法与 E 部分对命令段切分的做法相同，进后续任务。
  - 用户在 Claude Code 里用 `!` 前缀自己运行 acknowledge 时是否会被 PreToolUse 拦，没有验证。
  - Node 24 内置 undici 的 `setTypeOfService EINVAL` 会让用到 fetch 的验收脚本偶发崩溃（见「失败与阻塞」的 clean-install）。

## 测试

<!-- tenon:tests:start digest=sha256:27af9112f24f7ae2b8679656a78284b52eed4b686ac79b2b1fb9a89e7d478cc0 -->
| 阶段 | 测试 | 方向 | 状态 | 退出码 | 耗时 | 执行人 | 时间 | 候选 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 验证 | 代码规模 `code-size` | code-size | 失败 | 0 | 0.4s | jefferySha | 2026-10-10T01:29:13.692Z | `workspace:sha256:25b3…` |
### 失败
- `code-size`：metric-threshold — `.tenon/users/710227704-at-qq.com/tests/fix-hook-cross-session-isolation/20261010T012912Z-590bb7.json`
### 命令
- `code-size`：`tenon test code-size --json`（cwd `.`）
<!-- tenon:tests:end -->

<!-- tenon:test-report:begin -->
## 测试体系

### 追溯矩阵
| 场景 / 任务 | 用例 | 最近结果 | 状态 |
| --- | --- | --- | --- |
| interaction-and-skill-provenance · Bare continue resumes with no pending receipt `spec:interaction-and-skill-provenance/Bare continue resumes with no pending receipt` | — | — | 未覆盖 |
| interaction-and-skill-provenance · Bare continue approves the exact pending interaction `spec:interaction-and-skill-provenance/Bare continue approves the exact pending interaction` | — | — | 未覆盖 |
| interaction-and-skill-provenance · New objective contains the word continue `spec:interaction-and-skill-provenance/New objective contains the word continue` | — | — | 未覆盖 |
| interaction-and-skill-provenance · Natural reply approves the unique pending recommendation `spec:interaction-and-skill-provenance/Natural reply approves the unique pending recommendation` | — | — | 未覆盖 |
| interaction-and-skill-provenance · Mixed approval preserves its constraint `spec:interaction-and-skill-provenance/Mixed approval preserves its constraint` | — | — | 未覆盖 |
| interaction-and-skill-provenance · Ambiguous reply does not clear the marker `spec:interaction-and-skill-provenance/Ambiguous reply does not clear the marker` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 粘贴文本里的放行语不构成放行 `spec:interaction-and-skill-provenance/粘贴文本里的放行语不构成放行` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 整条短回复构成放行 `spec:interaction-and-skill-provenance/整条短回复构成放行` | — | — | 未覆盖 |
| interaction-and-skill-provenance · AskUserQuestion 只看答案值 `spec:interaction-and-skill-provenance/AskUserQuestion 只看答案值` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 另一个会话的评审不拦本会话 `spec:interaction-and-skill-provenance/另一个会话的评审不拦本会话` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 另一个会话的放行语不确认本任务 `spec:interaction-and-skill-provenance/另一个会话的放行语不确认本任务` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 技能证据记到本会话任务 `spec:interaction-and-skill-provenance/技能证据记到本会话任务` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 会话恢复换了 id 尚未重新绑定 `spec:interaction-and-skill-provenance/会话恢复换了 id 尚未重新绑定` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 宿主不提供会话标识 `spec:interaction-and-skill-provenance/宿主不提供会话标识` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 恢复后的新会话接管任务 `spec:interaction-and-skill-provenance/恢复后的新会话接管任务` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 一个会话加载交互技能不锁其他会话 `spec:interaction-and-skill-provenance/一个会话加载交互技能不锁其他会话` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 其他会话的提问不解除本会话标记 `spec:interaction-and-skill-provenance/其他会话的提问不解除本会话标记` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 两个会话同时等待回答 `spec:interaction-and-skill-provenance/两个会话同时等待回答` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 旧格式标记退役 `spec:interaction-and-skill-provenance/旧格式标记退役` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 撤回误记的批准 `spec:interaction-and-skill-provenance/撤回误记的批准` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 已被消费的回执不可撤销 `spec:interaction-and-skill-provenance/已被消费的回执不可撤销` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 缺少原因 `spec:interaction-and-skill-provenance/缺少原因` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 撤销后状态已变化 `spec:interaction-and-skill-provenance/撤销后状态已变化` | — | — | 未覆盖 |
| interaction-and-skill-provenance · agent 自批被拒 `spec:interaction-and-skill-provenance/agent 自批被拒` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 标记过期后仍拒绝 `spec:interaction-and-skill-provenance/标记过期后仍拒绝` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 委托确认放行 `spec:interaction-and-skill-provenance/委托确认放行` | — | — | 未覆盖 |
| plugin-runtime · 版本化候选激活 `spec:plugin-runtime/版本化候选激活` | — | — | 未覆盖 |
| plugin-runtime · 候选版本与目标标签不一致 `spec:plugin-runtime/候选版本与目标标签不一致` | — | — | 未覆盖 |
| plugin-runtime · 恢复 v1.0.1 旧 journal `spec:plugin-runtime/恢复 v1.0.1 旧 journal` | — | — | 未覆盖 |
| plugin-runtime · v1.0.1 setup/update WAL 缺少 frozen stable target `spec:plugin-runtime/v1.0.1 setup/update WAL 缺少 frozen stable target` | — | — | 未覆盖 |
| plugin-runtime · 源码开发安装不冒充版本标签 `spec:plugin-runtime/源码开发安装不冒充版本标签` | — | — | 未覆盖 |
| plugin-runtime · 正式安装仍只认稳定标签 `spec:plugin-runtime/正式安装仍只认稳定标签` | — | — | 未覆盖 |
| plugin-runtime · 缺技能时先拉取再安装 `spec:plugin-runtime/缺技能时先拉取再安装` | — | — | 未覆盖 |
| plugin-runtime · 拉取失败不装半套 `spec:plugin-runtime/拉取失败不装半套` | — | — | 未覆盖 |
| plugin-runtime · 非 Tenon 源码仓库 `spec:plugin-runtime/非 Tenon 源码仓库` | — | — | 未覆盖 |
| plugin-runtime · 只看计划不改动 `spec:plugin-runtime/只看计划不改动` | — | — | 未覆盖 |
| plugin-runtime · 开发安装下的更新 `spec:plugin-runtime/开发安装下的更新` | — | — | 未覆盖 |
| plugin-runtime · 安装内容变了提示同步 `spec:plugin-runtime/安装内容变了提示同步` | — | — | 未覆盖 |
| plugin-runtime · 只有提交不提示 `spec:plugin-runtime/只有提交不提示` | — | — | 未覆盖 |
| plugin-runtime · 一致时不提示 `spec:plugin-runtime/一致时不提示` | — | — | 未覆盖 |
| plugin-runtime · 仓库路径含控制字符 `spec:plugin-runtime/仓库路径含控制字符` | — | — | 未覆盖 |
| plugin-runtime · 非源码仓库不检查 `spec:plugin-runtime/非源码仓库不检查` | — | — | 未覆盖 |
| plugin-runtime · 源码仓库里装的是正式版 `spec:plugin-runtime/源码仓库里装的是正式版` | — | — | 未覆盖 |
| step-test-waiver · 已批准的豁免放行新鲜的失败 `spec:step-test-waiver/已批准的豁免放行新鲜的失败` | — | — | 未覆盖 |
| step-test-waiver · 未批准的豁免随评审请求列出 `spec:step-test-waiver/未批准的豁免随评审请求列出` | — | — | 未覆盖 |
| step-test-waiver · 豁免不免除运行 `spec:step-test-waiver/豁免不免除运行` | — | — | 未覆盖 |
| step-test-waiver · 批准后代码变了要重新批准 `spec:step-test-waiver/批准后代码变了要重新批准` | — | — | 未覆盖 |
| step-test-waiver · 没有豁免时行为不变 `spec:step-test-waiver/没有豁免时行为不变` | — | — | 未覆盖 |
| step-test-waiver · 登记步骤测试豁免 `spec:step-test-waiver/登记步骤测试豁免` | — | — | 未覆盖 |
| step-test-waiver · 未知的测试 id 被拒绝 `spec:step-test-waiver/未知的测试 id 被拒绝` | — | — | 未覆盖 |
| step-test-waiver · 与其他豁免互斥 `spec:step-test-waiver/与其他豁免互斥` | — | — | 未覆盖 |
| step-test-waiver · 待批准豁免不再卡在重跑 `spec:step-test-waiver/待批准豁免不再卡在重跑` | — | — | 未覆盖 |
| step-test-waiver · 代码规模评审者看到豁免 `spec:step-test-waiver/代码规模评审者看到豁免` | — | — | 未覆盖 |
| step-test-waiver · 理由不能伪造提示结构 `spec:step-test-waiver/理由不能伪造提示结构` | — | — | 未覆盖 |
| verify-round-limit · 内置工作流默认两轮 `spec:verify-round-limit/内置工作流默认两轮` | — | — | 未覆盖 |
| verify-round-limit · 非法取值被拒绝 `spec:verify-round-limit/非法取值被拒绝` | — | — | 未覆盖 |
| verify-round-limit · 任务覆盖上限 `spec:verify-round-limit/任务覆盖上限` | — | — | 未覆盖 |
| verify-round-limit · 第二次进入验证 `spec:verify-round-limit/第二次进入验证` | — | — | 未覆盖 |
| verify-round-limit · 回到规格后重新计数 `spec:verify-round-limit/回到规格后重新计数` | — | — | 未覆盖 |
| verify-round-limit · 第二轮仍不通过 `spec:verify-round-limit/第二轮仍不通过` | — | — | 未覆盖 |
| verify-round-limit · 上限用完时回退被拒 `spec:verify-round-limit/上限用完时回退被拒` | — | — | 未覆盖 |
| verify-round-limit · 调高上限后可以回退 `spec:verify-round-limit/调高上限后可以回退` | — | — | 未覆盖 |
| verify-round-limit · 还有未登记豁免的失败测试 `spec:verify-round-limit/还有未登记豁免的失败测试` | — | — | 未覆盖 |
| verify-round-limit · 接受剩余阻断后前进 `spec:verify-round-limit/接受剩余阻断后前进` | — | — | 未覆盖 |
| verify-round-limit · 委托确认不能接受剩余阻断 `spec:verify-round-limit/委托确认不能接受剩余阻断` | — | — | 未覆盖 |
| verify-round-limit · 代码变了接受失效 `spec:verify-round-limit/代码变了接受失效` | — | — | 未覆盖 |
| verify-round-limit · 上限未用完不放行 `spec:verify-round-limit/上限未用完不放行` | — | — | 未覆盖 |
| 写 proposal / design / tasks，记录 4 处问题的源码证据、范围与非目标。 `task:1.1` | — | — | 可选 |
| 核实各宿主 hook 输入里 `session_id` 的提供情况（PreToolUse / PostToolUse / UserPromptSubmit、子代理、会话恢复）。 (explore) `task:2.1` | — | — | 可选 |
| 定交互标记新格式、放行语整条匹配规则、撤销命令的语义与权限。 (explore) `task:2.2` | — | — | 可选 |
| 写设计文档与 ADR。 (explore) `task:2.3` | — | — | 可选 |
| 写 `interaction-and-skill-provenance` 与 `plugin-runtime` 的 delta spec。 (spec) `task:3.1` | — | — | 可选 |
| 写实施计划（测试先行的顺序、验收命令、本地运行时重装步骤）。 (spec) `task:3.2` | — | — | 可选 |
| 登记测试计划（tools/test-hooks.sh 新用例、CLI 撤销命令单测）。 (spec) `task:3.3` | — | — | 可选 |
| 写 `step-test-waiver` 的 delta spec，并把步骤测试豁免写进提案、设计与实施计划（验证步发现 code-size 无豁免途径后加入）。 (spec) `task:3.4` | — | — | 可选 |
| 按第二轮验证评审结论更新三份 delta spec、提案、设计、ADR 与实施计划（Part D）。 (spec) `task:3.5` | — | — | 可选 |
| 写 `verify-round-limit` 的 delta spec，并把验证轮次上限与第三、四轮 gate 加固写进提案、设计、ADR 与实施计划（Part E、Part F）。 (spec) `task:3.6` | — | — | 可选 |
| 按就绪预审修正 `verify-round-limit` 措辞：上限「调到高于当前轮次」才恢复回退；从 verify 回规格写明两步路径；历史记下发现摘要；有链头时读不到链即报错。设计、提案同步。 (spec) `task:3.7` | — | — | 可选 |
| 会话归属 helper，所有拦截与记证据的 hook（评审门、自动确认、技能顺序门、动画门、证据记录）改用它，改正 review-ack.sh 注释。 (build) `task:4.1` | — | — | 未覆盖 |
| 交互标记带 Change 与会话，拦截与解锁只作用于归属会话，旧格式见到即删除。 (build) `task:4.2` | — | — | 未覆盖 |
| 放行语只认整条短回复（prompt-intent.sh 与 confirm-clear.sh）。 (build) `task:4.3` | — | — | 未覆盖 |
| 新增 `tenon review revoke` 命令（回到待确认）及测试。 (build) `task:4.4` | — | — | 未覆盖 |
| `session activate --host-session` 一对一绑定与自动移交提示及测试。 (build) `task:4.5` | — | — | 未覆盖 |
| 实验：本地目录市场的缓存行为、Codex 支持、`plugin list` 形态、宿主对账对 stable target 的依赖。 (build) `task:4.6` | — | — | 未覆盖 |
| 源码开发安装 `tenon setup --<host> --from-source`（dev release 身份、自动拉取上游技能、防覆盖、`--to-stable`）及测试。 (build) `task:4.7` | — | — | 未覆盖 |
| 源码仓库漂移检查（`tenon doctor` 的 `source:drift`、SessionStart 提示、Dashboard channel）及测试。 (build) `task:4.8` | — | — | 未覆盖 |
| 步骤测试豁免 `tenon test waive --test <步骤测试>`：失败的必需步骤测试经评审批准后放行，待批准时随评审请求列出而不是要求重跑，读测试的评审者提示里带豁免与理由；文档与测试。 (build) `task:4.9` | — | — | 未覆盖 |
| 补步骤测试豁免的两条回归用例：测试计划被篡改时豁免不生效；理由含换行时评审者提示折成单行（实施计划 Part C Step 7）。 (build) `task:4.10` | — | — | 未覆盖 |
| 验证评审修复（hook）：交互标记按会话分文件；agent 不能自己执行手动 `tenon review acknowledge`（只放行 `--delegated` 与 `review request`）；gate 评审分支统一用 `pipeline_hook_session_id`；漂移提示的仓库路径遇控制字符不输出、命令里加引号。 (build) `task:4.11` | — | — | 未覆盖 |
| 验证评审修复（kernel / CLI）：步骤测试豁免的批准绑定到被批准的代码候选；豁免判定拆出 `evaluate-v2.ts`、`statusStepNext.ts` 留出余量；评审者提示与 `test-waived` 提示里的豁免理由标注为执行者自述并截短；Dashboard 快照带豁免状态；`review revoke` 一并撤回豁免批准（主线决定推迟，未做，见验证报告）。 (build) `task:4.12` | — | — | 未覆盖 |
| 验证评审修复（CLI 小项）：`session activate` 先写本会话绑定再移交、在锁内完成；上游技能 id 校验；安装通道标记写失败时清理临时文件。 (build) `task:4.13` | — | — | 未覆盖 |
| 第三轮验证评审修复：gate 拒绝手动 acknowledge 的预筛改为对去引号、去反斜杠后的命令判定（词中拆分不再绕过）；五处文档补写 `--from-source` 的已知风险。 (build) `task:4.14` | — | — | 未覆盖 |
| 验证轮次上限：工作流步骤 `max_rounds` 的解析、校验、编译与计划冻结，`default` 工作流 verify 步声明 2；`tenon set … max_rounds` 任务覆盖；按进入次数计轮次、回规格清零；用完后 `next` 不再给回退、回退边的评审请求与转换拒绝；剩余阻断 `reviewer:<agent>` 的冻结、人工接受与候选绑定；`status --json` 的轮次字段；Dashboard 解码器保留该键；文档、宪法与 tenon 技能的处置说明；测试。 (build) `task:4.15` | — | — | 未覆盖 |
| 就绪预审加固：回规格出路按计划写明两步路径（CLI 与 Dashboard 拒绝文案同改）；发现摘要去掉控制字符与双向字符、历史行带摘要；有链头缺读取依赖时报错；Dashboard 读不出冻结清单时拒绝；「删标记、重跑不清零」集成测试。 (build) `task:4.16` | — | — | 未覆盖 |
| oracle 夹具 `default-effects` 适配验证轮次上限：把「提交后验证被屏障拒绝」挪到第 1 轮，两轮走完 A–F 六个场景（验证轮次上限第 1 轮发现，用户决定调高到 2 修复）。 (build) `task:4.17` | — | — | 未覆盖 |
| 本任务设 `max_rounds 1`（用户决定「这轮修完就停」），确认 `status --json` 显示当前轮次与上限。 (build) `task:4.18` | — | — | 未覆盖 |
| 第四轮验证评审修复：手动 acknowledge 判定拆到 `hooks/lib/` 按需加载；`--delegated` 只认未被带空白的引号包住的词；`review` 与子命令之间夹带值选项不再断链；花括号步长写法失败关闭、补常见包装器。 (build) `task:4.19` | — | — | 未覆盖 |
| tools/test-hooks.sh 与相关 vitest 全过，两会话场景手工复现不再互锁。 (verify) `task:5.1` | — | — | 可选 |
| 提交交付物，并用 `tenon setup --claude --from-source .` 把本机切到源码开发安装。 (ship) `task:6.1` | — | — | 可选 |
| 处理已污染状态：给 setup-host-agents-step-progress 的历史追加更正事件，撤销它误记的规格批准。 (ship) `task:6.2` | — | — | 可选 |
| 归档变更；之后恢复 unify-stage-skill-canvas 并补加载调研技能。 (archive) `task:7.1` | — | — | 可选 |

### 套件
| 套件 | 种类 | 结果 | 用例 | 覆盖率 | 运行 |
| --- | --- | --- | --- | --- | --- |
| 适配器 conformance `adapters` | integration | 通过 | 397/397 | — | `20261010T011023Z-ee77af` |
| 单测 · dashboard-app `dashboard-app-unit` | unit | 通过 | 1874/1874 | — | `20261010T011023Z-ee77af` |
| 单测 · docs-site 脚本 `docs-site-unit` | unit | 通过 | 2/2 | — | `20261010T011023Z-ee77af` |
| hook 脚本 `hooks` | integration | 通过 | 2124/2124 | — | `20261010T011023Z-ee77af` |
| 主规格迁移原子 CAS `migration-cas` | integration | 通过 | 13/13 | — | `20261010T011023Z-ee77af` |
| golden oracle 双跑 `oracle` | regression | 通过 | 105/105 | — | `20261010T011023Z-ee77af` |
| golden oracle harness 契约 `oracle-unit` | unit | 通过 | 16/16 | — | `20261010T011023Z-ee77af` |
| 单测 · tools 脚本 `tools-node` | unit | 通过 | 212/212 | — | `20261010T011023Z-ee77af` |
| 单测 · packages `unit` | unit | 通过 | 10597/10615 (18 skip) | — | `20261010T011023Z-ee77af` |

### 仍挡出口的项
- [waiver-unapproved] 测试 代码规模（code-size） 失败（metric-threshold），豁免尚未经评审批准 → `tenon review request fix-hook-cross-session-isolation --event verify-pass`
<!-- tenon:test-report:end -->
