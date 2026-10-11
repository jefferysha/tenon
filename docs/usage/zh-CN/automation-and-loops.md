# 自动化、AFK 与 Loops

自动化用于重复执行已声明边界内的工作，不扩大用户授权，也不跳过 review、文档和验证。

## 目标

把一个已经建模的 Change 安全放入 AFK 队列，理解 queued 与 running 的差异，并用 Loop、预算、policy snapshot、停止条件和 inbox 保持自动执行可审计、可停止、可恢复。

## 前置条件

- Change 已存在，且它所在的轨道明确允许 automation（`automation.eligible: true`）；
- Docker daemon 和 sandcastle 镜像可用；
- 对应宿主凭证通过受控环境提供，不写入仓库或日志；
- 当前 Change 没有未处理的 confirm/review/interaction gate；
- 已设定预算、最大并发、重试和停止条件。

## 步骤

### 1. 检查就绪度

```bash
tenon doctor --json
tenon status <change> --json
tenon inbox --json
```

就绪检查应区分 Docker 缺失、镜像缺失、provider 凭证缺失、Workflow 不允许自动化和 pending human gate。不要把所有失败折叠成“无法运行”。

### 2. 加入 AFK 队列

```bash
tenon afk enqueue <change>
tenon afk status <change> --json
```

任务能否入队只看它所在轨道的 `automation.eligible`：default 的 `pm`、`frontend`、`backend` 轨道可以；`lite` 轨道和所有没写 `automation` 的轨道（平铺工作流也一样）不可以，`tenon afk enqueue` 退出码 `3`，带 `--json` 时给出 `reason: "track-not-afk-eligible"`。`automation.enqueue_after_spec: true` 的轨道（`pm`）在规格完成后自动入队。

queued 只表示已进入调度队列，不表示 Agent 正在执行。Dashboard 只有在存在真实 executor、session 和运行态证据时才应显示 running。

### 3. 选择权限档位并运行

```bash
tenon afk run <change> --level L1
```

从最小权限开始。L1 是 report-only 安全默认；更高档位必须仍受 Workflow、allowlist、denylist、review gate 和外部副作用边界约束。

### 4. 绑定 Loop

Loop 声明目标、provider、Workflow、最大迭代、预算、成功/停止条件和 inbox policy。每个 iteration 绑定不可变 policy snapshot，避免运行中配置漂移。

```bash
tenon loops list
tenon afk enqueue <change> --loop <loop-id>
```

显式绑定优于按 Change 前缀猜测归属。iteration 可以前进，但历史 transition record 保留当时真实使用的 policy/iteration 身份。

### 5. 监控和安全停止

```bash
tenon afk status <change> --json
tenon inbox --json
tenon afk cancel <change>
```

预算耗尽、凭证缺失、Workflow 漂移、review 待确认和不可恢复配置错误都应停止，不应通过无限重试掩盖。

## 预期结果

- queued、running、blocked、cancelled 和 terminal 状态有不同证据；
- 每次运行受明确 policy snapshot 和预算约束；
- 持续授权只绑定 exact Change，不跨 Change 继承；
- review、document read 和 Verify 仍按正常 Workflow 执行；
- 取消能够留下可诊断 cause，而不是只改 UI 标签。

## 验证

```bash
tenon loops list
tenon inbox --json
tenon doctor --json
tenon status <change> --json
tenon afk status <change> --json
```

结构化 cause 应优先于错误字符串正则。取消、超时、冲突、`verify-fail` 和 provider exit 需要不同恢复动作。

## 常见失败

- queued 长时间不动：检查 scheduler、并发预算、依赖 Change 和 pending gate；
- UI 显示 running 但没有 executor：这是状态投影错误，不能靠刷新掩盖；
- Docker 可执行但 daemon 不可达：按 doctor 的就绪提示处理；
- provider 退出：保留退出码和受控日志，不回显 token；
- 持续授权没有自动跨 review：这是预期行为，它只允许真实证据齐全后 delegated acknowledge；
- 无限重试同一错误：修复配置或停止 Loop，不扩大预算掩盖根因。

## 下一步

需要理解状态展示时阅读[Dashboard 与本地 API](./dashboard-and-local-api.md)；需要处理失败时阅读[故障排查](./troubleshooting.md)。
