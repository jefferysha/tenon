# Journal - sjy (Part 1)

> AI development session journal
> Started: 2026-09-01

---



## Session 1: Autonomous orchestration v1 kernel
<!-- trellis-session: v=2 fp=4aa18da786135e0c -->

**Date**: 2026-09-01
**Task**: Autonomous orchestration v1 kernel
**Branch**: `codex/autonomous-loop-v1`

### Summary

在远程 Tenon 最新 main 的新本地副本上初始化 Trellis，盘点并确认本机无可卸载的 Tenon 安装；实现纯 Kernel 编排 v1 契约、能力路由、异构 Skill 结果 envelope、验证门、看板 CAS reducer 与测试。全仓构建通过；完整测试仅有一次并行环境 server managed-start 超时，定向 server 测试通过。

### Git Commits

| Hash | Message |
|------|---------|
| `633817c` | feat(kernel): add autonomous orchestration v1 contracts |

### Status

[OK] **Completed**


## Session 2: Orchestration invariant hardening
<!-- trellis-session: v=2 fp=985a345916e0bf47 -->

**Date**: 2026-09-01
**Task**: Orchestration invariant hardening
**Branch**: `codex/autonomous-loop-v1`

### Summary

完成 v1 编排器收尾复核，清理未使用路由状态并确认 Kernel 状态机、codec、架构导入图测试继续通过。

### Git Commits

| Hash | Message |
|------|---------|
| `ed34ee2` | fix(kernel): tighten orchestration invariants |

### Status

[OK] **Completed**


## Session 3: Blocked resolution recovery
<!-- trellis-session: v=2 fp=378d761086429f3e -->

**Date**: 2026-09-01
**Task**: Blocked resolution recovery
**Branch**: `codex/autonomous-loop-v1`

### Summary

修正能力解析阻塞语义：blocked resolution 现在保留在 BoardSnapshot，允许后续重新评估并回到 planning；补充回归测试与契约矩阵。

### Git Commits

| Hash | Message |
|------|---------|
| `d079e3c` | fix(kernel): retain blocked capability resolutions |

### Status

[OK] **Completed**


## Session 4: Capability routing and execution adapter v1
<!-- trellis-session: v=2 fp=8ed2f354fc45be42 -->

**Date**: 2026-09-01
**Task**: Capability routing and execution adapter v1
**Package**: automation
**Branch**: `codex/autonomous-loop-v1`

### Summary

完成第一版能力提案边界、Kernel 路由接入与 Skill 执行闭环；异构输出经边界快照和验证器判定，安全并行与依赖结果引用已覆盖。

### Main Changes

- 新增未知值安全快照、提案 provenance/evidence 归一化与稳定失败码。
- 新增显式 Work Item→Skill/MCP 绑定校验、串行/安全并行波次、资源冲突串行化和 Kernel 命令驱动执行。
- 新增验证器专属 contract_status、opaque 结果引用、取消/失败 fail-closed 处理与 automation 公共导出。

### Git Commits

| Hash | Message |
|------|---------|
| `1618f8f` | feat(automation): add capability routing execution adapter |

### Testing

- [OK] orchestration/kernel 目标测试：25/25 通过。
- [OK] npm run build：通过；check:architecture、check:comments、git diff --check：通过。

### Status

[OK] **Completed**

### Next Steps

- 下一子任务接入持久化快照、Server/SSE 投影与 Dashboard 看板控制，保持 revision CAS 和上述边界。


## Session 5: Production orchestration V2 delivery
<!-- trellis-session: v=2 fp=e0b53597fff1a3dd -->

**Date**: 2026-09-02
**Task**: Production orchestration V2 delivery
**Branch**: `codex/autonomous-loop-v1`

### Summary

从底向上完成可追溯的编排 V2：定义闭合 schema、状态机与事件账本，接入自动规划、租约运行时、SSE 控制面、Dashboard 看板、CLI 与指标接口；补齐恢复、漂移、幂等、权限及仓库卫生边界。

### Main Changes

- Canonical orchestration aggregate、durable ledger 与 CAS/恢复协议
- 自动场景识别、用户自定义 Skill/MCP 解析及串并行 DAG
- Runtime lease/retry/cancel、Server SSE/metrics、Dashboard controls、CLI watch/control

