# PRD · 工作流全局化

## 决定（用户 2026-09-11）
工作流是全局的，不属于某个项目；项目里的每个 change 自己选择走哪个工作流、哪条轨道（pipeline）。

## 现状
工作流文件只存在项目目录 `<root>/.pipeline/workflows/*.yaml`（default 覆盖同处）；dashboard 工作流页因此要求先选项目；server 工作流路由以已注册项目 root 为信任锚。

## 目标
- 新增用户级全局存储：`<产品 configRoot>/workflows/.pipeline/workflows/*.yaml`（复用 `resolveProductPaths`，`TENON_RUNTIME_HOME` 可重定向；目录形状与项目一致，server 受信读写层零改动）。
- kernel `loadWorkflow(repoRoot, name)` 解析顺序：内建（simple）→ 项目文件（遗留兜底）→ 全局文件 → null；`projectWorkflowNames` 合并全局目录。
- server 工作流路由（GET 列表 / GET 单个 / GET·PUT yaml / POST / DELETE）：`root` 为空 = 全局存储；`source` 新增 `'global'`。带 root 的 GET 单个：项目文件 → 全局文件 → 内建模板，供工作台按 change 解析。
- dashboard 工作流页不再要求选项目：`WorkflowView root=""`，删除项目门与 per-root 草稿保留逻辑；来源标签 内建 / 全局；导航离开守卫只看视图切换。
- change 侧不变：`tenon init --workflow --track` 已能选流水线；工作台按 change 的 workflow/track 显示。

## 非目标
- 不迁移已有项目文件；不删除项目级读取（作为遗留兜底保留，dashboard 不再编辑它）。

## 验收
- [ ] kernel：全局目录有文件、项目无 → loadWorkflow 返回全局；两者都有 → 项目优先；`projectWorkflowNames` 含全局名。
- [ ] server：`GET /api/workflows`（无 root）列全局；`POST /api/workflows/x`（root ''）写到全局目录；`GET /api/workflows/default?root=<项目>` 无项目文件时返回全局覆盖并标 `global`。
- [ ] dashboard：未选项目也能打开工作流页并保存；来源显示 全局；App 测试更新。
- [ ] 全部 vitest（kernel / server / cli / web）、design-scale、comments、build 通过。
