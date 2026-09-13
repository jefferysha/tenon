# 真实 Skill 输入输出抽样：对前期方案的校正

日期：2026-09-11。完整阅读 7 个本地 `SKILL.md`，并查看 PDF 附带的标记脚本；仅静态阅读，没有调用这些 skill 或验证宿主运行行为。这是有意选择不同形态的样本，不能据此推算整个技能生态的比例。

**结论：不能把任意现成 skill 当成已有固定文件参数和文件返回值的函数。** 有的提供输出路径模板，有的只有结果类型，有的修改既有文件，有的只要求对话回复，还有的编排其他 skill。增加 manifest 是改造手段，不是从这些原文中自动获得完整契约的既有能力。

## 1. 实际读到了什么

| 样本 | 原文明确的输入与结果 | 建目录时仍不知道的内容 |
| --- | --- | --- |
| [research](/Users/a1234/.agents/skills/research/SKILL.md:6) | 研究问题；使用一手来源；结果写为单个 Markdown 文件并附来源 | 文件名没有规定；位置优先沿用仓库惯例，否则自行选择。还要求后台代理，实际作者未必是加载 skill 的主代理 |
| [code-review](/Users/a1234/.agents/skills/code-review/SKILL.md:17) | 比较基点、HEAD、diff、规则和规格；最后回复 Standards / Spec 两部分结果 | 没有要求生成报告文件；规格来源按上下文查找，用户确认没有规格时可跳过 Spec 审查 |
| [frontend-design](/Users/a1234/.codex/plugins/cache/claude-plugins-official/frontend-design/local/skills/frontend-design/SKILL.md:36) | 需求、受众和项目上下文；先设计计划、自评修订，再写代码 | 没有固定源码路径、文件数量或框架；截图检查取决于环境。不能把计划或 QA 截图擅自定义成必交文件 |
| [trellis-brainstorm](/Users/a1234/Documents/code-manager/projects/tenon-local/.agents/skills/trellis-brainstorm/SKILL.md:44) | 初始需求、仓库事实、用户多轮回答；持续更新任务目录内的 prd.md | 目录由任务创建结果决定；轻量任务可省略 design.md / implement.md；是否准备 JSONL 上下文还取决于后续是否走子代理派发 |
| [pdf](/Users/a1234/.codex/plugins/cache/openai-primary-runtime/pdf/26.909.12148/skills/pdf/SKILL.md:8) | 支持阅读、创建、编辑、表单填写、验证；创建或编辑交付最终 PDF | 问答或无需修改的任务明确不重导出；生成数量、文件名、表单是否保留交互取决于请求。渲染 PNG 默认是 QA 中间文件 |
| [tenon-open](/Users/a1234/Documents/code-manager/projects/tenon-local/skills/tenon-open/SKILL.md:195) | 需求、change、track、workflow 等上下文；按流程初始化、调度产文和登记证据 | 默认文档依赖 openspec-propose；自定义 workflow 按 document contract 决定文档要求，无文档契约的自由 workflow 跳过该登记段 |
| [openspec-propose](/Users/a1234/Documents/code-manager/projects/tenon-local/skills/openspec-propose/SKILL.md:37) | 明确 request / change / track / preset；指定 proposal.md、design.md、tasks.md 及登记命令 | 绝对位置仍需绑定 change；既有文件必须先读取、保留用户内容。输出可能是同一文件的新版本，不一定是创建新文件 |

这 7 个主文件都没有统一的机器可读业务 inputSchema / outputSchema。这不等于它们没有契约信息：自然语言、命令参数、路径模板和宿主约定中均有部分声明，精确程度不同；也不等于其他配套文件中不存在更强的约束。

## 2. 最能检验前期假设的三个案例

### PDF：同一个 skill，输出数量与检查规则都随操作变化

[首次写入前的约定](/Users/a1234/.codex/plugins/cache/openai-primary-runtime/pdf/26.909.12148/skills/pdf/SKILL.md:15)要求在第一条创建或编辑命令前调用标记脚本，传入操作种类、预期数量和格式。只读任务不调用；示例的数量 1 需要按实际请求调整，不能当成 skill 的固定输出数量。

[交互表单与扁平化表单](/Users/a1234/.codex/plugins/cache/openai-primary-runtime/pdf/26.909.12148/skills/pdf/SKILL.md:32)需要不同检查：前者核验字段、值和呈现，后者检查没有残留交互控件，并验证渲染。先识别本次操作才能选验收规则。

[最终引用要求](/Users/a1234/.codex/plugins/cache/openai-primary-runtime/pdf/26.909.12148/skills/pdf/SKILL.md:143)还区分来源文件、最终 PDF、渲染图片和临时脚本。扫描所有新增文件会混入中间结果，也不能把问答任务判成“缺少输出 PDF”。