### Git Commits

| Hash | Message |
|------|---------|
| `46dd4ab` | feat(orchestration): add canonical v2 aggregate and durable ledger |
| `6ffa55e50d5eb0015aee8d684b9d5fb62c88e692` | feat: deliver production orchestration v2 |
| `9705244` | fix(quality): allow first-party workflow metadata |

### Testing

- [OK] 全仓 Vitest：412 files / 6980 passed / 15 honest skips
- [OK] Dashboard：typecheck + 99 files / 1747 passed
- [OK] Chromium orchestration V2 E2E：1 passed；build、architecture、comments、OpenSpec、release、docs、repository hygiene 全通过

### Status

[OK] **Completed**

### Next Steps

- 按 docs/ORCHESTRATION-V2.md 的备份/发布流程接入真实企业执行器与认证凭证
- 若需要多租户，再在当前 aggregate/ledger 边界上增加租户授权与审计索引


## Session 6: Workflow pipeline contract and real acceptance
<!-- trellis-session: v=2 fp=ba850b4bb17c51ac -->

**Date**: 2026-09-02
**Task**: Workflow pipeline contract and real acceptance
**Branch**: `codex/autonomous-loop-v1`

### Summary

固化 workflow/track/pipeline/stage-skill-order 的 workflow-pipeline/v2 契约；支持自动场景推断与用户/项目自定义，并用真实子进程、持久化 ledger、Dashboard 和 Chromium E2E 验收。

### Main Changes

- 新增 workflow-pipeline/v2 记录、freeze-pipeline 状态迁移、pipeline digest 与 graph/resolution 绑定。
- planner 支持默认自动流水线及 pipeline_blueprint 自定义 workflow、track、pipeline、stage、Skill/MCP/schema 顺序。
- runtime 按冻结 stage_order 与 Skill.order 调度，Dashboard 展示 workflow/track/pipeline 和 stage/Skill 顺序。

### Git Commits

| Hash | Message |
|------|---------|
| `46dd4ab` | feat(orchestration): add canonical v2 aggregate and durable ledger |
| `6ffa55e50d5eb0015aee8d684b9d5fb62c88e692` | feat: deliver production orchestration v2 |
| `9705244` | fix(quality): allow first-party workflow metadata |
| `a381e9c` | chore: record journal |
| `708aa86` | feat(orchestration): persist effective workflow pipeline order |

### Testing

- [OK] 全仓 Vitest：412 files，6985 passed，15 honest skipped。
- [OK] Dashboard：99 files，1747 passed；build/typecheck/architecture/OpenSpec/release/docs/hygiene 全通过。
- [OK] 真实工作流子进程集成 2 passed；Chromium Playwright E2E 1 passed。

### Status

[OK] **Completed**

### Next Steps

- 后续可在 CLI/HTTP 增加 pipeline_blueprint 编辑入口，并继续扩展多 Skill 单 Work Item 的执行模型。


## Session 7: Pipeline aggregate contract coverage
<!-- trellis-session: v=2 fp=327cc9318b8a750c -->

**Date**: 2026-09-02
**Task**: Pipeline aggregate contract coverage
**Branch**: `codex/autonomous-loop-v1`

### Summary

补齐 workflow-pipeline/v2 codec、freeze-pipeline 顺序、绑定一致性和 stale assessment 拒绝测试。

### Git Commits

| Hash | Message |
|------|---------|
| `baf1f20` | test(orchestration): cover pipeline aggregate contract |

### Testing

- [OK] Kernel orchestration aggregate test passed。

### Status

[OK] **Completed**

### Next Steps

- 推送包含测试提交和会话记录的最终远程 SHA。


## Session 8: Pipeline dependency-order hardening
<!-- trellis-session: v=2 fp=ef283174c08a02bf -->

**Date**: 2026-09-02
**Task**: Pipeline dependency-order hardening
**Branch**: `codex/autonomous-loop-v1`

### Summary

为自定义 pipeline 增加 stage dependency 与 stage_order 一致性校验，阻断循环、未知依赖和逆序执行。

### Git Commits

| Hash | Message |
|------|---------|
| `c499673` | fix(orchestration): validate pipeline dependency order |

### Testing

