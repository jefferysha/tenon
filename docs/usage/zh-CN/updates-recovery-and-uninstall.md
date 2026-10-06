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

若已安装 launcher 是已退役的 1.x，先为该宿主一次性运行不可变的 `v0.3.0/install.sh` 一行命令完成
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

**与上一个发行版（v0.2.1）的兼容。** v0.3 在正常使用中写下的数据都能被 v0.2.1 读取，所以可以用
`tenon runtime repair --rollback` 回滚，也可以和还没更新的同事在同一个仓库里继续工作：v0.2.1 不会把这些数据判为损坏、被改动或非法，
v0.3 也读得了 v0.2.1 写下的数据。发布门（`tools/test-bundle.sh`）每次运行都在两个版本之间做双向交叉读取。

- **测试运行记录默认不清理。** v0.3 保留一条记录链上的全部记录。想限制一个任务提交的记录条数，运行 `tenon test run` 时设
  `TENON_RECORD_RETENTION=<n>`（例如 `20`）：每次运行之后，每个用户每个任务只保留最新的 `n` 条，并在记录旁留一个 `chain-base` 标记。
  v0.3 读得了这样的链；v0.2.1 不认识这个标记，会把链判为被改动（`找不到链首记录`），直到重跑另起新链。只在仓库里所有跑测试的人都已是
  v0.3 或更新时才设它。内联步骤测试的记录仍按测试项保留最新 20 条。
- **agent 运行的宿主与重跑原因**记在 `.pipeline-agent-runs.jsonl` 旁边的 `.pipeline-agent-run-meta.jsonl` 里，v0.2.1 不读这个文件，
  它的闭集台账读取器照常工作。
- **v0.2.1 写下的记录**在 v0.3 里读作完好的链，但没有本机封存，所以 v0.3 把它们和别的机器写的记录一样当作「来源不明」
  （`record-unsealed`）：运行一次 `tenon test run <change> --stage`，新的运行会另起新链。
- **未声明的测试输出。** v0.3 把目录里没有任何套件声明过的 `coverage/`、`test-results/`、`playwright-report/` 算进工作区，
  v0.2.1 忽略这些目录。有这样目录的工作区里，一个版本写下的运行在另一个版本里显示为过期（候选代码已变）；重跑套件，
  或在目录里声明这些输出（`tenon test discover` 会声明常见的几种）。

你主动选用的能力需要 v0.3；v0.2.1 会把文件判为非法或忽略该设置，这些是有意不让它读的：

- `.tenon/tests/catalog.yaml` 里的 `profile: coarse` 或 `not_applicable:` 列表；
- 写在工作流 `test_policy` 里的 `integrity: notice` 或 `integrity: block`；
- 工作流评审者上的 `host: codex|claude`；
- 自定义 agent 文件里的 `attach_on` 或 `host`（`tenon agent copy security <name>` 写出的副本也带 `attach_on`）；
- `TENON_RECORD_RETENTION`（见上）。

standard 通道（`track: standard`）是 v0.3 的通道，路由可能为小的实现请求选它。v0.2.1 对这类任务报 `未注册的 track 'standard'`
（`list`、`status`、`get` 仍可用），所以回滚之前先完结或归档 standard 任务。

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
