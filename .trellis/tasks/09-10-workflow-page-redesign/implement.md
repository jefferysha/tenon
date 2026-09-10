# Implement — 工作流页重设计

## 1. kernel
- [x] parse / validate / selectTrackBranch(Ir) / planFromIr：steps ⊕ tracks；缺分支抛错；无轨道取第一条分支。
- [x] default.yaml 去顶层 steps；生成器 `_base` 可选；`generate:default-workflow`；历史指纹测试夹具。
- [x] 测试更新 + 新用例。

## 2. cli / server
- [x] init / 创建路由：缺分支错误 → exit 1 / 400（透传 kernel 错误文案）。
- [x] `workflowBranchesForApi` 无 `_base`；`/api/skills/:name/files`、`/file`；删 readme；测试。
- [x] bundle。

## 3. web
- [x] 编辑器分支模型（无「通用」）；`SkillDetailDrawer`；`StageFlow`（sortable + Flip）；`StageEditorPane` 重排；`SkillComposer` 三栏 + 详情 + 落区；`motion.ts` Flip 工具；memo 与 DragOverlay。
- [x] i18n；测试。

## 4. 门禁与收尾
```bash
npm run typecheck:web && npm run test:web
npx vitest run packages/kernel packages/server packages/cli
npm run check:default-workflow-freshness && npm run check:default-skill-matrix
npm run check:design-scale && npm run check:comments
npm run build:web && npm run build:server && npm run bundle
```
浏览器核对 1440 / 1200；重启 :18765；规格更新；只提交本任务文件；finish-work。
