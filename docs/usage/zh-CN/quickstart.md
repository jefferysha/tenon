# 第一个受治理任务

开始本教程前，先一次安装不可变的 Codex 预构建发布包：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.3.4/install.sh | /bin/bash -s -- --codex
```

该命令不 clone 仓库，也不从源码编译；它会安装打包好的 `v0.3.4`、启动并验证 Dashboard，
然后打印本机 URL 和 `tenon dashboard --open`。管道安装不会自动打开浏览器。安装完成后，
日常更新只需一条 `tenon update --codex`，并始终绑定稳定 release tag。

本教程用 default workflow 完成一次端到端 Change，并展示 Todo、OpenSpec、Skill、review 和验证如何串联。

## 目标

从一次正常对话创建独立 Change，依次经过 Open、Explore、Spec、Build、Verify、Ship 和 Archive，并能用状态、步骤产出记录和实际测试证明每次推进都成立。

## 前置条件

- 已按[安装与宿主配置](./installation.md)完成对应宿主 setup；
- 当前目录是可写项目，且没有把另一个项目的 Dashboard 误当成当前服务；
- 你知道要实现的可观察结果，但不需要预先写好 OpenSpec；
- 对真实发布、push 或外部部署是否授权仍以当前任务要求为准。

## 步骤

### 1. 从正常对话提出目标

直接描述要实现的结果，例如：

> 为登录页增加响应式错误提示，并在真实浏览器验证键盘操作。

正常开发对话会先经过路由。纯问答不会创建 Change。不带重型信号的开发请求，agent 先读代码，对预计要改的文件运行 `tenon assess`，把推荐（轻量轨道，或改动太大时的重型轨道）摆给你，你确认后才创建 Change；迁移这类重型请求直接进入领域重型轨道。本教程按重型轨道（default 的 frontend 轨道）的七阶段讲。任务结束后，它在工作台的「已结束」分类里带着结果标记。

### 2. 确认 Change

```bash
tenon list --json
tenon status <change> --json
```

`tasks.md` 的一级结构来自真实 workflow。default 展示七阶段；custom 只展示自己的 DAG，不会被硬套 PM、前端或后端步骤。

在 Git 仓库的主检出里，新 Change 建在它自己的 worktree 里，而不是你启动命令的目录。`tenon list` 会告诉你它在哪（`WORKTREE` 列，
`--json` 里的 `worktree`），见[任务在哪里](#任务在哪里任务-worktree)。

### 3. 完成三个前置阶段

- Open：明确问题、范围、非目标和验收信号；
- Explore：调研、方案比较和设计；
- Spec：增量需求、场景和文件级计划。

每个步骤只会拿到直接上游写出的文档，必须读完并用 `tenon document read <change> all` 留下读取回执才能离开，不能只说“已经看过”。

在每个 review 出口，先完成产物和检查，再请求精确事件的 review。进入 Explore 本身不代表“等待确认”；只有产物完成并执行 `review request` 后，状态才应显示等待。

### 4. Build 与 Verify

Build 按计划测试先行，实现后先跑类型、测试和构建。`build-complete` 冻结 `build_sha`；Verify 只验收这个基线。发现实现缺陷走 `verify-fail` 返回 Build，发现需求变化走 `requirements-changed` 返回 Spec。

Verify 期间不要修改实现文件。若审查发现缺陷，先写失败报告并走回边；回到 Build 修复后必须重新冻结新基线，不能沿用旧报告。

### 5. Review 与交付

review phase 的正确顺序：

```bash
tenon check <change>
tenon review request <change> --event <event>
# 用户确认之后：
tenon transition <change> <event>
```

确认只来自用户：回复放行语（hook 写回执）、在 Dashboard 确认，或由用户本人在自己的终端运行 `tenon review acknowledge <change>`；agent 不得代为执行。

持续授权可以记录 delegated acknowledgement，但不会跳过文档、读取、guard 或验证。

### 6. 检查最终状态

```bash
tenon status <change> --json
tenon document status <change>
```

归档前，任务清单应没有当前及更早阶段的未完成项；applied spec 应对应已经验证的 delta；Archive 应读完 Ship 交接来的文档。`tenon document status` 列出本步的输入（已读 / 未读）、已经写出的文件与来源技能，以及必须产出。

## 任务在哪里：任务 worktree

在 Git 仓库的主检出里，`tenon init` 给每个新 Change 建一个自己的 worktree。同一个仓库里的多个任务就能并行：谁也看不到别的任务改了哪些文件、
登记了哪些测试，构建指纹也互不相干。

| 项 | 值 |
| --- | --- |
| worktree | `<项目>/.worktrees/<change>` |
| 分支 | `tenon/<change>`，从当前 `HEAD` 分出，不跟踪任何上游 |
| 任务字段 | `base_branch` 是你出发时所在的分支，`start_sha` 是那个 `HEAD`，`isolation` 已经是 `worktree` |

没有任何忽略规则覆盖 `.worktrees/` 时，它会被追加进仓库的 `.git/info/exclude`，所以不改任何受版本控制的文件，主检出的 `git status` 也不变。
创建要么全成要么全不成：`init` 失败时 worktree 与分支会被撤掉；同名路径或分支已存在时 `init` 退出 `1`，两者都不动。

**改为原地建立的情形。** 此时 `isolation` 没有预设，`tenon init` 会在 stderr 说明原因（`[INIT] 原地建立任务，不建 worktree：<原因>`）：

- 当前目录不是 Git 仓库（或不是仓库根目录）；
- 仓库还没有任何提交；
- `HEAD` 处于分离状态；
- 当前目录本身已经是一个 linked worktree；
- 你传了 `--in-place`（确实要原地时才用；用户不要求时 `tenon` 技能不会传），或设置了 `TENON_INIT_IN_PLACE=1`（Tenon 自己的测试工装用它，不打印原因）。

AFK 分诊建的 Change 一律原地建立。

**切进去。** 文本输出时 stdout 为空，stderr 的最后两行是 `worktree: <绝对路径>` 和切进去的做法。加 `--json` 时 stdout 只有一行：

```json
{"change":"<名字>","path":"<change 目录>","worktree":"<绝对路径或 null>","worktree_reason":"<原因或 null>"}
```

建了 worktree 时 `worktree_reason` 是 `null`，否则是 `not-git`、`no-commits`、`detached-head`、`linked-worktree`、`requested` 之一。
Claude Code 里 `tenon` 技能用 `EnterWorktree`（`path` 就是该 worktree）切进去，再执行 `tenon session activate`；此后的命令、评审确认与 hook 都以该
worktree 为项目根。Codex 没有对应能力：技能请你在该目录开新会话，并结束本轮。恢复一个建在 worktree 里的任务时同理：dispatch 带着
`worktree_path`，先切换。

**准备 worktree（`setup`）。** 新 worktree 里没有装好的依赖，也没有构建产物。测试目录可以声明顶层的 `setup` 命令，这条命令已受信任时，
`tenon init` 会在新 worktree 里执行它（输出转到 stderr）：

- 信任按用户、仓库、单条命令摘要记录，同一仓库的所有 worktree 共享，所以没有什么要「带进」新 worktree：这条 `setup` 你已经信任过
  （在主检出或任何 worktree 里运行过 `tenon test trust`）就立即执行。还没信任的 `setup` **不会**执行，`init` 打印该命令，并请你自己运行
  `tenon test trust` 确认（agent 不能替你确认），再手动执行 setup。worktree 里是已提交的目录，主检出里对 `setup` 的未提交改动不算，以已提交的那条命令为准。
  之后改了这条命令同样要重新确认。
- 信任绑定的是命令文本（目录的命令摘要），不绑定命令执行时读取的仓库文件，例如 `package.json` 的生命周期脚本、它调用的脚本；这与测试套件的信任方式相同。
  所以 `setup` 一旦被信任，之后的提交改了这些文件，`init` 会在新 worktree 里直接执行改过的版本，不再询问。不想自动执行 `setup`，
  用 `tenon init --in-place` 建任务，或从目录里去掉 `setup`。
- `setup` 失败只给 WARN，并给出重跑的命令（`WARN: [SETUP] …`），`init` 的退出码仍是 `0`。没有目录、目录无效或没有 `setup` 键，都会说明并跳过。
- 本仓库的 `.tenon/tests/catalog.yaml` 声明了 `setup: npm ci && npm run build:packages`；改这条命令之后要重新 `tenon test trust`。
- `setup` 可能要几分钟。执行 init 的 shell 调用要给足超时（技能用 600000 ms）；超时只会中断 `setup`，任务已经建好，用 `tenon status <change>` 确认。

**再次找到任务。** `tenon list` 有 `WORKTREE` 列（`--json` 里是 `worktree`）：绝对路径；当前根自己的任务显示 `-` / `null`。在主检出里执行时，它还会列出
`.worktrees/` 下未归档的任务。按名字读取任务的命令（`status`、`get` 等）仍然要在任务自己的根里执行：在主检出里会报
`change 不存在: <名字>（它建在 worktree <路径> 里；切到该目录再执行）`（`TENON_LANG=en` 时是英文 `change not found: <name> (it lives in the worktree <path>; …)`）。`tenon workflow progress`
是例外，在主检出里也能找到任务。主检出里只剩 worktree 任务可继续时，泛泛说一句“继续”，会把这些任务连同路径列出来，请你点名其中一个。

**完结。** 交付与完结都在 `tenon/<change>` 分支上进行。任务归档后，Tenon 把 worktree 与分支留在原处，只报告清理命令（出现在 `finish-change` 动作和
`finished` 的 `stop` 里，字段是 `cleanup`）：

```bash
git worktree remove '<路径>' && git branch -d 'tenon/<change>'
```

要自己在主检出里执行（不能在要删的 worktree 里执行），时间由你定。`git branch -d` 会拒绝还没合并的分支，所以不会丢提交。Dashboard 把每个 worktree 登记为
单独的项目，没有跨 worktree 的统一视图。

## 终端里的步骤清单

`tenon init`、`tenon session activate`、`tenon transition` 或 `tenon step run <change>` 成功后，一个 PostToolUse hook 会在终端打印一行，数据来自这个
Change 冻结的计划：已过的步骤是 `✓`，当前是 `●`，没到的是 `○`，Change 归档后全是 `✓`：

```text
Tenon · <change>
立项 ✓ → 调研 ● → 规格 ○ → 实现 ○ → 验证 ○ → 交付 ○ → 完结 ○
```

标签就是工作流声明的标签。同一行也可以用 `tenon workflow progress <change>` 得到。遇到回退边（例如 `verify-fail` 回到实现）时，后面的步骤会重新显示为
`○`，这是预期行为。清单不依赖宿主的 Todo 工具（较新的 Claude Code 模型默认不提供）；宿主有 Todo 工具时，技能还会按
`tenon workflow plan <change> --json` 建 Todo。hook 只在宿主报告命令成功之后运行，所以失败的命令不会打印；hook 出任何问题都只是不打印而不是报错，
想看这一行时自己执行 `tenon workflow progress <change>`。

## 预期结果

- Todo 一级项与实际 workflow 步骤一致；
- 每一步写出的文件都被记录，带来源技能或「未知」；各步的必须产出（proposal、设计、delta spec、计划、验证报告）都已写出；
- 下一阶段对直接上游的文档留有读取回执；
- review receipt 绑定准确 phase/event；
- Verify 失败会回到 Build，而不是强行进入 Ship；
- Archive 后 Change 不再作为新目标的自动恢复对象。

## 验证

```bash
tenon list --json
tenon status <change> --json
tenon document status <change> --json
```

对含 UI 的任务还要打开真实页面，检查桌面、窄屏、键盘、主题和控制台。对安装/更新任务要在干净临时目录验证，不用当前开发工作区冒充新用户环境。

## 常见失败

- 正常对话恢复了旧 Change：确认用户是否明确说“继续”；独立目标应创建新 Change；
- Todo 不是 workflow 步骤：检查 `tasks.md` 是否由真实 effective workflow 生成；
- 文件存在但必须产出仍缺失：它必须是本任务里这一步新增或修改的；转换因输入未读被拒：执行 `tenon document read <change> all`；
- UI 显示等待：查看是否真的存在 pending review，还是 AFK 仍在 queued；
- 刚建的 Change 报 `change not found`：在 Git 仓库的主检出里，新 Change 建在 `.worktrees/<change>`。报错里有 worktree 路径，切到该目录再执行
  （Claude Code 用 `EnterWorktree`，Codex 在该目录开新会话）；`tenon list` 列出每个任务及其路径，见[任务在哪里](#任务在哪里任务-worktree)；
- Verify 报 workspace drift：回到 Build 重新冻结，不删除证据文件绕过；
- Pages 或 push 未成功：如实保留为未验证项，不能仅因本地构建通过就声称上线。

## 下一步

深入阅读[Default 七阶段工作流](./default-workflow.md)和[文档、Skill 与证据链](./documents-skills-and-evidence.md)。