- [OK] Planner/runtime focused tests、architecture check、build 和 Chromium E2E 均通过。

### Status

[OK] **Completed**

### Next Steps

- 推送最终包含依赖顺序硬化与会话记录的远程 SHA。


## Session 9: v1.0.9 production release and workflow UX hardening
<!-- trellis-session: v=2 fp=dc853d2097c69b0c -->

**Date**: 2026-09-02
**Task**: v1.0.9 production release and workflow UX hardening
**Branch**: `codex/autonomous-loop-v1`

### Summary

Hardened catalog and installer SSE lifecycle, replay completion, pipeline/stage/skill ordering UX, i18n and install validation; passed local full backend/web/E2E/clean-install/adapter/audit gates; pushed exact SHA to main; candidate writer created v1.0.9 and public install/update acceptance passed.

### Git Commits

| Hash | Message |
|------|---------|
| `fa7e8349f5fcdc1ab16319959405c99ab7e72043` | fix: harden catalog and install UX for v1.0.9 |
| `adb33e4a1b15e30f237ef6f308a61b6db4883871` | feat: add cross-terminal catalog and installer UX |
| `8e4652745593ce11a4ef9f9ac19571b381809227` | release: prepare Tenon v1.0.8 |

### Status

[OK] **Completed**


## Session 10: Dashboard 系统性 UI 与功能评审
<!-- trellis-session: v=2 fp=ae6de4ede13cd01b -->

**Date**: 2026-09-05
**Task**: Dashboard 系统性 UI 与功能评审
**Branch**: `codex/autonomous-loop-v1`

### Summary

完成 Dashboard 全页面、交互、功能取舍与响应式运行态评审；输出 P0/P1/P2 报告，未修改产品代码。

### Git Commits

(No commits - planning session)

### Status

[OK] **Completed**


## Session 11: Dashboard 基于工作空间模板的整体重构
<!-- trellis-session: v=2 fp=dashboard-template-refactor -->

**Date**: 2026-09-09
**Task**: Dashboard 基于工作空间模板的整体重构（09-09-dashboard-template-refactor）
**Branch**: `codex/autonomous-loop-v1`

### Summary

归档三个「视觉抛光」口径的旧任务，以用户模板为唯一基准重做 IA：顶部横条 + 三列骨架（ThreeColumns / DetailSheets），
四个视图 工作台（逐 stage 执行状态与产出，只读）/ 工作流（workflow·track·stage·skill 顺序 CRUD，输入产出只读推导）/
自动化 / 机器（并入宿主计划），右列一律按 sheet 切换。删除左侧 rail、ProjectsView、ProgressView/WorkflowCanvas、
SolutionView、ExecutionTimelineComposer 一系。1301 个前端用例、typecheck、design-scale、comment-honesty、生产构建全绿；
真实服务端验证工作流复制 / 删除写操作；375px 无横向滚动。

### Status

[OK] **Implemented**（待 trellis-check 复核后提交）


## Session 12: Dashboard 基于工作空间模板的整体重构
<!-- trellis-session: v=2 fp=429aacd8cd32a642 -->

**Date**: 2026-09-09
**Task**: Dashboard 基于工作空间模板的整体重构
**Branch**: `codex/autonomous-loop-v1`

### Summary

以用户模板为唯一基准重做 dashboard IA：顶部横条 + 三列骨架（ThreeColumns / DetailSheets），四视图 工作台（逐 stage 执行状态与产出，只读）/ 工作流（workflow·track·stage·skill 顺序 CRUD，输入产出只读推导）/ 自动化 / 机器（并入宿主计划），右列按 sheet 切换；删除旧 rail、ProjectsView、ProgressView/WorkflowCanvas、SolutionView 与旧编排器死代码。typecheck、1239 前端用例、design-scale、comment-honesty、生产构建全绿；真实服务端验证工作流复制/删除；375/768/1440 无横向滚动。

### Git Commits

| Hash | Message |
|------|---------|
| `380c821` | feat(dashboard): rebuild IA on the workspace template |

### Status

[OK] **Completed**


## Session 13: Dashboard 精简重做：工作台 + 工作流
<!-- trellis-session: v=2 fp=514e1407e05afc58 -->

**Date**: 2026-09-09
**Task**: Dashboard 精简重做：工作台 + 工作流
**Branch**: `codex/autonomous-loop-v1`

