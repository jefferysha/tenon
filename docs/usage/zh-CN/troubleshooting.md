# 故障排查

先确定事实面，再采取修复。Tenon 的状态、文档、session、runtime 和 UI 是不同层，单看一个“等待”标签不足以判断根因。

## 目标

用只读命令定位问题属于路由、Change 状态、文档证据、review、AFK、runtime、Dashboard 还是 Pages，并选择不会破坏历史或绕过 guard 的恢复动作。

## 前置条件

- 记录项目根、Change 名、当前宿主和完整错误；
- 保留命令退出码，不只截取最后一行；
- 不删除 `.pipeline-run`、ledger、marker 或 archive 尝试“解锁”；
- 对 token、prompt、绝对路径和真实用户数据做脱敏。

## 步骤

### 1. 采集基础事实

```bash
tenon status <change> --json
tenon document status <change> --json
tenon inbox --json
tenon doctor --json
tenon runtime status
```

### 2. 对照症状

#### 正常对话恢复了旧 Change

新目标不应自动绑定用户的 `active-change`。确认 router 是否把请求识别为 resume；多个候选时必须显式点名。独立目标创建新 Change 或走 discussion/simple。
宿主提供 session id 时，全新未绑定会话里的通用“继续执行”必须 fail-closed，不得回落到仓库级
用户的 `active-change`；应显式点名 Change，或先建立该会话的精确绑定。

#### Todo 与 Workflow 不一致

`tasks.md` 的一级标题应来自实际 DAG。检查 Change 选择的 Workflow、step label 和 Todo projection。不要硬编码 default 七阶段到 custom。

#### 文档语言不正确

新 Change 默认 `zh-CN`，固定信息在：

```text
openspec/changes/<change>/.pipeline-document-locale.json
```

旧 Change 保留原语言；首次补文档时可以显式 `--locale en` 或 `--locale zh-CN` 固定。切换全局设置不会翻译现有文件，修改已登记文档后必须重新 record/read。

#### Review 无法推进

正确顺序是 check、request、acknowledge、transition。receipt 必须匹配 exact phase/event。删除 marker 不能替代 canonical acknowledgement。

#### Dashboard 一直等待

比较 canonical state、host session 和 AFK executor。queued、review waiting、session ended 和 running 是不同状态。生产 Dashboard 默认地址是 `127.0.0.1:18765`；先确认该端口服务的页面标题和项目根。

#### Codex 插件已安装但认证为黄灯

先运行 `codex login status`。若未登录，ChatGPT 方案包含 Codex 时运行 `codex login`；远程或
无浏览器终端运行 `codex login --device-auth`。使用 Platform API Key 时，先到
https://platform.openai.com/api-keys 创建，再运行
`printenv OPENAI_API_KEY | codex login --with-api-key`，最后重新执行 `codex login status`。
Platform API Key 按用量计费。Tenon 不会替你登录，也不会读取凭证内容。

`auth:codex` 是本机 Codex 宿主登录态；`afk:credential-codex` 是 AFK 容器能否收到 API Key
或可读 Codex home。两个灯相互独立，不能用其中一个绿色推断另一个也已就绪。

#### Pages 或本地预览 404

本仓是 project site，base 必须为 `/tenon/`：

```bash
npm run docs:sync
npm run docs:build
npm run docs:smoke
```

如果 HTML 200 但哈希 JS 404，通常是 preview 进程仍缓存旧 dist 文件表。停止旧 preview，基于当前 dist 重启，再验证搜索、主题和移动导航。

### 3. 选择恢复路径

- 实现缺陷：Verify 写失败报告，走 `verify-fail` 返回 Build；
- 需求或设计变化：Build 走 `requirements-changed` 返回 Spec；
- runtime 损坏：使用 `tenon runtime repair`，不改项目证据；
- review 待确认：完成产物后处理准确 receipt；
- AFK queued：检查 scheduler、预算、依赖与 gate；
- projection drift：使用受控 inspect/repair，不手改 canonical current。

## 预期结果

你应能把问题归到一个明确层级，保留失败证据，并选择状态机允许的回边或修复命令。修复后，相同只读命令应显示一致状态，而不是 UI 绿、CLI 红或文档账本缺失。

## 验证

重新运行基础采集命令，并针对问题层补充：

- UI：真实浏览器桌面、窄屏、键盘、主题和控制台；
- 文档：`docs:check`、`docs:build`、`docs:smoke` 和真实搜索；
- runtime：`doctor` 与 `runtime status`；
- Change：`status`、`document status` 与 exact transition guard。

## 常见失败

- 只看 Dashboard 标签：回到 canonical state 和 executor 证据；
- 端口 18765 可访问就判定成功：必须核对服务身份；
- 删除 marker 解锁：不会生成 canonical review receipt；
- 手工改 `.pipeline.yaml`：它只是投影，可能制造 drift；
- 将构建通过当浏览器通过：需要打开当前应用并验证交互；
- 用旧验证报告验新基线：Build 修订后必须重新 Verify。

## 下一步

仍无法解决时创建最小复现，移除 token、prompt、绝对路径和用户数据后提交 Issue。安全问题使用私密漏洞报告。
