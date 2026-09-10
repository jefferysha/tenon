# 工作流定义规范化与两页重设计

## Goal

统一工作流 YAML 为唯一定义源（阶段输出=类型化槽位，文档契约并入），新增 YAML 导入导出接口；工作台改为按阶段的流水线状态、输入/输出登记视图与右侧抽屉 Markdown 预览；工作流页改为流水线中列、可拖拽技能 DAG、按轨道分层可编辑的附加技能，去除只读胶囊/头像与解释性文案。

## Background（2026-09-10 用户反馈 13 条的归因）

系统里有三套互不相认的「每步定义」，UI 把它们各摆一处：

| 来源 | 位置 | 用户看到的怪象 |
|---|---|---|
| 工作流 YAML `steps[].inputs/outputs` | `templates/workflows/default.yaml`、`.pipeline/workflows/*.yaml` | 立项 / 交付 / 归档空 IO；`file_path`、`build_sha` 字段元数据 |
| OpenSpec 文档契约 | kernel 硬编码按阶段表（proposal / design / tasks / plan / report…） | 单独的「变更文档」区，其实这才是每步真正的产出与登记状态 |
| 轨道 × 阶段技能矩阵 | 运行时 manifest（`/api/config/effective`） | 「技能来自运行时矩阵」、三条轨道箭头 |

其它事实：
- 「新建工作流」失败根因是写接口 401：页面没有写凭证（开发地址 :5173 天生没有），UI 事后才报「凭证已失效」。
- 工作流已是 YAML 落盘（内建 default 编译进包；自定义在 `.pipeline/workflows/<name>.yaml`），导入导出只缺接口与入口。
- 本机技能清单已有接口 `GET /api/skills/registry`；轨道矩阵读 `GET /api/config/effective`、写 `POST /api/config/mandatory-skills`。

## Requirements

### R1 定义规范化（唯一真相 = 工作流 YAML）
- R1.1 每个阶段的输入 / 输出以「类型化槽位」呈现：**文档**（有 kind，走登记台账，可阅读）或 **值**（如 `build_sha`、`pr_url`）。文档契约的 slot（owner_step）计为该阶段输出，reads 计为输入。
- R1.2 默认工作流 YAML 补齐：交付输出 `pr_url`（值）、归档输出 `archived`（值）；其余阶段的输出由并入的文档槽位补齐，任何阶段都不再是空产出。前端删除自己维护的 `buildDefaultDef` 副本，default 一律从 `GET /api/workflows/default` 读取。
- R1.3 服务端在工作流读接口里返回**物化后的每步 IO**（文档 + 值，含产出者 / 消费者），前端不再自行拼接文档契约。
- R1.4 编辑器保存规则：每个阶段至少一个输出；每个输入必须由更早阶段产出。不满足则禁止保存并在阶段上标出「缺产出」。（kernel 现有校验不改，避免破坏 CLI 与既有自定义工作流。）
- R1.5 YAML 导入 / 导出：`GET /api/workflows/:name/yaml` 返回 `text/yaml`；`PUT /api/workflows/:name/yaml`（需写凭证）先解析校验再落盘，失败返回错误列表且不落盘。UI 提供导出（复制 / 下载）与导入（粘贴或选择文件）。
- R1.6 「变更文档」作为独立区块从工作台消失；文档只以「所属阶段的输出」出现。
- R1.7 **default 可编辑**：编辑 default 即写入项目覆盖文件 `.pipeline/workflows/default.yaml`；运行时（transition / 文档策略 / 快照）存在覆盖文件时读它，否则读内建。覆盖文件必须通过 default 契约校验（七阶段与顺序、评审门禁、文档槽位不变），其余（技能 DAG、门禁以外的守卫、值槽位、输入、prompt、流转动作）自由改。「恢复内建」= 删除覆盖文件。工作流列表始终含 default，并标出「项目覆盖 / 内建」。
- R1.8 文档槽位仅在契约固定的工作流（default 及 `openspec_contract: required` 的副本）中锁定；其它工作流的文档槽位可自由增删（写入 `document_contract`）。