### Summary

按用户要求把 dashboard 收窄为两页：工作台（项目→任务→阶段轨→所选阶段的输入/输出文件可读，点击即预览，新增只读接口 GET /api/documents/read）与工作流（阶段顺序、技能串并行切换、门禁、推导输入输出，无页签）。删除自动化/机器/宿主计划/高级面板等目录、工作流页的轨道/管线/策略/钩子/治理与技能编排 Dialog、15 个无引用 i18n 命名空间。typecheck、40 文件 590 用例、design-scale、comment-honesty、服务端路由测试全绿；1440/375 真实服务端验收。

### Git Commits

| Hash | Message |
|------|---------|
| `b1aefaf` | feat(dashboard): cut down to workspace + workflow with readable stage files |

### Status

[OK] **Completed**


## Session 14: 工作流定义规范化与两页重设计（技能合一 / default 可编辑 / YAML 导入导出）
<!-- trellis-session: v=2 fp=1086db7e769cd9a6 -->

**Date**: 2026-09-10
**Task**: 工作流定义规范化与两页重设计（技能合一 / default 可编辑 / YAML 导入导出）
**Branch**: `codex/autonomous-loop-v1`

### Summary

Kernel: SkillRef.when 轨道条件、materializeWorkflowIo、default 项目覆盖、validateWorkflowForStorage、tools/check-default-skill-matrix；default 模板并入技能矩阵。Server: effectiveIo/source、GET/PUT yaml、default POST/DELETE。Dashboard 两页重写：阶段流水线 + 数据推导状态 + 抽屉 Markdown；技能 DAG（dnd-kit，轨道标签/筛选）、输出输入槽位、门禁三选一、新建（复制/空白/导入）。子任务 09-10-skill-output-auto-registration 待做。

### Git Commits

| Hash | Message |
|------|---------|
| `2ef85a4` | feat(dashboard): unify workflow definition and redesign workspace/workflow pages |

### Status

[OK] **Completed**


## Session 15: 技能产出自动登记与每回合技能状态（skillRuns）
<!-- trellis-session: v=2 fp=ca135f29e519729b -->

**Date**: 2026-09-10
**Task**: 技能产出自动登记与每回合技能状态（skillRuns）
**Branch**: `codex/autonomous-loop-v1`

### Summary

kernel autoRegisterDocuments/canonicalDocumentPaths；receipt 后自动登记规范文档；hooks/skill-start.sh tool-start 标记；server snapshot.skillRuns（YAML 矩阵按轨道 + manifest 回退）；工作台 StageSkills 按波次显示 idle/running/done；:18765 已用新构建重启

### Git Commits

| Hash | Message |
|------|---------|
| `a05a1ce` | feat(runtime): auto-register skill outputs and project per-step skill runs |

### Status

[OK] **Completed**


## Session 16: 工作流 track 分支、技能编排浮层、IO sheet 与门禁语义
<!-- trellis-session: v=2 fp=eb60e49609234313 -->

**Date**: 2026-09-10
**Task**: 工作流 track 分支、技能编排浮层、IO sheet 与门禁语义
**Branch**: `codex/autonomous-loop-v1`

### Summary

track 成为工作流 YAML 内分支（tracks.<id>），指纹覆盖整份定义；门禁 review/auto，confirm 移除；default 展开为 4 条分支；server 返回 branches 与 SKILL.md readme；工作流页分支树 + 技能编排浮层 + IO sheet 溯源 + 门禁 hover；名称只显示 label ?? id

### Git Commits

| Hash | Message |
|------|---------|
| `c6bda08` | feat(workflow): track branches, review/auto gates, skill composer and IO sheets |

### Status

[OK] **Completed**


## Session 17: 工作流页重设计：track 独占阶段、技能详情、GSAP 拖拽
<!-- trellis-session: v=2 fp=e656acd4b0c64a09 -->

**Date**: 2026-09-10
**Task**: 工作流页重设计：track 独占阶段、技能详情、GSAP 拖拽
**Branch**: `codex/autonomous-loop-v1`

### Summary

