# 执行计划：轨道只认工作流分支

## 顺序

1. **删命令实现**：`packages/cli/src/commands/tracks.ts` 移除 `cmdTracksCreate` / `cmdTracksUpdate` / `cmdTracksDelete` 及仅供它们使用的辅助（`expandPolicy`、`scanActiveChanges`、`TracksCreateOpts` / `TracksUpdateOpts`）。保留 `cmdTracksList` / `cmdTracksShow` / `TracksCommonOpts`。
2. **删接线**：`packages/cli/src/program-tracks.ts` 移除三个子命令注册，更新 `tracks` 顶层 description 与 bare 用法提示为 `list|show`。
3. **改测试** `packages/cli/src/tracks.integration.test.ts`：删 `create` / `update` / `delete` / `缩 allowed 引用完整性` / `防 memoization 回归` 五个 describe；保留 `list/show（只读）`，同步 bare 用法断言文案。
4. **改测试** `packages/cli/src/track-registry.integration.test.ts`：
   - `init --track data --workflow default` 用例改为断言 **exit 1 + 「工作流 'default' 没有轨道 'data' 的分支」+ 不建 change 目录**，标题改为方案 B 语义。
   - `set track data` 用例：`s1` 是 default 工作流的 change，`set track data` 改为断言 exit 1；补一条 `set track backend`（default 声明了该分支）断言 exit 0，证明拒绝的理由是分支而不是「都不让改」。
   - `check 真读动态 policy` 用例：去掉 `--workflow default`，改走 `data` 的缺省工作流 `data-flow`；给 `DATA_FLOW_YAML` 加一个 `spec` 步骤并把 change 种到 `spec`，保住「真读 coverage_profile=backend 七层矩阵」这个原始意图。
5. **重建**：`npx tsc -b`、`npm run bundle`。

## 验证命令

```bash
npx vitest run packages/cli/src/tracks.integration.test.ts packages/cli/src/track-registry.integration.test.ts
npx vitest run            # 确认这两个文件的 6 个失败清零且无新增
node packages/cli/dist/tenon.mjs tracks --help
```

## 复核门（每一步后）

- 步骤 3/4 后：断言必须是方案 B 的语义（拒绝 + 具体原因），不得只把期望值从 0 改成 1 而不校验原因。
- 步骤 5 后：在临时项目里实跑 `tracks create` 应报未知命令；`tracks list` / `show chat` 仍正常。

## 回滚点

每一步独立可 revert；步骤 1-2（删命令）与 3-4（改测试）互不依赖，可分别回退。
