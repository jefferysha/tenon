# Amp（Sourcegraph）pipeline 适配器（lite，档 A 全保真）

> 契约：`adapters/contract.md`。本 adapter 把 Amp 的插件能力映射到 pipeline 三能力。
> **与 codex/gemini/continue 不同构**（如实标注）：Amp 没有"外部命令 + stdin JSON + exit code"
> 式 hook 协议，其原生扩展机制是**进程内 JS/TS 插件**。三能力全部能在该原生机制上做到
> 真硬拦 / 真会话级注入 / 真留痕，故仍归类档 A——但载体形态与其余 A 档平台不同，本文件完整
> 记录研究方法、证据链与诚实边界。

## 一、任务背景：为什么要"spike 实证"而非直接照抄 longtail 目标档

`registry.yaml` longtail 原条目写"Amp hook 协议**若**与 CC 同构则三能力 native……待 spike 实证"——
这是一个**有条件的假设**，不是结论。本轮工作的核心就是把这个条件判定清楚，如实落地，不因为
"目标档已经写了 A"就跳过验证直接照抄。

## 二、研究方法（分层递进，越往下证据越硬）

1. **官方文档**（`ampcode.com/manual`、`ampcode.com/news/hooks`，WebFetch/WebSearch）：
   了解到 Amp 有"Hooks"概念（`amp.hooks` 数组）与独立的"Plugin API"（`amp.on(event, handler)`），
   两者在不同文档页口径不完全一致，无法仅凭这层确认真实 shape。
2. **GitHub 示例仓库**（`sourcegraph/amp-examples-and-guides`）：未见 hooks/plugin 具体样例。
3. **反编译已发布 npm 包的真实二进制**（本轮最关键的一步，非纯文档摘要）：
   - `npm pack @ampcode/cli` 拿到的是个 2.3KB 的平台探测 + postinstall 转发壳，真正的
     可执行体是按平台分发的 optionalDependency（如 `@ampcode/cli-darwin-arm64`，本机
     实测约 70MB，Mach-O 可执行文件）。
   - 用 `npx --yes @sourcegraph/amp --version` 在本沙箱**真实下载并跑通**了这个二进制
     （版本 `0.0.1783401425-gc7fcc1`，发布于研究当天 1 小时前——非陈旧构建）。
   - 对该二进制跑 `strings -a`，逐字捞出未混淆的字符串常量与事件分发逻辑源码片段，确认：
     - 事件分发表字面量：`event:{sessionStart:_T,toolCall:xT,toolResult:gT,agentStart:qT,agentEnd:pT}`；
     - `tool.call` 的动作分支：`if(uT.action==="reject-and-continue")return uT;`（与 `"allow"`/
       `"synthesize"`/`"modify"`/`"error"` 并列判断，说明这是一个**真实被区分处理**的独立分支，
       不是文档夸大的死代码）；
     - `session.start` 去重逻辑：`if(yT.startedSessionStartThreadIDs.has(ST))return; ... .add(ST)`
       ——证实"每 thread 只触发一次"；
     - 插件文件发现逻辑只接受 `.js`/`.ts` 扩展名（`W6T(ST.name); return VT===".js"||VT===".ts"`）——
       故本适配器**不能**用 `.mjs`；
     - `amp config edit` 内建的示例配置输出（按字母序列出全部 `amp.*` 顶层键：
       `dangerouslyAllowAll…guardedFiles…keymap…mcpServers…permissions…tools.disable…`）
       **不含 `hooks` 键**——这与"amp.hooks 数组"的文档措辞矛盾，说明声明式 `amp.hooks`
       很可能已被 Plugin API 取代/未在当前版本暴露，**Plugin API 才是当前真实、可用的机制**。
   - `gh search code` 直接搜 `continuedev/continue`、`cline/cline` 开源仓库源码做交叉验证方法论
     （详情见 `adapters/continue/README.md`、`adapters/cline/README.md`）——本文件用同一方法论
     处理 Amp（闭源二进制），只是把"读源码"换成"读反编译字符串"，证据强度类比。

## 三、研究结论：Amp 真实拥有的三能力原语

| 能力 | Amp 原生机制 | 强度 |
|---|---|---|
| veto | `tool.call` 事件，handler 返回 `{action:"reject-and-continue", message}` | **真硬拦**——分发表明确把它与 `"allow"` 分开处理，不是 advisory |
| track | `tool.result` 事件，工具执行完成后触发，handler 可观察/记录 | **真留痕**——事件在执行后必然触发 |
| inject | `agent.start` 事件（每回合触发），handler 可返回 `{messages:[{content}]}` 注入内容 | **真注入**——`session.start`（每 thread 仅一次）本身不支持内容注入，实际投递点在 `agent.start`；本 adapter 用"session.start 标记新线程 + agent.start 首回合消费"模拟"每会话一次" |

三者都是 Amp 官方文档承认的"deterministically override Amp's behavior"用途（非本适配器擅自挪用的
副作用），且反编译证据确认它们在当前发布版本里真实存在、真实分支处理——故三能力全部落在
**contract.md 档 A 的判据**（"三能力均在目标工具原生 hook 上等价实现"）上，不是靠伪装凑数。

## 四、为什么与 codex/gemini/continue"不同构"，但仍是档 A（不是新档位）

contract.md §1 对档 A 的定义是**能力保真度**（硬拦 veto / 会话级 inject / 真留痕 track），
不是"必须用 exit-code + stdin JSON 这套传输协议"。Amp 的插件系统：

- **传输层不同构**：Amp 插件是常驻进程（Bun 加载 `.amp/plugins/<name>.js`），通过 RPC 式
  `amp.on(event, handler)` 注册回调、以*返回值对象*表达决策；不是"每次调用重新 spawn 一个
  外部命令、用 stdin JSON 传入、用 exit code 传出"。
