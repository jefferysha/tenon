# Technical Design

## Parent/child structure

本请求拆成 5 个可独立验收的子任务，父任务只负责契约冻结、依赖顺序和最终集成复核：

1. `09-13-skill-identity-gates`：R1 门禁归属与身份。
2. `09-13-docs-assets-hygiene`：R2 文档、截图、design-scale、repository-hygiene、dist 资产。
3. `09-13-workflow-failure-set`：R3 workflow/track 语义与失败集。
4. `09-13-ci-test-bootstrap`：R4 Playwright CI 与测试自举。
5. `09-13-architecture-cli-debt`：R5 架构、CLI、OpenSpec/Trellis 债务。

子任务之间的依赖：R3 使用 R1 修复后的 skill 发行判定；R4 依赖 R2 的 dashboard 资产契约；父任务集成验证必须等五项独立验收完成。依赖不代表自动合并，均以子任务 artifact 中的证据为准。

## Contracts and data flow

- **Skill/Claude 边界**：`.claude/` 是仓库的 Claude Code 集成配置（settings、hooks、agents、commands、skills），不能整体忽略或删除。`verify-skills.sh` 仅扫描发行 canonical `skills/`；对 `.claude/skills`、`.agents`、`.pipeline` 做路径归属排除，`.gitignore` 如需修改只能是明确的细粒度规则，并用 `git check-ignore` 路径测试确认。
- **身份边界**：`AGENTS.md` 与 generated identity/template 是门禁输入。缺失、权限错误和 managed block 不完整都转换为稳定错误码/文本，不泄露原始堆栈。
- **Workflow/track 边界**：`fields` 在同一 change 锁内读取 state，验证最终 `{track, workflow}`；同 workflow 内目标 branch 存在则允许换轨并重新冻结 plan，目标 branch 不存在则抛 `WorkflowTrackBranchError`。`simple.escalated` 无 transitions/skills，是终态。
- **Artifact 边界**：先用真实 workflow branch、producer policy 和 `required_when` 复现失败，再选择产品修复或 fixture 修复；stable-hook 与 internal-skill-gate 在分类前不得改断言。
- **Docs/UI 边界**：`views.ts` 的 `VIEWS` 和 default workflow 的 `tracks` 是文档契约源；README/docs 与四张正式 WebP 截图必须同一版本。旧截图若仅作历史证据，必须移入明确目录或加入有理由的 allowlist。
- **Release asset 边界**：dist freshness 解析 `index.html` 本地引用，交叉检查磁盘和 git 发布清单；检查应替换/覆盖只依赖 `git diff --exit-code` 的旧步骤，未跟踪文件必须可见。
- **E2E/CI 边界**：`workflowRuntime.browser.e2e.test.ts` 使用 Playwright 自带浏览器发现，不含 macOS 绝对路径；CI 安装 Chromium 后由 `npm test` 执行该真实浏览器测试。依赖已退役视图与标记的孤立 `tests/e2e/orchestration-v2.spec.ts` 与配置已删除，避免伪造覆盖。
- **自举/架构边界**：测试入口负责生成或引用可用 dist；解析器使用共享 decoder；拆分后端模块保持导出契约和行为测试。

## Rollout and rollback

先落地 R1，再落地 R2；R3/R4 可并行但分别回滚。R5 最后执行，避免架构拆分干扰前面门禁证据。每个子任务提交前保留 `git diff --stat`、定向测试日志和回滚点，父任务不重写子任务提交。

## Decisions and deferred items

- 已确认只禁止跨 workflow 换轨；同 workflow 换轨和 Simple→escalated 语义保持不变。
- dashboard dist 继续入库，freshness 检查必须替代旧的 diff-only 检查。
- Node engines 保持 `>=22`；版本差异当前不是缺陷。
- repository-hygiene 的历史截图 allowlist/迁移，以及外部参考身份文本的 research 豁免，交由 R2 子任务在证据审查后记录最终选择。
- stable-hook/internal-skill-gate 的失败分类是 R3 子任务的前置工作；在分类结果确定前不假设为 fixture 过期。