### R2 工作台（只读）
- R2.1 任务卡：名称、轨道、七段迷你流水线（已完成 / 当前 / 待进行），以及**一行由数据推出的状态**，形如「实现 · 缺 build_sha」「验证 · 评审待确认」「交付 · 可进入归档」。删除「需要你 / 进行中 / 等待中 / 等产出」等抽象状态词。
- R2.2 筛选改为按阶段（立项…归档，各带计数）加一个「含已归档」开关；不再有独立状态筛选。
- R2.3 右列：阶段轨（可点）→ 该阶段的**输出**（已登记 / 缺失 / 已过期，产出技能与时间）与**输入**（上游是否就绪）。只显示文件名与中文类型（文档 / 值），不出现 `file_path` 等字段元数据。
- R2.4 文件预览为**右侧抽屉**（约 560px，Esc 关闭，可切上一份 / 下一份，任务上下文仍可见）。`.md` 用标准 Markdown（GFM）渲染，代码块等宽；其它文本走等宽纯文本。
- R2.5 页面上不出现解释性句子（「来自上游」「由本阶段技能登记」「登记者：…」等），只有标题与数据。

### R3 工作流页（编辑）
- R3.1 中列是流水线：竖向节点 + 连接线、门禁标记、回流边（如 验证失败 → 实现）带事件标签；末尾是「添加阶段」节点。
- R3.2 技能区是 **DAG 画布**：按执行波分列，同列并行、相邻列串行，边用连线绘制；技能节点与右侧「本机技能」面板之间可**拖拽**（拖入某列 = 与该列并行；拖到列间隙 = 新的串行一步；拖出 = 移除）。键盘可达（dnd 键盘传感器）。
- R3.3 **技能只有一套**（用户 2026-09-10 裁决「方案 B」）：轨道 × 阶段的技能矩阵并入工作流 YAML——每个技能节点可带 `when: { track_in: [...] }` 轨道条件，无条件 = 全部轨道。运行时（门禁 / 产出者校验 / AFK 技能包）按当前轨道过滤 YAML 技能，不再叠加 manifest 矩阵。UI 只有一个 DAG：节点带轨道标签，顶部轨道芯片可按某轨道查看有效链；节点上可改轨道条件。manifest 的 `mandatory_skills` 降为只读投影（路由提示），并有一致性检查保证与 default.yaml 不漂移。
- R3.4 产出区：列出文档槽位与值槽位；可从「可用槽位」添加（未被其它阶段占用的文档 kind；字段目录中的值 / 文件字段）、可移除。`openspec_contract: required` 的工作流中文档槽位固定（带锁标识），值槽位可编辑。
- R3.5 输入区：上游输出的勾选清单（勾 = 本阶段读取）。契约固定的文档读取不可取消。
- R3.6 门禁：无 / 评审 / 确认 三选一。
- R3.7 新建工作流：选模板（复制 default / 空白 / 导入 YAML）→ 命名 → 直接进入编辑。无写凭证时「新建 / 导入 / 保存」置灰并说明「当前地址没有编辑凭证」，而非事后 401。
- R3.8 左列工作流卡：名称、阶段数、使用它的轨道；卡上可导出 YAML；自定义工作流可删除。

### R4 全站
- R4.1 顶栏删除「只读视图」胶囊与「我」头像，设置改为图标按钮。
- R4.2 删除所有解释性 / 教学性文案（`note`、`desc`、`lead`、「技能来自运行时矩阵」「同一波并行 · 波与波之间串行」「由技能与上游阶段推导 · 不可手填」等）。
- R4.3 交互与用语规则：同一概念全站只用一个词（阶段 / 技能 / 输入 / 输出 / 门禁 / 轨道 / 工作流；不出现 step / lane / 产出物 / 登记者 等同义词）；区块标题只用名词；除错误信息外页面上不出现句子；对象所在处一步可操作（拖拽、行内菜单、就地编辑），不设二级页面；空态只显示一个动作按钮。
- R4.4 沿用模板视觉（暖纸底、深绿强调、发丝边、mono 标识）与 design-scale 约束；375 / 1440 无横向滚动。