- **能力保真度不打折**：`reject-and-continue` 是真阻止执行（不是"仅记录、仍放行"的降级
  advisory）；`tool.result` 是真实存在的执行后钩子；`agent.start` 的 messages 注入是真实
  会话内容投递，不是静态文件兜底。

这与 pi（真降级——Pi 压根没有 pre-tool 硬拦原语，只能退化成 advisory + CLI review receipt）、
cursor/copilot（真降级——真的没有会话级 inject 原语，只能退化成静态文件）性质不同：Amp 是
"载体形状不同、能力不打折"，pi/cursor/copilot 是"能力本身有真实缺口"。故如实判定为档 A，
不因载体形状不同而降档，也不因"载体不同"就假装是同构而简化描述。

## 五、诚实边界（未验证 / 置信度较低的部分，明确列出）

1. **未经真实 Amp 会话端到端实测**：本沙箱没有有效 Amp 登录态（`amp login` 需要真实账号/浏览器
   OAuth），无法真正跑一个 `amp` 会话去触发 `session.start`/`agent.start`/`tool.call`/`tool.result`
   并观察真实 event payload 长什么样。研究依据是**文档 + 反编译字符串**，比纯文档摘要扎实，
   但仍**不是**这个仓库对 cursor 那样的"spike NOTES.md 实测记录"级别证据。
2. **event payload 具体字段名是推断，非实测确认**：反编译只捞到了分发逻辑本体（事件名、动作名、
   去重语义），没能捞到 TypeScript 接口定义级别的字段清单。本插件对 `cwd`/`tool` 名的提取用了
   防御性多路径兜底（`extractCwd`/`extractToolName`，见 `plugins/pipeline.js` 尾部），如果真实
   字段名对不上，这一小段提取逻辑需要被修——但**不影响**已验证正确的核心决策逻辑
   （`decideToolCall`/`buildInjectContext`/`recordToolResult`，见下方「可测性设计」）。
3. **`ctx.$` Bun shell 模板未采用**：官方文档提到插件可用 `ctx.$` 跑 shell 命令，但其默认 cwd
   是插件文件自身所在目录（反编译证实 `pluginCwd=this.pluginFile.scheme==="file"?dirname(pluginFile)…`），
   不是项目根——本适配器改用 Node 内建 `child_process.spawnSync` 并显式传入 cwd，绕开这个坑，
   但也意味着没有直接验证 `ctx.$` 本身的行为。
4. **一次性人工步骤**：需要在 Amp TUI 里跑一次 `plugins: reload`（或重启 amp）插件才生效——
   与 Codex 的一次性 trust 步骤同理，不降档（见 install.sh 输出提示）。

如果未来有真实 Amp 登录态做端到端验证，应回填本文件与 `registry.yaml` 的置信度描述
（GOAL C9/C10 同一诚实门：文档口径与实测冲突时以实测为准并回写）。

## 六、可测性设计（同一份逻辑，两条调用路径）

`plugins/pipeline.js` 导出三个纯函数（`decideToolCall(cwd, toolName)` /
`buildInjectContext(cwd)` / `recordToolResult(cwd, toolName)`），生产路径（Amp 加载插件、
`amp.on(...)` 回调）与自测路径都调用**同一份**函数，不是另建"测试专用镜像"：

```bash
CLAUDE_PLUGIN_ROOT=<repo root> node adapters/amp/plugins/pipeline.js __test decideToolCall <cwd> <toolName>
CLAUDE_PLUGIN_ROOT=<repo root> node adapters/amp/plugins/pipeline.js __test buildInjectContext <cwd>
CLAUDE_PLUGIN_ROOT=<repo root> node adapters/amp/plugins/pipeline.js __test recordToolResult <cwd> <toolName>
```

`CLAUDE_PLUGIN_ROOT` 环境变量优先于安装时烘焙的绝对路径（与其余全部适配器 bash wrapper 的
自定位约定一致），因此不需要先跑 `install.sh` 就能对模板文件直接做 conformance。

## 三能力（全 native，档 A——载体是插件而非 hooks.json）

```yaml
inject:
  status: native
  event: agent.start（session.start 标记新线程 + agent.start 首回合消费，模拟"每会话一次"）
  format: contextModification-messages   # {"messages":[{"content":"<pipeline 上下文>"}]}
veto:
  status: native
  event: tool.call
  format: reject-and-continue            # {"action":"reject-and-continue","message":"<reason>"}
track:
  status: native
  event: tool.result
  format: history-append                 # append .pipeline-history.jsonl（工具名强制映射进 skill 字段，理由同 adapters/cline）
```

## 安装

```bash
adapters/amp/install.sh --target <项目目录>   # 默认 $PWD，装 .amp/plugins/pipeline.js
adapters/amp/install.sh --global              # 改装 ~/.config/amp/plugins/（用户级）
```

或经顶层派发器：`adapters/install.sh --amp --target <dir>`。装完后需要在 Amp TUI 里跑一次
`plugins: reload`（或重启 amp）。

## 人工确认（HITL）

review marker 仅是 hook 投影。完成产物并选择 event 后，运行
`tenon review request <change> --event <event>`；然后等用户确认：用户在 Dashboard（`tenon dashboard --open`）
确认，或由**用户本人在自己的终端**运行 `tenon review acknowledge <change>`（本适配器没有写回执的
UserPromptSubmit hook，回复放行语不会写回执）；agent 不得代为执行该命令，持续授权下只可用 `--delegated`
（它不批准待批准的测试豁免）。不得手动删除 `.pipeline-pending-review` 绕过 gate。
