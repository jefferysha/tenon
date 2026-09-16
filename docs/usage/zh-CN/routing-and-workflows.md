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