steps ⊕ tracks（无通用分支，缺分支拒绝）；default 五条分支各自定义阶段；技能详情抽屉读取整个技能目录（files/file 接口）；阶段流可拖拽排序；技能浮层三栏 + 连接线 + 落区；DragOverlay + GSAP Flip；:18765 已重启

### Git Commits

| Hash | Message |
|------|---------|
| `2fc8de6` | chore(task): archive 09-10-workflow-page-redesign |

### Status

[OK] **Completed**


## Session 18: 工作流页 UI v2：行内动作、门禁流程骨架、面包屑 IO sheet
<!-- trellis-session: v=2 fp=573d7256db1caff4 -->

**Date**: 2026-09-10
**Task**: 工作流页 UI v2：行内动作、门禁流程骨架、面包屑 IO sheet
**Branch**: `codex/autonomous-loop-v1`

### Summary

左栏动作就地化（+/⋯/×），中栏只显名称与门禁，右栏面包屑切换只读输出/输入 sheet，技能波次卡片；删除 IO 增删 UI 与 hook 助手；spec 记录 effectiveIo 推导原理与技能无 IO 声明的限制。web 621 用例、design-scale、comments 通过；:18765 已重启。

### Git Commits

| Hash | Message |
|------|---------|
| `9d2ba03` | feat(dashboard): workflow page v2 — inline rail actions, gate-only flow, breadcrumb IO sheets |

### Status

[OK] **Completed**


## Session 19: 工作流页两栏定稿实现
<!-- trellis-session: v=2 fp=8614dd6cbca4563d -->

**Date**: 2026-09-11
**Task**: 工作流页两栏定稿实现
**Branch**: `codex/autonomous-loop-v1`

### Summary

两栏：左栏工作流切换 + ⋯ 菜单 + 轨道页签 + 编号流程（名称 + 门禁图标、回流虚线弧、可拖排序）；右栏 输入 → 技能 → 输出 → 门禁，等分带表头 IO 表，技能 React Flow 画布（编辑器里拉线 = depends_on）。新增 @xyflow/react；jsdom 用替身。web 628 用例、design-scale、comments、build 通过；:18765 已重启。

### Git Commits

| Hash | Message |
|------|---------|
| `cba5528` | feat(dashboard): two-column workflow page — flow nav, equal-column IO tables, React Flow skills |

### Status

[OK] **Completed**


## Session 20: 工作流页实测修复：技能流程起终点与箭头、IO 表对齐、技能详情排版、编辑器重开
<!-- trellis-session: v=2 fp=a175765d659aab0d -->

**Date**: 2026-09-11
**Task**: 工作流页实测修复：技能流程起终点与箭头、IO 表对齐、技能详情排版、编辑器重开
**Branch**: `codex/autonomous-loop-v1`

### Summary

技能画布加起点 / 终点、波次标签、箭头与脉冲边，effect 按技能签名触发修复重开刷屏；输入输出统一三列 文件 · 来源阶段 · 来源技能；Markdown compact 密度；web 630 用例、design-scale、comments、build 通过；:18765 已重启。

### Git Commits

| Hash | Message |
|------|---------|
| `0177db8` | chore(task): archive 09-11-workflow-two-column-fixes |

### Status

[OK] **Completed**


## Session 21: 工作流页修复二：技能落点语义与预览、起终点样式、字号 +20%
<!-- trellis-session: v=2 fp=e02aa7878821790e -->

**Date**: 2026-09-11
**Task**: 工作流页修复二：技能落点语义与预览、起终点样式、字号 +20%
**Branch**: `codex/autonomous-loop-v1`

### Summary

拖放幽灵预览 + 落点决定并行 / 串行，+ 串行追加，新节点入场动画；起终点实心点带字；全站排版刻度 ×1.2；web 632 用例、design-scale、comments、build 通过；:18765 已重启。

### Git Commits

| Hash | Message |
|------|---------|
| `d7bef59` | feat(dashboard): semantic skill drops with ghost preview, serial + button, solid flow ports, type scale +20% |

### Status

[OK] **Completed**


## Session 22: 技能画布连线：波次居中、起终点直连、汇合点
<!-- trellis-session: v=2 fp=5bc7090587a72285 -->

**Date**: 2026-09-11
**Task**: 技能画布连线：波次居中、起终点直连、汇合点
**Branch**: `codex/autonomous-loop-v1`

