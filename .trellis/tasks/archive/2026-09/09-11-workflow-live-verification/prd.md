# 工作流实机验证与轨道模型收敛

## Goal

按交接文档 `/tmp/tenon-workflow-handoff-2026-09-11.md` 第 4 节，用 Playwright 在真实浏览器里逐项验证工作流页、技能编辑器（含真实 HTML5 拖放）、工作台；把实测发现的缺陷与第 3 节已知 bug 1 / bug 2 各自拆成子任务修复并回归。

## 实测结论（2026-09-11，Chromium + 真实鼠标事件）

已通过、无需再改：

| 项 | 结果 |
|---|---|
| 5 条轨道切换 | 全部无报错；各轨道 `build` 阶段技能确实不同，轨道是真分支 |
| 阶段拖拽排序 | dnd-kit 指针拖拽生效，顺序改变、「保存 / 放弃」按预期启用 |
| 门禁三选保存 | `立项` 改 `自动` 保存后写入全局 `default.yaml`（`gate: auto`）|
| 全局存储跨项目 | 另一个空项目 `init --track chat --workflow default` 后 `workflow plan` 读到 `open: auto` |
| 技能库真实拖放 | 幽灵预览出现；落在列上 = 「并行 2」，落在末列右侧 = 「串行」，落下后结果与预览一致 |
| 「+」加入 | 串行追加为「第 2 步」|
| 拉线成环 | `verify → tenon-open` 被拒，边集不变；合法连线 `tenon-open → code-review` 接受并重排为 3 波 |
| 技能编辑回写 | YAML 写出 `depends_on: [tenon-open, code-review]`，与画布一致 |
| 工作台 | 项目 → 任务 → 阶段轨切换 → 技能运行状态（已完成 / 未开始）、输入/输出 sheet 切换、行点击打开文件抽屉并渲染内容 |
| 脉冲 | 逐段顺序传递：当前段 `stroke-dashoffset` 95→63→32→2 连续推进，下游段停在 -45 等待 |
| 窄宽度 1279 / 1100 / 900 | 文档 `scrollWidth == 视口宽`，无横向滚动；换行只出现在文件内容预览 Markdown 里，属正常 |

## 实测发现的缺陷

1. **全局 default 一存在，工作流页刷新就坏**：`GET /api/workflows` 返回 `source: "global"`，客户端解码器只认 `builtin | project`，整个列表请求被判「响应形状无效」→ 左栏阶段数 0 + 错误横幅，且「恢复内建」永久 disabled，用户无法退回内建。比交接文档记的「菜单 disabled」严重得多。→ 子任务 `09-11-restore-builtin-global-default`
2. **全局工作流 POST 用例从未真正跑通**：`server.test.ts` 把 token 字符串当作 `reqPost` 的 options 传入，`Authorization` 头没发出，断言卡在 401，自 `4f1c04a` 起一直红。→ 子任务 `09-11-global-workflow-post-auth-header`
3. 仓库里提交的 `packages/cli/dist/tenon.mjs` 落后于源码，未包含全局工作流存储；重建后才读到全局文件。该文件属其它会话在改的 `packages/*/dist`，本任务**只记录不修改、不提交**。

## 子任务

| 子任务 | 范围 | 状态 |
|---|---|---|
| `09-11-restore-builtin-global-default` | `defaultSource` 认 `'global'`；删除 default 后重拉定义；对话框措辞 | 完成 |
| `09-11-global-workflow-post-auth-header` | 全局工作流 POST 用例补 `Authorization` 头 | 完成 |
| `09-11-default-chat-contract-skills` | bug 2，在 default 的 chat 轨补齐契约技能 | 完成 |
| `09-11-track-branch-single-source` | bug 1，方案 B：只认工作流里的轨道分支，删注册表写入面与相关测试 | 完成 |

## Acceptance Criteria

- [x] 四个子任务全部完成并各自实机回归通过
- [x] `npm run typecheck:web && npm run test:web && npm run check:design-scale && npm run check:comments` 全绿
- [x] `npx vitest run` 由本任务负责的 7 个失败清零（track-registry 3 + tracks 3 + server.test 全局存储 1）
- [x] 全局工作流目录不残留测试改动（已清空）

## 全量后端测试：31 → 26

| 文件 | 基线 | 最终 | 归因 |
|---|---|---|---|
| `track-registry.integration.test.ts` | 3 | **0** | 本任务修复 |
| `tracks.integration.test.ts` | 3 | **0** | 本任务修复 |
| `server.test.ts` | 1 | **0** | 本任务修复 |
| `fields.test.ts` | 7 | 7 | `required_when` / legacy artifact 旧断言，另一条线 |
| `artifact.integration.test.ts` | 2 | 2 | 同上 |
| `commands/artifact.test.ts` | 2 | 2 | 同上 |
| `commands/effective-artifacts.test.ts` | 1 | 1 | 同上 |
| `internal-skill-gate-hook.integration.test.ts` | 3 | 3 | 其他会话在改 `hooks/gate.sh` |
| `workflow-skill-orchestration.integration.test.ts` | 2 | 2 | verify-skills 重复 skill 树 + 动态 track router，其他会话 |
| `transition-effects.integration.test.ts` | 8 | 7 | 真 git e2e，跑次间不稳定 |
| `automation/src/runner/runner.test.ts` | 0 | 2 | sandcastle `tenon-afk-run.sh`，其他会话；**把本任务全部改动 stash 后仍一模一样地失败** |
| `kernel/src/loops/ledger-store.test.ts` | 0 | 1 | 并发时序 flake；单独重跑 44/44 绿 |

没有一个残留失败由本任务引入。

## Constraints

- 不碰交接文档第 3 节第 6 条列出的其它会话文件：`hooks/gate.sh`、`hooks/json-input.sh`、`packages/cli/src/codexSkill*`、`packages/kernel/src/catalog/*`、`host-target-plan*`、`definitionCatalog*`、`tools/check-docs*`、`tools/test-*.sh`、`adapters/*`、`.claude/`、`packages/*/dist`。
- UI 改动遵循用户硬要求记忆 `workflow-single-source-and-wording`：同一概念只用一个词、页面上除错误信息外不写句子、名称只显示一个。
