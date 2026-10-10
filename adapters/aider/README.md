# aider pipeline 适配器（lite，档 B）

> 契约：`adapters/contract.md`。本 adapter 把 aider（paulgauthier/aider）能力映射到 pipeline 三能力：
> **inject/track 走 aider 自身原语（"native"）、veto 降级为 commit-gate 静态约定**（档 B）。

## 研究结论（2026-07-07 spike，非假设）

调研 aider 官方文档（`aider.chat/docs/config/aider_conf.html`、`docs/usage/lint-test.html`、
`docs/usage/conventions.html`）确认 aider 的实际能力面：

- **无 pre-tool hook 原语**：aider 没有"写入文件前拦截"的钩子——`lint-cmd`/`test-cmd` 只在**编辑之后**
  运行（`auto-lint`/`auto-test`），不能阻止写入本身发生。这就是 veto 必须降级的根本原因。
- **`read:`（`.aider.conf.yml`）**：只读静态文件列表，aider **每次进程启动都重新读盘**（非缓存）——
  这是 aider 唯一"会话级自动生效、无需人工 attach"的上下文原语。虽然内容本身是静态文件，但只要在
  下次启动前刷新过文件内容，效果就等价 SessionStart 的新鲜注入（比 cursor"完全没有会话注入原语、
  只能退化成一次性静态层"更强一档），故本 adapter 把它归类为 **native**，非 degraded。
- **auto-commit**：aider 默认每次编辑后自动 `git commit`——这是 aider 最接近"工作单元边界"的
  真实、自动触发点，因此 track 挂在 git `post-commit`、veto 挂在 git `pre-commit`。

## 三能力

```yaml
inject:
  status: native
  impl: hooks/inject.sh 生成内容 → install.sh 写入 .aider-pipeline-context.md → .aider.conf.yml read: 引用
  note: "aider 每次启动重新读盘 read: 文件（非缓存）；只要会话前刷新过即等价新鲜注入"
veto:
  status: degraded
  fallback: commit-gate                # .git/hooks/pre-commit：检查新鲜 marker，命中则阻止 commit（非零 exit）
  note: "aider 无 pre-tool hook 原语——只能在 commit 粒度拦截，写入动作本身已先发生；
         依赖 aider auto-commit 默认行为（--no-auto-commits 会使本 gate 不触发）"
track:
  status: native
  impl: hooks/track.sh 装作 .git/hooks/post-commit，真 append history（把 commit 当工作单元）
  note: "aider 无 Skill/Agent 概念——track 语义诚实再解释为「记一次 commit」，记录格式与
         codex/cursor/gemini/pi 同构（kind=tool, raw=\"Skill: aider-edit\"）"
```

**为什么 veto 是"降级"而 inject/track 敢叫"native"**：三者都不是 aider 的逐工具调用钩子，但
inject（`read:`）与 track（git commit 钩子）都是 aider **真实存在、自动触发、无需人工介入**的原语，
只是需要诚实地把"会话"/"工具调用"再解释为 aider 的实际工作单元（进程启动 / commit）。veto 则有
一个真实、无法绕过的语义损失——**写入已经发生**，commit-gate 只能挡"入库"、挡不住"写盘"，
所以诚实标降级（contract §1 红线：不伪装硬拦）。

## 安装

```bash
adapters/aider/install.sh --target <项目目录>   # 默认 $PWD，需要 git 仓库
adapters/aider/install.sh --no-git-hooks        # 只装 .aider.conf.yml + 上下文文件（跳过 veto/track）
```

或经顶层派发器：`adapters/install.sh --aider --target <dir>`。

投影产物：

| 文件 | 作用 |
|---|---|
| `.aider.conf.yml` | 若已存在则不覆盖（写 `.pipeline-adapter` 建议文件供手动合并 `read:`） |
| `.aider-pipeline-context.md` | inject 内容（安装时 + 每次重跑本脚本时刷新） |
| `.git/hooks/pre-commit` | veto 降级：commit-gate（若已有陌生 hook 则不覆盖，写建议串联文件） |
| `.git/hooks/post-commit` | track：真 append history（同上不覆盖策略） |

刷新时机：phase/门状态变化后，`.aider-pipeline-context.md` 不会自动更新——重跑
`adapters/aider/install.sh`（幂等）即可刷新内容与 git hook 绝对路径。

## 人工确认（HITL · veto 降级路径）

veto 降级为 commit-gate 不会改变 review 的授权语义：完成产物并选择 event 后运行
`tenon review request <change> --event <event>`，然后等用户确认：用户在 Dashboard（`tenon dashboard --open`）
确认，或由**用户本人在自己的终端**运行 `tenon review acknowledge <change>`；agent 不得代为执行该命令
（持续授权下只可用 `--delegated`，它不批准待批准的测试豁免）。不得手动删除 `.pipeline-pending-review`。

## 已知局限（诚实登记）

- `--no-auto-commits` 会让 aider 不再自动提交，此时 commit-gate（veto）与 post-commit（track）
  都不会被触发——文档中已明确提示，不属于本 adapter 的隐藏缺陷。
- 非 git 仓库：`install.sh` 会跳过 git hook 投递（打印警告），仅装 `.aider.conf.yml` + 上下文文件。
- `.aider.conf.yml` / 既有 git hook 若已被用户占用，本 adapter 一律**不覆盖**，改写
  `*.pipeline-adapter` 建议文件——与 cursor/codex/copilot 的"不覆盖陌生配置"约定一致。