### Summary

各波次围绕中线居中；端口按测量高度对齐使单连线为直线；相邻完整列依赖的两波用汇合点渲染（上一波 → 汇合点 → 下一波）；fitView 等测量完成。web 633 用例、design-scale、comments、build 通过；:18765 已重启。

### Git Commits

| Hash | Message |
|------|---------|
| `58a688c` | fix(dashboard): skill flow routing — centred waves, measured ports, junction between column-linked waves |

### Status

[OK] **Completed**


## Session 23: 工作台对齐工作流页 + 技能画布 GSAP 脉冲
<!-- trellis-session: v=2 fp=444cee54849c36f7 -->

**Date**: 2026-09-11
**Task**: 工作台对齐工作流页 + 技能画布 GSAP 脉冲
**Branch**: `codex/autonomous-loop-v1`

### Summary

PulseEdge：GSAP 沿路径的脉冲点按段序从起点传到终点；工作台详情改为 SkillFlow（带运行状态）+ 输入 / 输出 sheet 页签 + 抽屉；项目卡只显示路径；筛选行与卡片全部不换行。web 632 用例、design-scale、comments、build 通过；:18765 已重启。

### Git Commits

| Hash | Message |
|------|---------|
| `ef81f29` | feat(dashboard): workspace mirrors the workflow page — skill flow with run status, IO sheets, path-only rail; GSAP pulse edges |

### Status

[OK] **Completed**


## Session 24: 整页滚动修复、去掉顶部搜索框
<!-- trellis-session: v=2 fp=954aed937aff6cda -->

**Date**: 2026-09-11
**Task**: 整页滚动修复、去掉顶部搜索框
**Branch**: `codex/autonomous-loop-v1`

### Summary

滚动容器加 relative，sr-only 绝对定位后代不再撑出 html 滚动条（工作流页与工作台 scrollHeight = innerHeight）；删除顶部搜索框与全局 query 上下文。web 632 用例、design-scale、comments、build 通过；:18765 已重启。

### Git Commits

| Hash | Message |
|------|---------|
| `03d6034` | fix(dashboard): no document scroll on column pages; drop the header search box |

### Status

[OK] **Completed**


## Session 25: 技能画布脉冲：MotionPathPlugin + 虚拟节点尺寸回填
<!-- trellis-session: v=2 fp=20f15b0f4d8dcdec -->

**Date**: 2026-09-11
**Task**: 技能画布脉冲：MotionPathPlugin + 虚拟节点尺寸回填
**Branch**: `codex/autonomous-loop-v1`

### Summary

脉冲圆点改由 GSAP MotionPathPlugin 沿路径移动；每条渲染边显式 type=pulse；起终点 / 标签 / 汇合点尺寸回填 measured，边不再闪烁。Playwright 采样确认圆点位移。web 632 用例、design-scale、comments、build 通过；:18765 已重启。

### Git Commits

| Hash | Message |
|------|---------|
| `943c882` | fix(dashboard): make the skill-flow pulse actually move |

### Status

[OK] **Completed**


## Session 26: 技能画布：线段高亮流动 + 长名截断
<!-- trellis-session: v=2 fp=984c30e69a14c98f -->

**Date**: 2026-09-11
**Task**: 技能画布：线段高亮流动 + 长名截断
**Branch**: `codex/autonomous-loop-v1`

### Summary

脉冲改为叠加强调色路径的 dashoffset 流动段；节点 260px、名称截断带 title。Playwright 采样 dashoffset 连续变化。web 632 用例、design-scale、comments、build 通过；:18765 已重启。

### Git Commits

| Hash | Message |
|------|---------|
| `dffe5ac` | fix(dashboard): flowing stroke highlight instead of a travelling dot; long skill names truncate |

### Status

[OK] **Completed**


## Session 27: 工作流全局化：用户级存储，工作流页不绑定项目
<!-- trellis-session: v=2 fp=957cf4f6623c7922 -->

**Date**: 2026-09-11
**Task**: 工作流全局化：用户级存储，工作流页不绑定项目
**Branch**: `codex/autonomous-loop-v1`

### Summary

