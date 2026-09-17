# GUARD-RULES — 老内核 guard 全量校验面盘点（BACKLOG #12 审计对照物）

> 真相源（老仓 `/Users/a1234/Documents/code-manager/projects/workflow-plugin`，严格只读）：
> - **G** = `skills/pipeline/scripts/pipeline-guard.sh`（相位决策编排 + 显式步）
> - **L** = `skills/pipeline/scripts/pipeline-guard-lib.sh`（谓词原语：yaml_get/file_nonempty/tasks_*/coverage_*）
> - **M** = `skills/pipeline/manifest.yaml`（`phases.*.exit_checks` 数据表，S4 起为 guard case 块的单一真相源）
>
> 移植落点：`guard.ts::evaluateGuard(state, ctx?: GuardContext)`。纯字段规则无条件评估；
> 文件类规则仅在 `ctx` 注入了对应能力（fileExists / fileNonempty / readFile / dirExists /
> changeArchived + changeDirRel）时评估，**未注入 → 静默跳过**（保持 guardCheck(state) 纯函数
> 调用面 = 原 lite 子集，向后兼容；老仓无「无文件系统」模式，此为新仓构造性选择，见 §7）。
>
> **2026-07-17 G2-P0 刻意偏离**：下表 O5/S2/S3/V5/V6/P4 六条的「track/preset 条件」列记录的
> 是**老仓**的白名单语义（`tracks=backend,frontend`——chat 与未知 track 被豁免）。lite 自
> P0 起改为 `when: NON_PM`（`track-not-in: ['pm']`）谓词——chat/未知 track/空 track 也适用
> 这些规则，与 transition 强制层（`checkDefaultEventPreconditions` / DefaultEventPolicy 的同名校验）口径对齐，消灭
> 「advisory 说行、enforcement 说不行」的既有撕裂（guard.ts 文件头同款记录；一致性矩阵测试
> 钉在 guard.test.ts）。`tracks=pm` 各行（V7/P2/P3）语义未变（lite 为 track-in:['pm']）。
> 本表其余内容仍是对老仓的忠实盘点，不随 lite 演进改写。

## 0. 全局前置闸（相位无关）

| # | 规则 | 老仓行号 | 老仓行为 | 移植 |
|---|---|---|---|---|
| GG1 | change-name 非空 / `^[a-zA-Z0-9_-]+$` / 禁 `..` | G31-45 | HARD STOP exit 1 | CLI 层 `paths.isValidChangeName`（cmdCheck 已有，exit 1）|
| GG2 | phase 必须在 manifest.phases 枚举内 | G127-135 | HARD STOP exit 1 | `evaluateGuard` 返回「未知 phase」failure（cmdCheck exit **2**，差异见 §7）|
| GG3 | phase=build 且 `automation=queued` 且非调度器（`TENON_AUTOMATION_RUNNER!=1`）→ 拦下主线 build | G154-162 | HARD STOP exit 1 | ✅ 纯字段规则，无条件评估；`ctx.automationRunner=true` 旁路 |
| GG4 | phase=archive 且 change 目录不在活跃区 → 到 `archive/YYYY-MM-DD-<name>` 找 | G141-145 | 静默改道 | ❌ 未移植（lite check 只读活跃目录；归档态 check 需求归 #15/#24）|

## 1. open 出口（G489-495；M146-151）

