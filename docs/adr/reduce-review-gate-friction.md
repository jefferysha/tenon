# 架构决策记录：轮次内回退边免人工确认，gate 认只读组合命令

> 本文只列决定，细节以设计文档 `docs/superpowers/specs/reduce-review-gate-friction-design.md` 为准。

## 背景

评审门对每条出边都要人工回执，包括受轮次上限约束的回退边；而 gate 在待处理期间把任何带 shell 元字符的命令都当写操作，拦截提示又三种标记共用一条、对评审标记描述不实。结果是用户为没有取舍的动作反复回复「确认继续」。

## 决策

1. 受轮次上限约束的评审步（`gate: review` 且有回退边）上，轮次未用完时，回退边的转换不再要求 approved review receipt；判定在内核转换用例里，与轮次门共用谓词和同一次轮次读取。`roundsOf` 未接线时失败关闭。——设计 §1
2. 不为回退边新增就绪检查（如验证报告已写出）：回退不绕过任何质量门，代价由 `max_rounds` 封顶。——§1
3. 每次成功转换后删除绑定本任务的 `.pipeline-pending-review`：任何成功转换都会清空回执，标记必然过期。——§2
4. `next` 对唯一回退边在轮次内直接给 `transition`。——§3
5. gate 只读判定改为引号感知的组合判定：每段都在白名单内（或是 `cd`）才放行；顺手收紧白名单里会写文件或执行程序的形态（`--output`、`rg --pre`、`sed -n` 非行号打印、`file -C`）。——§4
6. 拦截提示按标记种类分开，评审标记不再提 AskUserQuestion 解封。——§5

## 备选方案

只改 `next`（转换仍要回执，必然被拒）；在工作流 YAML 上逐边声明是否需要确认（要改 schema、生成物与 Dashboard 编辑器，规则本就与轮次上限绑定，不需要逐边配置）；放宽共享的元字符判定（会同时放宽评审控制命令白名单）——均已否决。

## 后果

- 评审回执的适用范围变窄，属于行为契约变更：`docs/CONTRACT.md`、`adapters/contract.md`、Codex AGENTS 块（生成物）、`templates/workflow.md`、`skills/tenon/SKILL.md`、用户文档与三份主 spec 同步。
- design-system 工作流的 `review-changes` 同样适用：agent 可以在用户看之前自行打回重做，前进仍要用户确认。
- 免回执的回退不再产生「评审确认 → 转换」的交互效果记录。
- Dashboard「退回到…」仍复制 `review request`，继续可用；改成直接转换留作后续。
- 已装的 Codex AGENTS 块会被 `tenon sync` 报为落后，随发布更新。
