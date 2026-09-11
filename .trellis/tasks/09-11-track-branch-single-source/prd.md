# 轨道只认工作流分支（方案 B）

## Goal

去掉「注册表能登记一条永远用不了的轨道」这个假承诺。轨道能不能和某个工作流一起用，只由工作流 YAML 里有没有这条分支决定。

## 现状（实机复现）

在空项目里：

```
$ tenon tracks create data --label 数据 --workflow-default default --workflow-allowed default --policy backend
created data
$ tenon init c1 --track data --workflow default --preset minimal
ERROR: 工作流 'default' 没有轨道 'data' 的分支
```

`tenon tracks list` 把 `data` 列为 `ALLOWED: default`，但它永远无法与 default 一起使用。两套真相：注册表（`.pipeline/tracks.yaml` + `tenon tracks` 命令）与工作流分支（`tracks:` 节点）。

**关键事实：产品运行时已经按方案 B 行事。** `selectTrackBranch`（`packages/kernel/src/workflow/validate.ts:67`）与 `effectivePlan`（`effective-plan.ts:97`）在分支缺失时直接抛 `WorkflowTrackBranchError`，注册表说了不算。落后的只有注册命令与测试。

因此本任务不是重构校验链，而是**删掉那个说了不算的登记入口，并让测试说实话**。

## Requirements

- 移除轨道注册的写入面：`tenon tracks create` / `update` / `delete`。
- 保留 `tenon tracks list` / `show` 作只读视图：它们不做登记，且 `tenon-open` 的 SKILL.md 仍用 `tenon tracks show <id> --json` 复核，删掉会打断既有 skill 步骤。
- 不改 `assertWorkflowAllowed`、不改 `selectTrackBranch`、不动 `packages/kernel/src/tracks/` 的策略面（`builtinTrack` / `policyProfile` / `coverageProfile`）——那些按内建轨道 id 供 guard 矩阵与 skill profile 使用，与「哪条轨道可用」无关，43 个非测试文件依赖它们。
- 断言注册表授予用途的测试必须改成断言方案 B 的语义，不得靠放宽断言绕过。

## 非目标

- 不删除 `.pipeline/tracks.yaml` 格式与解析器：手写的 builtin override 仍可读，只是不再能凭空造出可用轨道。
- 不动 `required_when` / legacy artifact 那一组失败（`artifact.integration.test.ts`、`commands/artifact.test.ts`、`commands/effective-artifacts.test.ts`、`fields.test.ts` 的 plan 用例）——同源于分支化但属另一条线，另行处理。

## Acceptance Criteria

- [x] `tenon tracks create|update|delete` 不再存在；`tenon tracks --help` 只列 `list` / `show`
- [x] `tenon tracks list` / `show` 仍可用，实跑输出与改动前逐行相同
- [x] `track-registry.integration.test.ts` 12/12 绿、`tracks.integration.test.ts` 5/5 绿，断言的是方案 B 语义
- [x] 全量 `npx vitest run` 复跑确认这两个文件的 6 个失败清零、无新增失败

## 实际改动

| 文件 | 改动 |
|---|---|
| `packages/cli/src/commands/tracks.ts` | 333 → 150 行：删 `cmdTracksCreate/Update/Delete` 及仅供其用的 `expandPolicy` / `scanActiveChanges` / `emitWrite` / 两个 Opts 接口与相应 import；文件头改述只读语义 |
| `packages/cli/src/program-tracks.ts` | 只注册 `list` / `show`，bare 用法提示同步 |
| `packages/cli/src/tracks.integration.test.ts` | 293 → 88 行：删 create / update / delete / 缩 allowed 引用完整性 / 防记忆化五个 describe，保留只读面 5 个用例 |
| `packages/cli/src/track-registry.integration.test.ts` | 三个用例改写为方案 B 语义（见下）；`DATA_FLOW_YAML` 加 `spec` 步骤；文件头重写 |
| `docs/usage/cli-reference.md` | tracks 段去掉写命令，写明「分支决定可用性」 |
| `docs/usage/custom-workflows-and-tracks.md` | 「Create a Track」整节改写为「Add a Track」：用 YAML 声明分支，tracks.yaml 降为只读 policy 叠加层 |
| `.trellis/spec/kernel/backend/workflow-track-branches.md` | 新增「Registry is policy-only; the branch decides usability」一节，并记录服务端残留写路由这个 gap |

### 三个用例怎么改的

1. `init --track data --workflow default`：由「放行」改为断言 exit 1、不建 change 目录、stderr 含「工作流 'default' 没有轨道 'data' 的分支」。
2. `set track`：先 `set track backend`（default 声明了该分支）断言 exit 0，再 `set track data` 断言 exit 1 且 track 未被改写，最后 `set track ghost` 断言 exit 1。这样拒绝 data 的理由被钉死为「缺分支」，而不是「一律不让改」。
3. coverage 七层矩阵用例：原来靠 `--track data --workflow default` 借用 default 的七阶段链路。改为**先写一份 default 项目覆盖**（由真模板把 `free` 分支改名为 `data` 得到），再 `init --track data --workflow default`。这既保住了「coverage_profile=backend 真来自 tracks.yaml」的原始意图，又正面演示了方案 B：声明分支之后轨道才可用。

> 试过但不成立的路子：把该用例改走 `data` 的缺省工作流 `data-flow`。自定义工作流的 guard 来自其 step 声明而不是 `EXIT_RULES`，`check` 返回 0，七层矩阵根本不触发——只加一个 `spec` 步骤救不回来。

## 未做（有意）

服务端仍暴露 `POST /api/tracks`、`PATCH /api/tracks/:id`、`DELETE /api/tracks/:id` 三个注册写路由，同一个假承诺在 HTTP 面还在。没有一并删，理由：

1. 仪表盘没有任何组件调用它们（`postTrackDefinition` / `patchTrackDefinition` / `deleteTrackDefinition` 三个客户端函数无引用），属死代码而非在用能力；
2. 它们在 `server.test.ts` 有一套**当前全绿**的用例，删接口等于删通过中的测试，属于需要用户拍板的范围变更；
3. 删与不删都不影响本任务的验收：CLI 侧假承诺已消除，工作流分支是唯一判据。

已写进 spec 的 gap 段落。