| # | 规则 | 谓词（L 行号） | track/preset 条件 | 老仓行号 | 移植 |
|---|---|---|---|---|---|
| O1 | `.pipeline.yaml` 存在且非空（"状态文件存在"） | file_nonempty（L32） | 全部 | M147, G339-341 | ✅ ctx.fileNonempty |
| O2 | `proposal.md` 存在且非空 | file_nonempty | 全部 | M148 | ✅ ctx.fileNonempty |
| O3 | `tasks.md` 存在 | test -f（G349-352） | 全部 | M149 | ✅ ctx.fileExists |
| O4 | `tasks.md` 至少 1 个任务（`^- \[[ x]\]` 行计数，**大写 X 不计**） | tasks_at_least（L34-39） | 全部 | M150 | ✅ ctx.readFile |
| O5 | `design.md` 存在且非空 | file_nonempty | tracks=backend,frontend | M151 | ✅ ctx.fileNonempty |
| O6 | mandatory skills 留痕（`opsx:propose\|openspec-propose`） | skill_logged（L92-100） | preset=full 硬卡，否则 WARN | G493, G237-250, M142-143 | ❌ 未移植（证据面依赖 tools_history/skill-tracker，深锚 #18/#21）|

## 2. explore 出口（G497-503；M171-174）

| # | 规则 | 谓词 | 条件 | 老仓行号 | 移植 |
|---|---|---|---|---|---|
| E1 | `.pipeline.yaml` 存在且非空 | file_nonempty | 全部 | M172 | ✅ |
| E2 | `design_doc` 字段非空（空串与 `"null"` 哨兵同空） | yaml_nonempty（L60-65） | 全部 | M173 | ✅ 纯字段（lite 已有）|
| E3 | `design_doc` 指向的文件存在（**路径相对项目根**，非 change 目录） | yaml_file_exists（L67-72） | 全部 | M174 | ✅ ctx.fileExists；字段空时本条也 FAIL（与 E2 双计，老仓同）|
| E4 | mandatory skills（brainstorming/grill 等，分 track） | — | full 硬卡 | G501, M161-164 | ❌ 同 O6 |

## 3. spec 出口（G505-529；M188-192）

| # | 规则 | 谓词 | 条件 | 老仓行号 | 移植 |
|---|---|---|---|---|---|
| S1 | `.pipeline.yaml` 存在且非空 | file_nonempty | 全部 | M189 | ✅ |
| S2 | `plan` 字段非空 | yaml_nonempty | 非 PM track（PM 的 plan 文档由 OpenSpec ledger 约束） | M190 | ✅ 纯字段（lite 已有）|
| S3 | `plan` 指向的文件存在（相对项目根） | yaml_file_exists | 非 PM track | M191 | ✅ ctx.fileExists |
| S4 | `tasks.md` 至少 3 个任务 | tasks_at_least | 全部（含 pm） | M192 | ✅ ctx.readFile |
| S5 | 全栈 Spec 覆盖 gate（M1）：design_doc 的 ```coverage 块逐层判定 | coverage_*（L112-160）、emit_coverage_status（G436-477） | 见下细则 | G510-528 | ✅ ctx.readFile（读 design_doc 内容）|
| S6 | mandatory skills | — | full 硬卡 | G509, M184-187 | ❌ 同 O6 |

### S5 覆盖矩阵细则（照 L112-160 逐字对齐）

- 层序：`L1_api L2_data L3_rules L4_state L5_errors L6_security L7_perf L8_deps L10_terms`（L116）。
- 适用性（L119-141）：backend required = L1/L2/L3/L4/L5/L6/L8，optional = L7/L10；
  frontend required = L4/L5，optional = L1/L3/L6/L7/L8/L10；pm required = L3，optional = L2/L4/L10；
  其余层与**未知 track 全层 = na**（na 层直接 skip，连 🔒 锁也不查——G459）。
- 块状态（L147-155）：design_doc 的 ```coverage 围栏块内 `^<layer>:` 首行取首个字母词，
  `filled|waived|blank` 之外/缺行/文件缺失/字段空 → 一律 `blank`。
- 🔒 锁（L144, G461-469）：`touches:` 行（逗号或空格分隔）含 `auth` → L6_security 必须 `filled`
  （waived/blank 均为 LOCKVIOLATION）；锁违反**任何 preset 都硬拦**。
- 判定（G459-473）：locked 且非 filled → BLOCKED(LOCKVIOLATION)；required 且 blank → BLOCKED；
  waived 对 required 层放行。
