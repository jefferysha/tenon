# 全局 default 导致工作流页解码失败 / 无法恢复内建

## Goal

让 dashboard 客户端接受 `default.source === 'global'`。目前只要全局存储里存在 `default.yaml`，工作流页刷新后就取不到工作流列表，左栏流程为空，并且「恢复内建」永久不可用。

## 复现（实机）

1. 起 `packages/server/dist/dashboard.mjs`，打开 `?view=workbench`，在任意阶段改门禁并保存 —— 这会在 `<configRoot>/workflows/.pipeline/workflows/default.yaml` 落一份全局覆盖。
2. 刷新页面。

实测结果：

| 观察点 | 现状 | 期望 |
|---|---|---|
| `GET /api/workflows` | `{"names":[],"default":{"source":"global"}}` 200 | 同左 |
| 页面报错 | `workflow 列表获取失败：服务端响应格式无效。` | 无 |
| 左栏阶段数 | 0 | 7 |
| 「恢复内建」 | disabled | 可用 |

## 根因

- `packages/dashboard-app/src/api/governanceClient.ts`：`WorkflowIndex.defaultSource` 类型写死 `'builtin' | 'project'`，`decodeWorkflowIndex` 对其它取值 `return null` → `readOrThrow` 抛「响应形状无效」→ `useWorkflowEditor` 进 catch 分支，`names` 清空、`defaultSource` 留在 `'builtin'`。仓库里已有 `WbWorkflowSource = 'builtin' | 'project' | 'global'`，这一处没跟上。
- `packages/dashboard-app/src/workflow/WorkflowNav.tsx`：`deleteEnabled` 要求 `defaultSource === 'project'`。
- `packages/dashboard-app/src/workbench/useWorkflowEditor.ts`：`openWorkflowDelete` 里 `if (wfName === 'default' && defaultSource !== 'project') return`。

## Requirements

- `WorkflowIndex.defaultSource` 用既有的 `WbWorkflowSource`，解码接受 `'global'`。
- default 的「恢复内建」在覆盖来自 `project` 或 `global` 时都可用；来源为 `builtin` 时仍 disabled。
- 不改服务端返回值，不改 `packages/*/dist`。

## Acceptance Criteria

- [x] 全局存在 `default.yaml` 时刷新工作流页：无错误提示，左栏 7 个阶段，来源显示「全局」
- [x] 该状态下「恢复内建」可点，点后全局 `default.yaml` 被删除，来源回到「内建 · 5 轨道」，左栏 7 个阶段仍在，「恢复内建」重新 disabled
- [x] 来源为「内建」时「恢复内建」仍 disabled
- [x] 新增 `governanceClient.test.tsx` 覆盖三种来源与未知来源；`WorkflowNav.test.tsx` 覆盖 `deleteEnabled` 三来源
- [x] `npm run typecheck:web && npm run test:web && npm run check:design-scale && npm run check:comments` 全绿

## 实际改动

| 文件 | 改动 |
|---|---|
| `packages/dashboard-app/src/api/governanceClient.ts` | `defaultSource` 改用 `WbWorkflowSource`，解码接受 `'global'` |
| `packages/dashboard-app/src/workflow/WorkflowNav.tsx` | `deleteEnabled` 由 `=== 'project'` 改为 `!== 'builtin'` |
| `packages/dashboard-app/src/workbench/useWorkflowEditor.ts` | `openWorkflowDelete` 同上；删除 default 后推 `reloadNonce` 重新拉内建定义 |
| `packages/dashboard-app/src/i18n/translations.ts` | `restore_default_body` 去掉「项目里的」，全局覆盖时措辞不再说错来源 |

## 顺带修掉的第二个缺陷

恢复内建成功后 `switchTo('default')` 因 `wfName` 未变不会触发定义 effect，左栏阶段清空且不再恢复。项目覆盖路径同样中招，一并修复。
