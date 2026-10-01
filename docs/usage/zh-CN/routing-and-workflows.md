# 选择执行模式

Tenon 的目标不是让所有请求都走最长流程，而是让任务复杂度、风险和证据成本匹配。

## Discussion

适用于解释、只读检查、方案讨论和无需修改状态的研究。它不创建 Change，也不复用旧的 `active-change`。新目标不会因为仓库里存在历史 Change 就被错误绑定。

## Simple

适用于少量文件、明确行为和低风险修改。内建 simple 通常是：

```text
change ⇄ verify → done
```

它不生成 default 的 proposal/design/tasks 链。短 workflow 如果声明三份文档，就只生成并读取这三份。

## 标准通道

`standard` 是「既不是错字级、也谈不上重型」的实现类请求的默认通道：修 bug、加一个函数、重构一个模块。它是随插件发布的
模板工作流（`templates/workflows/standard.yaml`，和 `design-system` 一样可编辑、可被项目文件覆盖），绑定内建 `standard` 轨道，
没有 OpenSpec 契约，所以没有要铺骨架、要登记的文档：

```text
open → build → verify → done
```

| 步骤 | 做什么 | 证据 |
| --- | --- | --- |
| `open` | 用一句话复述目标和验收检查；不调研、不加载访谈类技能 | 无 |
| `build` | `test-driven-development`，然后单测（范围 `changed`；登记了 `typecheck` 就跑）和 `diff-risk` 探针 | 单测运行、测试文件已登记、探针通过 |
| `verify`（评审门） | `verification-before-completion`，全量单测（登记了 `regression`、`integration`、`e2e`、`playwright`、`a11y`、`visual` 也跑），一个必需评审者 `code-review`；用户只确认这一次 | 测试、评审者、人工确认 |
| `done` / `escalated` | 终态；`done` 把整个工作区一次提交（`chore(tenon): finish <change>`） | |

测试策略与 default 的零豁免默认一致：只有 `unit` 必需，其余有就跑。评审者是 `code-review`（必需，`block_at: medium`；它对照宿主写在
提示末尾的目标与验收检查看 diff，不读规格）和 `security`——后者声明了 `attach_on: [auth, dependency, contract]`，只有任务的改动碰到
这类路径才加入；default 工作流里的 `security` 同样按这条规则挂载。集成测试（`standard-lane.integration.test.ts`，一个三文件缺陷修复）
实测：23 次 `tenon` 调用、2 次用户回复（一次确认测试命令的信任、一次确认 `verify`）；审计对 default 后端小改动的估算是 70–90 次调用、6 次以上回复。

### 风险升级

走哪条通道由改动实际长成什么样决定，不靠开工前猜 prompt。`build` 声明了一个必需的 `diff-risk` 步骤测试
（`tenon test diff-risk --json`），它的 `pass.metrics` 就是阈值，全部可以在工作流 YAML 里改：

| 指标 | 默认上限 | 超限的情形 |
| --- | --- | --- |
| `files_changed` | 8 | 改动的源码文件数超过上限 |
| `contract_files` | 0 | 动了 OpenAPI、proto、GraphQL、schema 或 `contract` 路径 |
| `auth_files` | 0 | 动了 auth、login、session、jwt、password、permission、crypto、secret 路径（或 `.env*`） |
| `dependency_files` | 0 | 动了包清单或锁文件 |
| `migration_files` | 0 | 动了迁移路径 |
| `deleted_tests` | 0 | 删了测试文件 |
| `protected_test_files` | 0 | 动了测试目录、基线、已知失败清单或项目工作流 |

探针不过时，`tenon status --json`（以及 `tenon step run`）不再催着把本步做完，而是只给一个 `scope-expanded` 的 `transition`，
附 `escalate`（被突破的阈值，以及「另开 `default` 任务并 `tenon set <新任务> depends_on <本任务>`」的指引）。探针没跑或已过期只是一条
普通的必需测试，所以直接 `build-complete` 会被拒绝：探针是闸，不是建议。`scope-expanded` 本身是放弃边：走它不要求单测、评审者、文档或技能证据，
工作区的改动原样留给接手的 `default` 任务，不替它提交。不要为了让探针通过去拆改动、藏文件。

### 路由进通道

实现类请求（修、改、加、删、实现、重构、重命名，中英文都认）路由到 `standard`；它的优先级高于 `frontend`、`backend` 轨道，后两者点名才用。
带重型信号的请求不进 `standard`（架构、跨模块或全项目、schema、迁移或数据库、鉴权或权限、依赖升级、发布或部署、生产数据、全栈）：照旧进 default
工作流，没有领域轨认领时落到 `backend` 轨，不会无人治理。错字级仍走 `simple`，调研与产品类走 `pm`。没有任何轨道命中、却像在改代码的请求
（带源码路径、反引号代码、函数调用，或函数、模块、测试、bug、报错这类词）不再被悄悄放过：路由器输出一行提示，说明它没有被治理、怎样起一个
`standard` 任务。纯讨论的 prompt 从不提示。

