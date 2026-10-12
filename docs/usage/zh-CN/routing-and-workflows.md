# 选择执行模式

Tenon 的目标不是让所有请求都走最长流程，而是让任务复杂度、风险和证据成本匹配。

**工作流**是步骤、转换、门禁、技能、产物和可选文档契约组成的图，它的 YAML 是任务怎么走的唯一定义。**轨道**是工作流里的一个分支（YAML 里的 `tracks.<id>`），自带步骤、规范、路由关键词和自动化设置；轨道的身份是「工作流 + 轨道 id」，只有这一种轨道。没有 `tracks:` 的平铺工作流（如 `design-system`）本身就是唯一的轨道，`tenon init` 不用写 `--track`。

内建工作流只有两个。`default` 有四条轨道：

| 轨道 | 名称 | 适用 | 规范 |
| --- | --- | --- | --- |
| `lite` | 轻量 | 修缺陷、小改动、错字级改动 | 无；只有一道评审门 |
| `pm` | 产品 | 调研、PRD、产品类工作 | OpenSpec |
| `frontend` | 前端 | 界面工作 | OpenSpec |
| `backend` | 后端 | 服务、接口、数据；也是兜底轨道 | OpenSpec |

`tenon tracks list` 列出项目可用的全部工作流的全部轨道。

## 路由怎么决定

路由只决定「是不是开发请求、属于哪个领域」，不按关键词决定轻重：轻量轨道作为候选摆出来，由预计改动范围定夺。

| 结果 | 选择规则 | 发生什么 |
| --- | --- | --- |
| Discussion | 解释、提问、只读分析、斜杠命令、系统通知 | 不创建 Change |
| 点名 | 消息点名了轨道（「用后端轨道」、`--track backend`）或工作流 | 照点名的用，不评估 |
| 重型信号 | 请求命中轻量轨道的 `route.exclude`（默认：架构、跨模块、迁移、schema、数据库、鉴权、依赖升级、发布、部署、全栈、调研、PRD 等） | 直接走领域重型轨道，不评估 |
| 评估 | 其余开发请求 | 先评估；候选是轻量轨道与领域重型轨道 |
| 选择 | 最高分并列，或最高分的轨道属于自定义工作流 | 由你选一对「工作流 + 轨道」 |
| 兜底 | 请求命中某轨道的关键词，却被它自己的排除词挡掉，又没有别的轨道认领 | 落到声明了 `route.fallback: true` 的轨道（`default` 里是 `backend`） |

路由用确定性的关键词、排除词、分数和优先级，不是语义 AI 意图分类；有歧义时应该问，不能猜。没有任何轨道命中、却像在改代码的请求（带源码路径、反引号代码、函数调用，或函数、模块、测试、bug、报错这类词）不会被悄悄放过：路由器输出一行提示，说明它没有被治理、怎样先评估再起任务。纯讨论的 prompt 从不提示。

路由钩子注入的 dispatch 带着这个决定：

```text
<tenon-dispatch>
action: invoke-skill
skill: tenon
workflow: default
track: backend
track_basis: score
intent: new
assess: required
candidate: workflow=default;track=lite
candidate: workflow=default;track=backend
```

`track_basis: user-named` 表示轨道是用户点名的。`assess: required` 表示建任务之前必须先评估，`candidate` 各行是可选的轨道。`selection_required: true`（同样带 `candidate` 行）表示要先由用户选一对「工作流 + 轨道」才能建任务。

### 路由数据

路由行来自工作流文件：项目 `.pipeline/workflows/`、全局存储、插件模板里，每条带 `route`（`keywords`、`exclude`、`priority`，可选 `fallback`）的轨道就是一行。没有 `route` 的轨道从不按分数被选中，但仍可点名使用。生成的路由表缓存在 `.pipeline/cache/router.v6.data`，缓存格式版本变化或任一工作流文件内容变化都会重建，所以在 Dashboard 保存工作流后，下一条消息就按新规则路由。旧版缓存直接作废重建。写坏的工作流在路由生成时被跳过并输出一行警告，其余工作流照常路由；缓存是有界的纯数据，bash 钩子只读取、从不执行它，路由保持失败关闭。

