# 设计

完整设计见 `docs/superpowers/specs/rework-document-mechanism-design.md`（决策、交互问答、模块与接缝、测试、风险），决定摘要见 `docs/adr/rework-document-mechanism.md`。本文只列调研步定下的要点。

## 决策

- **观察而非声明**：进入步骤访问时记 git 检查点（HEAD + 相对 HEAD 的改动文件与 sha256，`git --no-optional-locks status`，尊重 `.gitignore`）；离开时在转换的锁内、提交之前比较，得到新增 / 修改 / 删除。HEAD 移动只算本任务自己的提交（`--not` 上游引用），rebase 带进来的上游改动不算。Tenon 状态、主机集成目录、其他任务目录不观察。非 git 或失败记 `unavailable`，不阻断。
- **来源标注**：本次访问里加载时间不晚于文件修改时间的最后一个技能（排除 `tenon`），没有记「未知」；hook 只提供时间，不登记产出。
- **交接**：只把直接上游那次访问产出的文档（`.md` / `.mdx` / `.markdown`）交给当前步骤；离开这一步的所有边（终止除外）都要求读完，回执摘要等于上游摘要或当前摘要都算读过。
- **门禁**：新守卫 `required-output`（路径模式，`{change}`、`*`、`**`、`?`）；本任务里这一步产出过匹配文件且文件仍在才放行，观察不可用时退化为存在检查。
- **内建工作流**：删除 `document_contract` 与步骤 `inputs` / `outputs` / `artifacts`；重型轨道立项要 proposal、调研要设计文档、规格要 delta spec（前端、后端另要计划）、验证通过要验证报告，全部按路径写。
- **YAML 键**：校验拒绝 `document_contract`、非空的 `inputs` / `outputs` / `artifacts` 与依赖 `outputs` 的 `nonempty-output`，给替代写法；空列表照收；解析与 IR 保留以表示冻结快照。`gate: auto` 不再由 outputs 推导守卫。`effective-io` 只留给编排图，工作流 API 与工作台不再用它。
- **前端 DESIGN.md 立项前置**：来自旧契约的 require 槽，随契约退出新任务，前置检查代码删除；DESIGN.md 有效性仍由前端交付步的 `design-system` 必需测试把关（用户可见的行为变化）。
- **无快照旧任务**：绑定 `legacy-full` 却没有冻结快照的任务挂上冻结的 `openspec-v1` 表。
- **分流**：`capabilities.documents` 新增 `mode`（有契约为 `contract`，否则 `observed`）；`governed` 改为只表示 `spec: openspec` 的 OpenSpec 生命周期。契约模式代码不改，只服务旧快照；快照里没有契约、也没有检查点的在途任务记 `unavailable`，从下一步开始观察。
- **CLI**：`step.documents` 观察模式视图（输入、产出、必须产出）；`next` 只发 `read-documents`；旧命令在观察模式退出码 2；测试报告动作的报告路径改从验证步的必须产出取。
- **Dashboard**：服务端 `stepIo` 两种模式同形；工作台显示真实产出与已读；工作流页删除输入输出表与契约编辑，门禁段列出必须产出；不碰画布文件。
- **模块**：kernel 深模块 `documents/step-outputs.ts`（`startStepVisit`、`recordStepExit`、`recordInputReads`、`readStepOutputs`、`matchesOutputPattern`），内部接缝 `workspace/step-checkpoint.ts` 与 `state/step-output-ledger.ts`；转换直接调用，不新增注入点。

## 风险

- 同一检出里并行会话污染观察（worktree 与排除其他任务目录缓解，剩余标「未知」）。
- 来源标注依赖修改时间，同秒与重写文件时不准。
- 上游引用推断在少见分支布局下可能多算，只影响显示与交接。
- 分流点必须只有 `mode` 一个，避免误伤在途任务。
- 与并行任务在 `default.yaml`、`skills/tenon/SKILL.md`、`statusStep*`、文档上冲突；生成物用脚本重新生成。
- 验证步代码规模上限大概率超出，需申请测试豁免由用户批准。

## 待验证问题

无。调研步的开放问题已在设计文档「交互技能里的问题」与「拷问补充」中按推荐定案。
