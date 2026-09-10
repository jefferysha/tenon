# Implement — 技能产出自动登记与每回合技能状态

## 1. kernel
- [x] `documents/document-paths.ts`：`canonicalDocumentPaths`（+ 测试：{change} 替换、{capability} glob、不存在 → []）。
- [x] `documents/auto-register.ts`：`autoRegisterDocuments`（+ 测试，用真 tmp 目录：登记 / 重登 / skip / 非候选 / 失败不抛）。
- [x] `index.ts` 导出。

## 2. cli / hooks
- [x] `nativeSkillReceipt.ts`：确认成功后自动登记；stderr 一行汇总。集成测试：写文件 → 回执 → 台账。
- [x] `hooks/skill-start.sh` + `hooks/hooks.json` PreToolUse 登记；`tools/test-hooks.sh` 用例。
- [x] `npm run bundle`。

## 3. server
- [x] `skillRuns.ts` + 接入 `snapshot.ts` 的 change 拼装；`types.ts` 增字段；测试。

## 4. web
- [x] `types.ts` 增 `skillRuns?`；`workspace/StageSkills.tsx`；`TaskDetailPane` 接入；i18n；测试。

## 5. 门禁
```bash
npm run typecheck:web && npm run test:web
npx vitest run packages/kernel packages/server packages/cli
npm run test:hooks
npm run check:design-scale && npm run check:comments
npm run build:web && npm run build:server && npm run bundle
```