`.pipeline/tracks.yaml` 与原来写死的内建轨道登记表都不再读取。文件还在时 Tenon 只打印一行提示；把它的规则写进工作流分支的 `route`（见[自定义 Workflow 与 Track](./custom-workflows-and-tracks.md#2-定义-track)）。

## 建任务前先评估

dispatch 带 `assess: required` 时，agent 先读相关代码、列出预计要改的文件，运行

```bash
tenon assess --files <路径>...
```

把评估结果与推荐摆给你；你确认之后才执行 `tenon init`。持续执行模式直接采用推荐。选轻量轨道时，它会带上 `--domain <轨道>`（dispatch 里另一个候选），让之后的升级直接给出对应的重型轨道。手动 `/tenon <请求>` 以 `/` 开头，路由钩子不处理，`tenon` 技能按同一口径决定：你点名的工作流或轨道优先；带重型信号走领域重型轨道；其余开发请求先评估。项目自定义的工作流只在你点名时使用。

`tenon assess` 用与下面的改动风险探针完全相同的分类规则与阈值，只按路径分类，不读文件内容。不带 `--workflow`、`--track` 时评估 `default` 工作流的 `lite` 轨道。

| 退出码 | 含义 |
| --- | --- |
| `0` | 未超轻量阈值，推荐轻量轨道 |
| `3` | 超限；列出被突破的阈值（如 `auth_files 1 > 0`），推荐同一工作流的重型轨道 |
| `1` | 出错：没有 `--files`；路径是绝对路径、含 `..` 或经符号链接指向仓库外；或该轨道没有声明 `diff-risk` 阈值（报「该轨道没有改动风险阈值」，不猜阈值） |

`--json` 在 stdout 输出 `{ workflow, track, metrics, exceeded, reasons, recommendation }`，错误走 stderr。

## 轻量轨道

`lite` 承接既不带重型信号、也没有超出阈值的工作：修 bug、加一个函数、重构一个模块、改错字。它是 `spec: none`，没有 OpenSpec 契约，所以没有要铺骨架、要登记的文档：

```text
open → build → verify → done
```

另有终态 `escalated`，前三步都可以经 `scope-expanded` 到达。

| 步骤 | 做什么 | 证据 |
| --- | --- | --- |
| `open` | 用一句话复述目标和验收检查；不调研、不加载访谈类技能 | 无 |
| `build` | `test-driven-development`，然后单测（范围 `changed`；登记了 `typecheck` 就跑）和 `diff-risk` 探针 | 单测运行、测试文件已登记、探针通过 |
| `verify`（评审门） | `verification-before-completion`，全量单测（登记了 `regression`、`typecheck`、`integration`、`e2e`、`playwright`、`a11y`、`visual` 也跑），必需评审者 `code-review` 与 `security`；用户只确认这一次 | 测试、评审者、人工确认 |
| `done` / `escalated` | 终态；`done` 把任务目录移进 `openspec/changes/archive/` 并把整个工作区一次提交（`chore(tenon): finish <change>`）；`escalated` 同样归档，但不提交 | |

测试策略与重型轨道的零豁免默认一致：只有 `unit` 必需，其余有就跑。`code-review` 必需，`block_at: medium`，它对照宿主写在提示末尾的目标与验收检查看 diff，不读规格。`security` 声明了 `attach_on: [auth, dependency, contract]`，只有任务的改动碰到这类路径才加入。轻量轨道不推送、不开 PR，由你决定。集成测试（`lite-track.integration.test.ts`，一个三文件缺陷修复）实测：不超过 25 次 `tenon` 调用、2 次用户回复（一次确认测试命令的信任、一次确认 `verify`）；重型轨道的后端小改动要 70–90 次调用、6 次以上回复。

### 风险升级

评估是事前预测，探针是安全网。`build` 声明了一个必需的 `diff-risk` 步骤测试（`tenon test diff-risk --json`），它的 `pass.metrics` 就是阈值，全部可以在工作流 YAML 里改；`tenon assess` 读的是同一组阈值：

| 指标 | 默认上限 | 超限的情形 |
| --- | --- | --- |
| `files_changed` | 8 | 改动的源码文件数超过上限 |
| `contract_files` | 0 | 动了 OpenAPI、proto、GraphQL、schema 或 `contract` 路径 |
| `auth_files` | 0 | 动了 auth、login、session、jwt、password、permission、crypto、secret 路径（或 `.env*`） |
| `dependency_files` | 0 | 动了包清单或锁文件 |
| `migration_files` | 0 | 动了迁移路径 |
| `deleted_tests` | 0 | 删了测试文件 |
| `protected_test_files` | 0 | 动了测试目录、基线、已知失败清单或项目工作流 |

探针不过时，`tenon status --json`（以及 `tenon step run`）不再催着把本步做完，而是只给一个 `scope-expanded` 的 `transition`，附 `escalate`：`reasons` 是被突破的阈值，`then` 是新建重型轨道任务并关联的命令。轻量任务建立时若记了领域（`tenon init --domain`），`then` 直接给出 `tenon init <新任务> --workflow default --track <领域> --preset full`，再 `tenon set <新任务> depends_on <本任务>`；没有记领域时列出可选的轨道请你选。探针没跑或已过期只是一条普通的必需测试，所以直接 `build-complete` 会被拒绝：探针是闸，不是建议。`scope-expanded` 本身是放弃边：走它不要求单测、评审者、文档或技能证据，任务结果记为「已升级」并归档，工作区的改动原样留给接手的新任务，不替它提交。不要为了让探针通过去拆改动、藏文件。

## 任务怎么结束

所有任务都一样结束：任务目录移进 `openspec/changes/archive/<日期>-<名字>/`，并记下任务结果——完结、已升级或已终止。工作台把它们收在「已结束」里。

- `tenon task finish <change>`：状态机已走到终态（完结或已升级）的任务。`step.next` 的 `finish-change` 动作给出的就是它。`spec: openspec` 的轨道由 Tenon 自己调用 `openspec archive <change> --skip-specs --yes --json`；`spec: none` 的轨道由 Tenon 直接移动目录，同一天已有同名归档时追加 `-2`、`-3`。
- `tenon task terminate <change>`：你要放弃一个没做完的任务。任务结果记为「已终止」，只提交任务目录（`chore(tenon): terminate <change>`），它改过的代码原样留给你。已终止的任务不能恢复；想继续就新开任务并用 `depends_on` 关联。

没有「隐藏」：`tenon task` 下原来的 `archive`、`unarchive` 子命令已不存在，运行会退出码 `1` 并指向这两条命令。

## 自定义 Workflow

Custom workflow 由项目 `.pipeline/workflows/*.yaml` 定义 DAG、skills、guards、review gate 和 document contract。系统必须加载真实定义，不能按 step 名猜测它等价于 default。

把轨道写成 `tracks:` 下的分支；给分支写上 `route`，路由器就把它列为候选。因为最高分的分支此时属于自定义工作流，路由器会让你选一对「工作流 + 轨道」，不替你决定。然后显式建任务：

```bash
tenon init <change-name> \
  --workflow <name> \
  --track <track> \
  --preset full
```

平铺工作流不用写 `--track`。`tenon init --workflow standard`、`--workflow simple` 会报错并提示改用 `--workflow default --track lite`；把已退役的轨道 id（`standard`、`simple`、`chat`、`free`）传给 `--track` 同样报错，并列出该工作流可选的轨道。

`default` 与 `design-system` 随插件发布为模板：项目或用户级的同名文件会覆盖它们（调整轻量阈值就是这样改的）。

## 恢复规则

只有用户明确说“继续/恢复”或点名 Change 时才恢复。多个候选时必须选择，不能按修改时间猜测。独立新目标从新的任务开始。

`tenon session activate <change> --host-session <id>` 会把当前宿主会话精确绑定到一个
Change。后续在该对话中说“继续执行”时，路由器先读取这条会话绑定，再考虑仓库级
用户自己的 `active-change` 候选；因此另一个会话切换任务不会把当前对话串到旧 Change。用户完整点名
Change 的指令优先级仍然最高。绑定文件只负责会话身份和运行态观察，不参与 canonical guard
或 transition。

升级之前创建的 Change 按它冻结的工作流快照走完，包括旧的 `standard`、`simple`、对话和自由任务：它们沿用开工时的规则。

## 判断表

| 问题 | 建议 |
| --- | --- |
| 只需要解释或诊断？ | discussion |
| 修 bug、加函数、小重构、改错字？ | 先评估；未超阈值走 `lite` |
| 评估超限，或带架构、迁移、鉴权、依赖、发布这类重型信号？ | 领域重型轨道（`pm` / `frontend` / `backend`） |
| 团队已有自定义 DAG？ | 自定义工作流，由你点名或选择 |
| 设计体系这类专用流程？ | 平铺工作流，如 `design-system` |

## 路由信号

Discussion 常见于“解释错误”“只审查不修改”“比较方案”。一旦请求从分析变成写文件，入口应重新分流，不能在无 Change 的对话中悄悄制造实现。

轻量轨道适合行为明确、影响面小的修改。“轻量”只减少治理开销，不降低测试和 verify 标准。出现跨模块契约、迁移、安全边界或需求分歧时，探针会让任务经 `scope-expanded` 升级。

重型轨道适合以下信号：

- 修改跨越多个包或共享契约；
- 需要调研并保留取舍依据；
- 需要浏览器、安装链或回滚验收；
- 需求在实现期间可能变化；
- 交付结果将进入公开发布。

Custom 可以只有三个步骤，也可以包含并行依赖。是否生成 proposal、spec 或 ADR，只由其 document contract 决定，不因文件名习惯自动补齐 default 文档。

## 升级与恢复边界

执行中只允许按 workflow 声明的边移动。轻量任务发现复杂度升级时走 `scope-expanded` 的正式出口；重型轨道不能为了省事中途伪装成轻量。

以下情况不能静默降级：

- 已经产生需要审计的 review 决策；
- 已冻结 Build 基线；
- 已运行外部发布或生产迁移；
- 已有后续阶段读取文档 digest。

恢复规则可以避免“调研新项目却继续旧 Change”的串线问题。用户自己的 `active-change` 是恢复候选投影，不是把所有后续对话永久锁定到旧任务的全局开关。
宿主提供 session id 时，只有该会话存在有效精确绑定，通用“继续执行”才会恢复；全新未绑定会话
不会再回落到用户的 `active-change`。用户显式点名 Change 始终拥有最高优先级。

## Todo 如何随模式变化

重型轨道的一级 Todo 对应该轨道的七个 phase，细项来自当前 Change 的 `tasks.md`。轻量轨道没有 `tasks.md`，Todo 取自冻结计划的步骤标签；自定义工作流按各自步骤展示，不得强行扩展为产品、前端、后端通用清单。

UI 中的“等待”也必须解释真实状态：未开始、等待 review、排队或已停止不能混为一类。

## 验证当前路由

```bash
tenon list --json
tenon status <change> --json
tenon tracks show <workflow>:<track> --json
tenon document status <change>
```

核对 Change 名、workflow、track、当前 phase 和文档合同。若新目标意外命中旧 Change，应停止写入并创建独立 Change，不能继续污染旧证据。
