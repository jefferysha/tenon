# 设计：轨道只认工作流分支

## 现有两条链

| 链 | 入口 | 判据 | 结果 |
|---|---|---|---|
| 注册表 | `tenon tracks create/update` 写 `.pipeline/tracks.yaml` | `assertWorkflowAllowed(track, workflowId)` 查 `track.workflow.allowed` | 说「允许」 |
| 工作流分支 | 工作流 YAML 的 `tracks:` 节点 | `selectTrackBranch` / `effectivePlan` 查分支是否存在 | 缺分支直接抛 `WorkflowTrackBranchError` |

注册表链先跑、工作流链后跑，后者一票否决。所以**运行时语义已经是方案 B**；注册表只是在更早的地方给了一个不作数的承诺。

## 决策

只删假承诺的来源，不动判据链。

- **删**：`tenon tracks create` / `update` / `delete` 及其 `cmdTracks*` 实现与 commander 接线。没有登记入口，就不会再产生「注册了却用不了」的轨道。
- **留**：`tenon tracks list` / `show`。它们只读，不制造承诺；`tenon-open` 的 SKILL.md 仍调用 `tenon tracks show <id> --json`，删掉会打断既有 skill 步骤。
- **留**：`assertWorkflowAllowed`、`selectTrackBranch`、`packages/kernel/src/tracks/` 全部策略面。前者对内建六轨仍给出 `allowed='*'` 的放行，语义正确；后者的 `policyProfile` / `coverageProfile` / skill profile 按内建轨道 id 供 guard 矩阵使用，与「哪条轨道可用」无关，43 个非测试文件依赖它们。
- **留**：`.pipeline/tracks.yaml` 的解析与校验。手写的 builtin override 仍可读；手写一条 custom track 也不再能凭空变得可用——工作流分支依然一票否决，这正是方案 B 想要的。

## 为什么不把 `assertWorkflowAllowed` 换成分支查询

那会让 `allowed` 白名单失去意义，并改变两个 server 路由与三个 CLI 命令的既有拒绝语义（错误码与文案都会变）。而这一步对达成方案 B 的目标没有必要：分支检查已经在下游一票否决。改它只增加回归面。

## 兼容性

- 已经写在盘上的 `.pipeline/tracks.yaml` 仍可读，不需要迁移。
- 唯一被移除的能力是「用 CLI 登记一条工作流未声明的轨道」——而这条轨道本来就无法用于任何声明了 `tracks:` 的工作流。
- 对未声明 `tracks:` 的工作流（如测试夹具里的 `data-flow`），任何轨道仍然可用，行为不变。

## 回滚

改动集中在 `packages/cli/src/commands/tracks.ts`、`packages/cli/src/program-tracks.ts` 与两个测试文件，`git revert` 即可。