## Out of scope（子任务 `09-10-skill-output-auto-registration`）

技能调用结束后自动检测产出文件并登记台账、下一阶段输入自动就绪、每阶段每技能的运行状态（含并行波次）进入快照与工作台——运行时能力，在本任务完成后按子任务 prd 单独实现。本任务的物化 IO 与阶段输出视图是它的展示面。

## Constraints

- 只读边界不变：工作台唯一网络调用为 snapshot、`GET /api/workflows/*`、`GET /api/documents/read`。
- 写接口一律带 `Authorization: Bearer <token>`；kernel `validateWorkflow` 与 CLI 行为不改。
- default 的编辑落在项目覆盖文件，内建模板本身只随本任务的 YAML 补齐改动；模板改动需重新生成 `default-workflow.generated.ts` 并通过 freshness 检查。
- 新增前端依赖限定：`react-markdown` + `remark-gfm`（渲染）、`@dnd-kit/core` + `@dnd-kit/sortable`（拖拽）。不引入 YAML 解析库到前端（YAML 由服务端解析）。
- i18n 完整性 / 泄漏测试、design-scale、comment-honesty 均须通过。

## Acceptance Criteria

- [x] AC1 `GET /api/workflows/default` 返回的物化 IO 中，7 个阶段每个都至少有一个输出；工作台任一阶段都不再显示「本阶段无产出」，页面无「变更文档」区。
- [x] AC2 `GET /api/workflows/default/yaml` 返回 `text/yaml`；`PUT /api/workflows/<custom>/yaml` 合法内容 200 并落盘，非法内容 4xx 且文件不变，无 token 401，超 256KB 413。
- [x] AC3 工作台任务卡显示迷你流水线与一行数据状态；筛选为阶段 + 含已归档；不存在「需要你 / 进行中 / 等待中 / 等产出」文案。
- [x] AC4 点击任一文件从右侧滑出抽屉；`.md` 内容渲染为标题 / 列表 / 表格 / 代码块；Esc 关闭并还原焦点；抽屉内可切换上一份 / 下一份。
- [x] AC5 工作流页中列渲染为带连接线与回流边的流水线；技能区为分列 DAG，拖拽（含键盘）可改并行 / 串行与增删，保存后 YAML `depends_on` 正确。
- [x] AC6 default 模板的 7 个阶段技能含轨道条件且与 manifest 矩阵一致（`check:default-skill-matrix`）；DAG 节点显示轨道标签，按轨道筛选只剩该轨有效技能；改节点轨道条件后保存，YAML 出现 `when: track_in`；本机技能列表来自 `/api/skills/registry`。
- [x] AC7 阶段产出为空时无法保存且阶段上有「缺产出」标记；输入清单只允许勾选上游输出。
- [x] AC8 新建工作流三选一模板可用；无写凭证时新建 / 导入 / 保存置灰并有说明；顶栏无「只读视图」与头像。
- [x] AC9 zh/en 词典中不存在 R4.2 列举类解释文案；i18n 完整性与泄漏测试、typecheck、web 与 server 测试、design-scale、comment-honesty、default-workflow freshness 全绿。
- [x] AC10 编辑 default 保存后 `.pipeline/workflows/default.yaml` 生成，`GET /api/workflows/default` 返回覆盖内容且 `source: 'project'`；删除覆盖后回到内建；破坏七阶段契约的保存被 400 拒绝并列出原因。
- [x] AC11 375 与 1440 宽度下两页 `scrollWidth === clientWidth`。