实际查看 [mark_artifact_operation_started.mjs](/Users/a1234/.codex/plugins/cache/openai-primary-runtime/pdf/26.909.12148/skills/pdf/container_tools/mark_artifact_operation_started.mjs:3)：它校验 create/edit、数量 1–100、格式 pdf；参数非法时设置退出码。这个文件没有登记路径、写入产出物记录或发布事件。宿主是否另行识别该调用不在本次验证范围内，不能仅凭脚本名称宣称已经实现实时产出追踪。

### OpenSpec：路径明确，也不等于文件出现即完成

[openspec-propose 的步骤 3–5](/Users/a1234/Documents/code-manager/projects/tenon-local/skills/openspec-propose/SKILL.md:67)要求先读已有三个文档、保留已有内容、写入当前阶段内容，再检查并登记证据。[文件后续变更](/Users/a1234/Documents/code-manager/projects/tenon-local/skills/openspec-propose/SKILL.md:98)需要重新登记。

这说明可以从此样本提前提取三个文档槽位和相对路径模板，但运行实例还需要 change、已有版本、当前阶段、实际生产者和证据状态。初始化的空壳、修改中的草稿、登记完成的版本不是同一种状态。

父级 [tenon-open 的自定义 workflow 分支](/Users/a1234/Documents/code-manager/projects/tenon-local/skills/tenon-open/SKILL.md:195)又表明，不能把子 skill 的三个输出无条件写成所有 open 节点的固定输出。还必须先确定本次 workflow 采用哪个文档契约。

### Code review：没有文件返回值，且并行性属于执行步骤

[原文流程](/Users/a1234/.agents/skills/code-review/SKILL.md:17)要求先解析比较基点、确认非空 diff、查找规则和规格，然后才派发 Standards 与 Spec 审查，最后聚合为回复。

因此它可部分并行，却不能把所有步骤同时启动；也不能自动补一个 `review.md` 并以缺少该文件判失败。[输出段](/Users/a1234/.agents/skills/code-review/SKILL.md:76)规定的是回复结构，而不是文件路径。

## 3. 必须撤回或收窄的前期假设

1. **“建立技能目录时就能得到完整输入输出文件表”不成立。** 本次能得到的分别是固定路径模板、输出类型、条件输出、既有文件变更、对话结果和工作流状态；缺失信息不能伪装成已定义。
2. **“让模型读一遍就能补齐”不成立。** 模型可以提取已写明的条件和候选约束，但无法从 PDF skill 单独知道用户要生成几份，也无法从 frontend-design 单独知道要改哪几个源码文件。缺少的是本次任务信息，增加解析 token 不会使其出现。
3. **“产出物就是新增文件”不成立。** 样本包括已有文件的新版本、持续更新的 PRD、子 skill 产文、对话审查结果，以及不应交付的 QA 临时文件。
4. **“每个 skill 一组固定检查、一种并行属性”不成立。** PDF 检查依赖操作模式，brainstorm 文档要求依赖任务复杂度和执行方式，code-review 同一次执行内就有前置串行、分支并行、末尾聚合。

## 4. 对用户目标的实际限制

可以争取在一次受管理执行真正开始前，把该次调用的已知输入、预期输出和适用检查展示到 UI；但不能保证在安装任意 skill、尚无具体任务时就知道所有文件。

对本次样本而言，目录阶段可以诚实保存“Markdown 报告，路径待定”“PDF 操作模式待定”“三个 change 文档槽位”等不同完整度的信息。任务选中 skill 后，再根据具体请求、workflow 配置和项目状态补齐。有些分支需要用户回答或前置探查后才能确定；如果要求执行前强约束，就必须提供这一准备阶段，或者把执行拆成可约束的步骤。这是由样本推导的设计要求，不是现有 loader 已经具备的能力。

本次没有评测模型提取准确率、token 费用和端到端耗时，不能给出可靠的自动化成本或覆盖率数字。也没有完整审计宿主的调用追踪机制，不能保证仅靠安装目录监听就能识别所有执行和实际生产者。

## 5. 阅读快照

以下为读取时各主文件的 SHA-256；正文路径指向本地可变化文件，快照用于标明本次研究对象。

| 样本 | 行数 | SHA-256 |
| --- | ---: | --- |
| tenon-open | 245 | `05a5e0322edc9a942c971c8a3287de2e652fbff50c16c05d3eaed943a1fb527b` |
| trellis-brainstorm | 200 | `17d9bf209730c14f584eb97f38198d0683ad3f8da982d9a6e6d4e84c853f9a94` |
| research | 12 | `af378829f015775a3bcd65ff466826722e99359017ae6bae227ca4c9bd14049c` |
| code-review | 89 | `6a65cc61114f96db07ec41e3920e67c9c5bf70dd6e0901eb9460ebcb2bdc209f` |
| frontend-design | 71 | `d91970639e9f5c37682ac7ab60094d35f1c7c1f38d731bd56396563aee10c1d3` |
| pdf | 158 | `65f4a606b5ec8e564d6d9782254b34c2bb2ce0a573e9349fb46b1173449c72fa` |
| openspec-propose | 101 | `5db28f53dae1dc547bcb95199aab15febad3daa660e038ba0a10658f2baae397` |
