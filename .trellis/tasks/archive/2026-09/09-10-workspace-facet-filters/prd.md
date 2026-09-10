# 工作台筛选按工作流 / 轨道 / 阶段分层

## Goal

任务列表筛选改为三层 facet：工作流 → 轨道 → 阶段；阶段芯片只在选定单一工作流时出现并取该工作流自己的阶段序；各 facet 计数互相约束；含已归档开关保留。

## Background

上一版把所有任务的阶段并成一排芯片。不同工作流的阶段集合、顺序、名字都可以不同（default 七阶段 vs 自定义两三步），
把它们混在一排既无法解释计数，也让用户看不出「筛的是哪条流水线的哪一步」。用户反馈 2026-09-10：
「每个 workflow 都是不一样的状态，你要怎么筛选……我定义 workflow、track、pipeline、stage 都可以是不一样的」。

## Requirements

- R1 筛选状态 = `{ workflow: 'all' | name, track: 'all' | id, stage: 'all' | stepId, includeArchived }`；三层都参与过滤。
- R2 芯片分三行：工作流（全部 + 出现过的工作流名，mono）、轨道（全部 + 出现过的轨道 id）、阶段。阶段行**只在** `workflow !== 'all'` 时出现，阶段序取该工作流的流水线（该工作流任一任务的 `stages`），标签用该工作流的阶段名。
- R3 每个芯片的计数 = 在其它两个 facet 与归档开关约束下、命中该值的任务数；不可见的阶段行不参与。
- R4 切换工作流时阶段回到「全部」；切项目时全部重置。
- R5 聚合语境（未选项目）同样适用；不引入任何 per-root 请求。
- R6 芯片仍是 `role=tab`，testid：`task-facet-workflow-<name>` / `task-facet-track-<id>` / `task-filter-<stepId>`（阶段）/ `task-filter-all` 语义拆为 `task-facet-workflow-all` / `task-facet-track-all` / `task-facet-stage-all`。

## Acceptance Criteria

- [ ] AC1 两条不同工作流（default 七阶段 + 自定义两阶段）的任务共存时，阶段行不出现；选中一条工作流后阶段行按该工作流顺序出现，计数只计该工作流的任务。
- [ ] AC2 选工作流 A 后再选轨道 B，阶段芯片计数随之收窄；切回工作流「全部」阶段行消失且 stage 重置。
- [ ] AC3 App 聚合用例（`compact` 工作流）改为先点工作流芯片再断言阶段芯片 `task-filter-review` 计 1；请求仍只有 `/api/snapshot`。
- [ ] AC4 typecheck、web 测试、i18n、design-scale 全绿。