## Default

适用于跨模块、需求可能变化、需要架构取舍或真实验收的任务：

```text
open → explore → spec ⇄ build ⇄ verify → ship → archive
```

完整 OpenSpec、Superpowers、ADR、计划、验证报告和 applied spec 由 document contract 管理。

## Free

Free 是默认七阶段的中性 track，不代表绕过门禁。它不自动叠加 PM、前端或后端模板；默认
Workflow 当前阶段的 `tenon-<phase>` 仍是冻结的硬要求。artifact producer 或 AFK 显式选择
具名 profile 时结果仍按 phase-first 合并，但 profile 不会反向成为 Hook/transition 的自动要求。

## Custom

Custom workflow 由项目 `.pipeline/workflows/*.yaml` 定义 DAG、skills、guards、review gate 和 document contract。系统必须加载真实定义，不能按 step 名猜测它等价于 default。

## 恢复规则

只有用户明确说“继续/恢复”或点名 Change 时才恢复。多个候选时必须选择，不能按修改时间猜测。独立新目标从新 Open 或相应 short workflow 开始。

`tenon session activate <change> --host-session <id>` 会把当前宿主会话精确绑定到一个
Change。后续在该对话中说“继续执行”时，路由器先读取这条会话绑定，再考虑仓库级
用户自己的 `active-change` 候选；因此另一个会话切换任务不会把当前对话串到旧 Change。用户完整点名
Change 的指令优先级仍然最高。绑定文件只负责会话身份和运行态观察，不参与 canonical guard
或 transition。

## 判断表

| 问题 | 建议 |
| --- | --- |
| 只需要解释或诊断？ | discussion |
| 三个以内明确修改、无架构决策？ | simple |
| 修 bug、加函数、小重构这类实现，没有重型信号？ | standard（改完按 diff 实测风险，越线再升级到 default） |
| 需要规格、跨层实现或浏览器验收？ | default |
| 需要七阶段但不想套领域模板？ | free |
| 团队已有自定义 DAG？ | custom |

## 路由信号

Discussion 常见于“解释错误”“只审查不修改”“比较方案”。一旦请求从分析变成写文件，入口应重新分流，不能在无 Change 的对话中悄悄制造实现。

Simple 适合行为明确、影响面小、无需架构决策的修改。“简单”只减少治理开销，不降低测试和 Verify 标准。出现跨模块契约、迁移、安全边界或需求分歧时，应通过 workflow 声明的 `escalated` 出口升级。

Default 适合以下信号：

- 修改跨越多个包或共享契约；
- 需要调研并保留取舍依据；
- 需要浏览器、安装链或回滚验收；
- 需求在实现期间可能变化；
- 交付结果将进入公开发布。

Free 解决“需要完整治理但不属于预置领域角色”的任务，仍执行 OpenSpec、文档读取、review receipt 和验证基线。

Custom 可以只有三个步骤，也可以包含并行依赖。是否生成 proposal、spec 或 ADR，只由其 document contract 决定，不因文件名习惯自动补齐 default 文档。

## 升级与恢复边界

执行中只允许按 workflow 声明的边移动。Simple 发现复杂度升级时走正式出口；Default 不能为了省事中途伪装成 Simple。

以下情况不能静默降级：

- 已经产生需要审计的 review 决策；
- 已冻结 Build 基线；
- 已运行外部发布或生产迁移；
- 已有后续阶段读取文档 digest。

恢复规则可以避免“调研新项目却继续旧 Change”的串线问题。用户自己的 `active-change` 是恢复候选投影，不是把所有后续对话永久锁定到旧任务的全局开关。
宿主提供 session id 时，只有该会话存在有效精确绑定，通用“继续执行”才会恢复；全新未绑定会话
不会再回落到用户的 `active-change`。用户显式点名 Change 始终拥有最高优先级。

## Todo 如何随模式变化

Default 的一级 Todo 固定对应七个 phase，细项来自当前 Change 的 `tasks.md`。Simple 和 Custom 按各自步骤展示，不得强行扩展为 PM、前端、后端通用清单。

UI 中的“等待”也必须解释真实状态：未开始、等待 review、排队或已停止不能混为一类。

## 验证当前路由

```bash
tenon list --json
tenon status <change> --json
tenon document status <change>
```

核对 Change 名、workflow、track、当前 phase 和文档合同。若新目标意外命中旧 Change，应停止写入并创建独立 Change，不能继续污染旧证据。
