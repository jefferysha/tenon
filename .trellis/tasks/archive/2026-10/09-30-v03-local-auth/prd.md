# 本机鉴权与评审门防自批
依据：../09-30-v03-production/product-audit.md §2.3（token 暴露、gate 预筛可绕过）。
## 需求
- R1 首页不再对任意请求下发写 token：浏览器通过一次性、短时、仅限 loopback 且带 CSRF 语义的会话建立（例如 `tenon dashboard --open` 生成一次性 URL 片段 token，页面换取 HttpOnly+SameSite=Strict cookie；或 Origin/Sec-Fetch-Site 校验 + cookie）；直接 curl `/` 拿不到 token。
- R2 读接口（/api/snapshot 等）同样需要会话；健康检查除外。
- R3 人工评审确认（Dashboard 评审决定路由、review acknowledge 类写入）需要人在场证明：只能来自浏览器会话且带用户手势确认（例如二次确认 nonce），agent 进程即使拿到本机文件也无法经 API 完成；CLI 的 `tenon review acknowledge` 规则不变（由宿主交互门控制）。
- R4 gate.sh 的自批预筛从字符串匹配改为可靠机制（与 R1–R3 配合后，token 文件不再可读或不再存在）；列出并测试原先可绕过的写法。
- R5 迁移：旧的 dashboard-token.json 处理、已打开页面的升级提示；e2e 与现有测试更新。
- R6 文档：security-model.md 更新威胁模型（同用户 agent 为假想对手之一）。
## 验收
未带会话的 curl `/`、`/api/snapshot` 得 401/403 且无 token；e2e 全绿；新增测试证明 agent 侧脚本无法完成评审确认。
