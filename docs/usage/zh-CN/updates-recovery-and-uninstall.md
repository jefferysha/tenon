# 更新、恢复与卸载

Tenon 把插件 release 与项目 Change 分离。更新切换已验证的不可变 release，不改写项目证据。

## 目标

安全完成宿主指定更新、运行时修复或回滚；必要时恢复一个明确 Change；卸载时只删除插件拥有的用户级资产，并保留用户仓库里的 Change、Archive 和自定义配置。

## 前置条件

- 知道当前安装宿主是 Codex 还是 Claude Code；
- 能运行 `tenon doctor` 和 `tenon runtime status`；
- 更新前保存当前错误、active release 和项目状态；
- 不在运行中的 Build/Verify 中途手工替换项目证据；
- 外部发布或删除用户数据仍需要独立授权。

## 步骤

### 1. 更新指定宿主

若已安装 launcher 是已退役的 1.x，先为该宿主一次性运行不可变的 `v0.1.2/install.sh` 一行命令完成
迁移；1.x 排在所有 0.x 之下，1.x 上的 `tenon update` 只会报告降级且不做任何改动。
从 v0.1.0 起，下面这条命令就是唯一的常规一键更新入口。

```bash
tenon update --codex
```

或：

```bash
tenon update --claude
```

更新的是所选宿主中的一个完整 Tenon 插件；没有第二套 CLI 自更新通道。自动更新与手动更新使用
同一事务，并保留版本、失败原因和 managed runtime 回滚路径。新模板只影响之后创建或明确缺失的文档。
宿主 cache 由宿主 CLI 独占，Tenon 只提交自己的不可变 runtime、launcher 和 Dashboard 边界。
更新完成后只读扫描 Tenon config root 的项目注册表；发现旧项目时输出显式 `tenon sync` 命令，
不会后台改写工作区、OpenSpec 或未提交文件。

启用每天最多一次的宿主级自动检查：

```bash
tenon setup --codex --auto-update
```

自动更新是明确 opt-in，且只更新所选宿主。它先校验完整候选并原子切换 managed release；当前会话
继续使用已经加载的 Skills/hooks，新会话才使用新版。Codex 若要求重新信任变更后的 hook，必须由用户
在 `/hooks` 完成，Tenon 不会绕过。

### 旧身份迁移

旧插件 ID 不能靠普通更新自动改名。Tenon 因此把旧仓库冻结为 migration-only 通道：

1. 旧 bridge 安装并验证 `tenon@tenon`；
2. Tenon 原子激活新 runtime，并保留旧 active/登记；
3. 新宿主会话实际执行 Tenon SessionStart 后写入本机证明；
4. bridge 复验 inventory、runtime、launcher 和旧 launcher 摘要；
5. 只有全部通过才删除旧插件、旧 marketplace 与仍未被用户修改的旧 launcher。

主动迁移窗口截止 `2026-10-31`。失败、外部 symlink、文件摘要变化、未知 scope 或缺少新会话证明时
都停止清理并保留可恢复状态；Tenon 主包不提供旧命令 alias。

### 2. 检查更新结果

```bash
tenon doctor
tenon runtime status
```

受管 launcher 指向内容寻址 release。不要直接覆盖当前 payload；完整下载、校验和激活应在切换指针前完成。

### 3. 受控修复与回滚

```bash
tenon runtime status
tenon runtime repair
tenon runtime repair --rollback
```

repair 处理 launcher、release 或激活指针，不等于重置项目状态。文档语言固定在独立、旧 runtime 不会重写的 Change sidecar 中，因此 rollback 不需要让旧 canonical codec 理解新 locale 字段。

### 4. 恢复明确 Change

```bash
tenon list --json
tenon status <change> --json
tenon session activate <change>
tenon document status <change>
```

只有明确选择 Change 才恢复。多个候选不能按 mtime 猜测；独立新目标应创建新 Change。

### 5. 卸载 Codex 宿主集成

```bash
codex plugin remove tenon@tenon --json
codex plugin marketplace remove tenon --json
```

以上命令只删除 Codex 的 Tenon 插件登记和 Marketplace 登记。项目内 Change、Archive、OpenSpec、ADR 和用户自定义 Workflow 默认保留。

`tenon uninstall --yes` 是项目资产 scrubber，不是宿主插件卸载命令；它只删除当前项目中由 Tenon 管理且未被用户修改的资产。

## 更新不应修改什么

- `openspec/changes` 已有 Markdown；
- Archive；
- `.pipeline-documents.json` digest/read receipt；
- `.pipeline-document-locale.json` 的固定语言；
- 项目自定义 Workflow/Track；
- 用户数据、token 和凭证。

## 预期结果

- 更新成功后 launcher 指向完整、已校验的新 release；
- 更新失败时旧 release 仍可运行；
- rollback 后旧 runtime 能读取原 canonical state；
- 已有 Change 文档字节和 digest 不变；
- Tenon 自有机器状态只位于平台标准 Tenon data/state/config，不落入宿主目录；
- 新会话加载新的 skills/hooks，旧会话不被误报为已热更新；
- 卸载后用户仓库证据仍在。

## 验证

```bash
tenon doctor
tenon runtime status
tenon list --json
tenon status <change> --json
```

重新打开宿主会话，并核对 CLI、skills、hooks、Dashboard 和项目状态。对自动更新还要在干净临时目录验证首次安装、升级、失败回滚和重复执行幂等性。

## 常见失败

- `tenon update` 未指定宿主：改用 `--codex` 或 `--claude`；
- 更新后旧会话仍使用旧 Skill：关闭并新开会话；
- runtime repair 之后 Change 消失：检查项目根，不要把 runtime 修复和项目删除混为一谈；
- rollback 报 canonical 未知字段：新元数据不应进入旧 codec 的严格闭集，修复发行兼容缺陷；
- 卸载删除了用户修改文件：ownership/hash 逻辑有缺陷，应停止并恢复备份；
- 更新后文档被自动翻译：这是不允许的历史改写，应回滚并报告。

## 下一步

若问题仍存在，按[故障排查](./troubleshooting.md)采集最小事实面；安全问题使用私密漏洞报告。