- preset 豁免（G512-524）：`hotfix`/`tweak` → required-blank 降级 WARN（文案
  「N 层覆盖留空（已豁免，建议补；🔒 锁不豁免）」），只有 LOCKVIOLATION 计入阻塞；
  其余 preset（含空/未知）全量计数。
- check 文案（G524）：`全栈 Spec 覆盖（N 层阻塞）`；阻塞层明细走 yellow 提示（新仓落 warnings）。

## 4. build 出口（G532-562；M218-222）

| # | 规则 | 谓词 | 条件 | 老仓行号 | 移植 |
|---|---|---|---|---|---|
| B0 | automation=queued 闸（=GG3） | yaml_eq | 非调度器路径 | G154-162 | ✅ |
| B1 | `.pipeline.yaml` 存在且非空 | file_nonempty | 全部 | M219 | ✅ |
| B2 | `tasks.md` 全部勾选（无 `^- \[ \]` 行；**文件缺失 = FAIL**，L41-45） | tasks_all_done | 全部 | M220 | ✅ ctx.readFile |
| B3 | `build_mode` 已设 | yaml_nonempty | 全部 | M221 | ✅（lite 已有）|
| B4 | `isolation` 已设 | yaml_nonempty | 全部 | M222 | ✅（lite 已有）|
| B5 | preset=full 且 build_mode=direct → `direct_override=true` | yaml_eq | 条件步 | G537-542 | ✅ 纯字段 |
| B6 | `depends_on` 逐项：活跃（`openspec/changes/<dep>/` 存在）→ FAIL「必须先归档（当前活跃）」；归档区（`archive/*-<dep>` 目录）无匹配 → FAIL「不存在（既不在活跃也不在归档）」；已归档 → PASS | test -d / find（G544-559） | 值空或 `null` 跳过；逗号分隔、逐项 trim | G544-559 | ✅ ctx.dirExists + ctx.changeArchived（新仓列表字段数组与老式逗号标量都认）|
| B7 | `pre_verify_review_result=pass`：完整 diff、全部 capability 与适用发布门禁已在 Build 内收敛 | yaml_eq | 全部 | Tenon 全局治理新增 | ✅ 纯字段；`spec-complete` / `requirements-changed` / `verify-fail` 重置 `pending` |
| B8 | mandatory skills | — | full 硬卡 | G560 | ❌ 同 O6 |
| B9 | ~~build_sha 非空~~（**lite 投影，非老仓规则**——老仓 build-complete 事件体自动冻结 SHA，guard 出口不查；新仓 transition.ts build-complete 已实现同款自动冻结，故本投影随全量移植**撤销**） | — | — | 老仓无此条 | ↩️ 回对齐老仓 |

## 5. verify 出口（G564-577；M239-247）

| # | 规则 | 谓词 | 条件 | 老仓行号 | 移植 |
|---|---|---|---|---|---|
| V1 | `.pipeline.yaml` 存在且非空 | file_nonempty | 全部 | M240 | ✅ |
| V2 | `verification_report` 字段非空 | yaml_nonempty | 全部 | M241 | ✅（lite 已有）|
| V3 | `verification_report` 文件存在（相对项目根） | yaml_file_exists | 全部 | M242 | ✅ ctx.fileExists |
| V4 | `branch_status=handled` | yaml_eq | 全部 | M243 | ✅（lite 已有）|
| V7 | `verify_result=pass` | yaml_eq | **tracks=pm**（老仓 fe/be 由 verify-pass 事件体落 pass，出口不查） | M246 | ✅ lite 原为全 track（投影），随全量移植**回对齐老仓 pm-only**——新仓 transition.ts verify-pass 已自动 set verify_result=pass |
| V8 | mandatory skills | — | full 硬卡 | G568 | ❌ 同 O6 |
| V9 | 三轨 review 留痕（reviewer agent 8 名任一 + e2e-runner + codex exec 均在 tools_history） | hist_has（L104-110） | pm 跳过；full 硬卡，hotfix/tweak WARN | G569, G257-279 | ❌ 未移植（证据面同 O6；新仓证据存 .pipeline-history.jsonl，读取面归 #18/#21）|
| — | NEXT_EVENT 选择：verify_result=pass 或 0 BLOCK → verify-pass，否则 verify-fail | — | — | G571-576 | ❌ 不适用（新仓 check 不给推进建议，推进权在用户）|