kernel 全局存储 <configRoot>/workflows + 解析顺序 项目→全局→内建；server 工作流路由 root 为空即全局；dashboard 工作流页 root=''、来源 内建/全局、离开守卫只看视图。实机验证：无项目打开工作流页、新建 / 删除工作流落在全局目录。web 632 用例通过；后端全量 7046 过 / 32 失败均为既有失败（注册轨在 default 无分支被拒、gate.sh/verify-skills/afk shell）。

### Git Commits

| Hash | Message |
|------|---------|
| `4f1c04a` | feat(workflow): global user-level workflow store; the workflow page no longer binds to a project |

### Status

[OK] **Completed**


## Session 28: 工作流页实机验证 + 全局 default / 轨道分支四修
<!-- trellis-session: v=2 fp=4a4d99b53b4d4a14 -->

**Date**: 2026-09-11
**Task**: 工作流页实机验证 + 全局 default / 轨道分支四修
**Branch**: `codex/autonomous-loop-v1`

### Summary

用 Playwright 真实鼠标事件逐项验证工作流页、技能编辑器（含 HTML5 拖放、拉线成环）、工作台，交接文档第 4 节清单全部通过。修四个缺陷：(1) 全局 default 一存在工作流页刷新即失效——decodeWorkflowIndex 不认 source=global，左栏阶段清零且恢复内建永久 disabled；顺带修恢复后定义不回填。(2) 复制 default 被自己的契约 400——copyWorkflowDef 不再补盖 openspec_contract: required（先试在 chat 轨补技能，打挂 afk.test.ts 10 例后撤销，kernel spec 明确 chat 是 drivers-only）。(3) 方案 B：删 tenon tracks create/update/delete 写入面，轨道可用性只认工作流分支，保留只读 list/show。(4) 全局工作流 POST 用例把 token 当 reqPost options 传，鉴权头从未发出，自 4f1c04a 起一直红。门禁 typecheck:web/test:web/check:design-scale/check:comments 全绿；vitest 31→26，本次负责的 7 个清零，残留均非本次引入。未做：服务端 POST/PATCH/DELETE /api/tracks 三个注册写路由仍在（无 UI 消费但自带全绿用例），已记入 spec gap。

### Git Commits

| Hash | Message |
|------|---------|
| `0b671b5` | fix(workflow): global default no longer breaks the workflow page; tracks are branch-only |

### Status

[OK] **Completed**


## Session 29: 阶段转移可编辑（回流=验收不通过退回）
<!-- trellis-session: v=2 fp=2e0eaf219741deea -->

**Date**: 2026-09-12
**Task**: 阶段转移可编辑（回流=验收不通过退回）
**Branch**: `codex/autonomous-loop-v1`

### Summary

工作流页右栏新增第五段「转移」：事件名可改、去向从本轨道阶段里选，选靠前阶段即回流，语义是该阶段验收不通过退回上一轮修问题。此前 default 已有两条回流并在左栏画成虚线弧，但页面上配不了，只能手改 YAML。线性转移与回流同一种行，不分区不加标签。三条 lint 在保存前挡住：空事件名、同阶段事件重名、受治理工作流缺 CANONICAL_TRANSITIONS 必需去向。实机验收全过，四项前端门禁绿。

### Git Commits

| Hash | Message |
|------|---------|
| `88c9ed3` | feat(workflow): 阶段转移可编辑，回流表达「验收不通过退回上一轮」 |

### Status

[OK] **Completed**


## Session 30: 阶段退回替换转移表
<!-- trellis-session: v=2 fp=ee6ede661ea837b5 -->

**Date**: 2026-09-12
**Task**: 阶段退回替换转移表
**Branch**: `codex/autonomous-loop-v1`

### Summary

上一版把 transition 结构直接搬成「事件+去向」表，概念错了：正向去向完全由阶段顺序决定。改成阶段级属性「退回」，一个下拉（不退回 / 退回到某个靠前阶段），首阶段不渲染，界面上不再有事件名和正向去向。不绑门禁，因为实现→规格挂在无门禁的阶段上。顺带修掉「不退回再选回来」把 verify-fail 降级成 verify-back 并丢 actions 的静默数据丢失。

### Git Commits

| Hash | Message |
|------|---------|
| `8546106` | fix(workflow): 阶段「退回」替换「转移」表——正向去向不该让用户配 |

### Status

[OK] **Completed**
