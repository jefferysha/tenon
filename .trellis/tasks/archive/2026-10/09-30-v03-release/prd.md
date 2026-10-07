# 双宿主验收与发布
## 需求
- Claude Code 复验（重点：零豁免默认流程、标准通道、画布与 Signal、鉴权）；Codex 验收由用户本人执行（2026-10-06 用户决定：agent 不测 OpenAI/Codex）；两身份协作；记录到 docs/acceptance/。
- 1.x：用户确认其 Codex 验收通过后备份资产与说明、删除 16 个 1.x Release 与标签，文档改为已删除；否则统一改写文档措辞与事实一致。
- 截图重拍；Trellis 账面（v02/v03 任务收尾归档、旧 09-12/13/15 任务按审计结论关闭）；清理演示项目与临时注册项目、旧 worktree、自定义验收智能体。
- 发布 v0.3.0（版本、N-1=v0.2.1（2026-10-01 已发布的热修复）、发布说明、全门禁、clean-install、CI、release-candidate、public acceptance、更新本机宿主）。

## 发布后跟进（2026-10-06 审查留下的 medium，非阻断）
- check-audit：Dashboard 分析缺独立交叉核对（记录 168 包快照或金丝雀子集，或与已构建 dist/assets 比对）；server bundle 的 canary 为 null，加最少模块数断言。
- wizard e2e：「创建」重点击路径加 Playwright annotation（或第三次失败），避免掩盖真实的点击被吞问题。
- settled()：脚本驱动动画只看 opacity/visibility；rAF 停摆时靠 Playwright 超时——可加 setTimeout 兜底。
- braces 白名单 2026-11-05 到期，到期前复查上游并续期或移除。

## 状态（2026-10-07）
- 已发布：v0.2.1（重启锁死热修）、v0.3.0、v0.3.1；本机两宿主 0.3.1，doctor 24 PASS / 3 WARN / 0 FAIL。
- Claude Code 实机验收完成：docs/acceptance/2026-10-v0.3-claude-code.md（9 过 1 部分；F1/F2 及多数低优先级已在 v0.3.1 修复）。
- 清理完成：演示项目（移入废纸篓）与 6 个临时登记、自定义验收智能体 cart-pricing-review、49 个 worktree 与 188 个已合并分支、v02/v03 共 19 个 Trellis 子任务归档。
- 待用户：Codex 验收（用户自测）；通过后再按约定备份并删除 16 个 1.x Release 与标签。
- README/文档截图已按 v0.3.1 重拍（npm run docs:screenshots 可复现）；main CI 全绿（ab845284）。

## 下一期候选（不在本期做）
- flowSignal.perf.test.tsx 同类 jsdom 计时断言；waitForHealth 503 后挂起时补充超时次数。
- 发布说明：v0.2.1 读取说法补测试或收窄；超长条目拆分。
- 指纹：非 git 仓库正则（坏 .git 文件、跨文件系统父仓库）、大小写不敏感文件系统的索引拼写；废弃任务的自批准为已知限度。
- check-docs 首行未覆盖、README.md 322-323 行包裹代码块；settled() 只看 opacity/visibility。
- TENON_LANG=en 剩余中文：agent next 宿主提示、非宿主类 agent prompt/record 错误、review 成功行。
- braces 白名单 2026-11-05 到期复查；tinypool override 待 vitest 5 移除。

## v0.3.2（2026-10-07 已发布）
- 用户 2026-10-07 指示「除 Codex 验收外全部执行、不留到新会话」，上面「下一期候选」已全部在本会话完成并随 v0.3.2 发布：flowSignal/健康检查/check-docs/settled 收尾、指纹边界（坏 .git、大小写不敏感、父仓库回退、GIT_* 环境）、TENON_LANG 残留、vitest 4.1.11（去掉 tinypool 锁定）、vitest 5 bench 发现支持。
- 补验收发现并修复：F18 回滚卡死（v0.1.0–v0.3.1 全部受影响；已卡住的用 v0.3.2 版本化 install.sh 恢复）、F19 预先提交的 not_applicable 批准后卡任务（已卡住的：归档后新建任务）、F20 回滚后 doctor 报红；新建向导预检 15s 超时 + 重试。
- CI 新增：update/rollback 验收、vitest 5 bench 真实安装、tenon-verify action 真实 runner 自测（SARIF 上传经 code scanning 读回确认）。
- 1.x 备份完成：~/Documents/code-manager/backups/tenon-1x-releases-2026-10-07/（16 Release、16 标签、30 资产、bundle 校验通过）；删除仍待用户 Codex 验收通过。
- 本机两宿主 0.3.2，doctor 24 PASS / 3 WARN / 0 FAIL；活动 bootstrap 已含修复。
- 仍开放：braces 白名单 2026-11-05 到期复查；vitest 5 需要 discover/bench 之外的 Node 20 决策（本仓库仍在 vitest 4）。

## 收尾（2026-10-07）
- Codex 验收：用户决定跳过。
- 1.x：用户确认后删除 16 个 v1.x Release 与 16 个标签（远端、本地均为 0，Latest 仍为 v0.3.2）；备份见上，含 git bundle 与恢复命令。
- 文档改为「1.x Release 与标签已于 2026-10-07 删除」，1.x 机器的迁移说明保留。
- 本期完成，归档本任务与父任务 09-30-v03-production。