## 6. ship / archive 出口

| # | 规则 | 谓词 | 条件 | 老仓行号 | 移植 |
|---|---|---|---|---|---|
| P1 | `.pipeline.yaml` 存在且非空 | file_nonempty | 全部 | M260 | ✅ |
| P2 | `prd_path` 字段非空 | yaml_nonempty | tracks=pm | M261 | ✅（lite 已有）|
| P3 | `prd_path` 文件存在（相对项目根） | yaml_file_exists | tracks=pm | M262 | ✅ ctx.fileExists |
| P4 | `pr_url` 字段非空 | yaml_nonempty | tracks=frontend,backend | M263 | ✅（lite 已有）|
| P5 | mandatory skills（to-prd / opsx:apply 等） | — | full 硬卡 | G583 | ❌ 同 O6 |
| A1 | `.pipeline.yaml` 存在且非空 | file_nonempty | 全部 | M273 | ✅ |
| A2 | `verify_result=pass` | yaml_eq | 全部 | M274 | ✅（lite 已有）|

## 7. 有意差异 / 未移植面（新仓构造性选择，均记录于验收报告）

1. **exit code 映射**：老 guard 一切阻塞 = exit 1；新仓 check 契约 = 0 过 / 2 不过 / 1 错误
   （CONTRACT §3）。未知 phase 老仓 exit 1（HARD STOP），新仓走 failure → exit 2
   （该值只能由损坏的状态文件产生，老仓自身命令面写不出非法 phase）。
2. **文件类规则的无注入语义**：`guardCheck(state)`（无 ctx）= 纯字段面，文件类规则静默跳过，
   不在 failures 里注水——老仓没有「无 fs」运行模式可对照，选静默跳过以保持 lite 纯函数调用面
   向后兼容；CLI `check` 命令经 `deps.guardCtx` 全量注入后即为老仓全语义。
3. **skill/工具留痕类检查全部未移植**（O6/E4/S6/B8/V8/V9/P5 + recommended WARN G224-234）：
   证据链（PostToolUse skill-tracker → tools_history）在新仓尚不存在（BACKLOG #18/#21），
   且新仓无 `log` 命令可补录——现在移植会把 full preset 永久卡死。留痕面落地后按本表补植。
4. **--preview / --pass / --apply / --json 模式**（G64-105, 182-197, 608-616）：guard 的旁路
   运行模式，不属校验面，未移植（--apply 老仓自身已废弃）。
5. **老 cmd_check ≠ guard**：老 `pipeline-state.sh check <name> <phase>` 是**入相位前置**检查
   （state-fields.sh:466-546，规则约等于「上一相位出口」的弱化子集），guard 是**出相位**校验。
   新仓 `check <name>` 按 CONTRACT 白名单①委托 guardCheck 查当前相位出口。oracle 双跑的 check
   步与老 cmd_check 比 exit 面——fixtures 已按「合规 change」构造使两面一致（见 tools/oracle/fixtures）。
6. **lite 两处投影撤销**（B9/V7）：build_sha 出口必填与 verify_result 全 track 必 pass 是
   lite 早期无 transition 副作用时的补偿；transition.ts 现已逐字实现老仓事件体副作用
   （build-complete 冻结 SHA / verify-pass 落 pass），guard 回对齐老仓原语义。
   CONTRACT §3 白名单④「自动副作用改显式 set」一句已过时（记报告，不改契约文档）。
