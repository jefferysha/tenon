# v03-local-auth 设计

依据：`prd.md` R1–R6、`../09-30-v03-production/product-audit.md` §2.3。分支 `v03/local-auth`（自 `integ/v03`）。

## 1. 威胁模型（写进 `docs/usage/security-model.md`）

| 对手 | 能做什么 | 本方案的结论 |
| --- | --- | --- |
| A1 浏览器里的任意网页 | 跨站请求、DNS 重绑定、读跨源响应 | Host 守卫 + Origin/Fetch-Metadata + `SameSite=Strict` cookie + 写端点 bearer；无 CORS 头 |
| A2 本机其它 OS 用户 | 连回环端口、读世界可读文件 | 无会话即 401；server 不落任何可用凭证文件；state 目录 0700 |
| A3 同用户 agent（有 shell、能读 Tenon state 全部文件、能连回环） | 抓首页 token、curl 读/写、读 token 文件、脚本里发请求 | 首页/读接口不发任何凭证；磁盘、环境变量、进程参数、任何 HTTP 响应里都没有可换会话的材料；确认评审还要在线的“人在场”nonce |
| A4 同用户且能驱动用户浏览器 / 能抢读进程参数 / 能自起第二个 server 并读其 stdout | 拿到会话 | 明确不防（与直接执行 `tenon review acknowledge` 同级），由宿主 hook 的 fail-closed 白名单与 AFK 策略负责；文档如实写明 |

## 2. 凭证与会话

- **一次性登录码**（bootstrap code）：256 bit 随机，单次使用，TTL 120 s，只在 server 内存里。**不写盘、不出现在任何 HTTP 响应里。** 只有两条交付通道：
  1. **server 自己打开浏览器**：`tenon dashboard --open` / setup 调 `POST /api/session/open`（回环 + Host + `application/json` + 无 `Origin`/`Sec-Fetch-*` + 限速，无凭证）。server 铸码后由自己 spawn 系统 opener 打开 `/session/start?code=…`，响应只回 `{ok, opened}`。调用者（CLI 或 agent）拿不到码。
  2. **启动者的终端**：前台 `tenon dashboard` 在 stdout 是 TTY 时打印一次性链接（回车再铸一条）；自动化（e2e / bench / 验收）设 `TENON_DASHBOARD_PRINT_LINK=1`，从自己创建的日志里读，换到一个 cookie 后可复用到多个浏览器上下文。
- **会话**：`GET /session/start?code=…` 消费码 → `303 /` + `Set-Cookie: tenon_session_<port>=<256bit>; HttpOnly; SameSite=Strict; Path=/; Max-Age=…`。server 只存 sha256(会话 id)，内存表，空闲 12 h / 绝对 7 d，最多 64 个。cookie 名带端口，避免同主机多个 dashboard 互相覆盖。
- **写 token**（`window.__TENON_DASHBOARD_TOKEN__`，`Authorization: Bearer` / `X-Pipeline-Token`）保留为 CSRF/写门，但**只在带有效会话的 `GET /` 里注入**；匿名 `GET /` 得 401 登录提示页，不含 token。既有写端点 handler 不动。
- 旧 `dashboard-token.json`：server 启动时删除（R5）；`writeTokenHandshake` 移除；ProductPaths 的 `dashboardTokenPath` / `ServerPaths.tokenPath` 保留字段名（避免大面积改名）但注释标为 legacy，仅用于清理与旧文件名识别。

## 3. 请求门（`serverAccess.ts`，在路由分发之前）

1. `/api/health`、`/assets/*` 公开（只读、无敏感内容）。
2. 其余先过 Host 守卫（所有方法，含 GET/SSE）。
3. `/session/start`、`POST /api/session/open` 是仅有的免会话入口。
4. 其余要求有效会话 cookie：无 → `GET /` 返回 401 登录提示页，其它返回 401 `{code:'session-required'}`。
5. Fetch-Metadata：`Sec-Fetch-Site` 为 `cross-site`/`same-site` 的 API 请求 403；非 GET 请求带 `Origin` 必须等于 `http://<Host>`。
6. HTML 响应带 `frame-ancestors 'none'`、`Referrer-Policy: no-referrer`；一律 `Cache-Control: no-store`。
7. 写端点 handler 内既有的 Host + bearer + content-type 检查保持原顺序。

## 4. 评审确认需要“人在场”（R3）

- `POST /api/change/:name/decisions` 必须带 `X-Tenon-Presence: <nonce>`。
- nonce 来自 `POST /api/change/:name/decisions/presence`（需要会话 + bearer + JSON）：128 bit，单次使用，TTL 30 s，**绑定 会话 + root + change + ref + expected_revision**，每会话最多 8 个未用。
- SPA：点“确认通过”先弹二次确认框（说明代表本人批准哪个 change/事件），点确认那一下才请求 nonce 并立即提交。
- 没有会话的进程（agent 读遍 state 文件也一样）拿不到 nonce；有会话也不能跨会话/跨 ref/重放。CLI `tenon review acknowledge` 不变。

## 5. gate.sh（R4）

- 删除对原始 JSON 做的子串预筛（`dashboard-token.json` / `localhost`+`/api/`）：它漏 `curl http://127.0.0.1:18765/`（无 `/api/`，而旧首页正是在这里发 token）、脚本文件、整数/十六进制/八进制 IP、`nc`、`/dev/tcp`、变量拼接等。
- 新的候选判定基于**解码后的命令词**：回环写法（`localhost`、`127.*`、`::1`、`0.0.0.0`、`[::ffff:127.*]`、整数/十六进制/八进制 IPv4、`/dev/tcp/`）、Dashboard 端口、`tenon dashboard` / `dashboard.mjs`；命令首词是解释器或路径时再读所执行脚本文件的前 128 KiB 一并判定。精确分类仍由 `internal-self-approval` 在 pending receipt 的锁内做。
- token 文件不存在了，读文件不再是威胁；Read/Grep/Glob 不再进候选。
- pending review 期间的 fail-closed（严格只读白名单）不变，它才是对“任意程序/脚本”的可靠机制；候选判定只用于**记录**与更准的提示语。
- `tenon dashboard --open [--port N]` 加入 pending review 期间的放行名单（与 `tenon review request|acknowledge` 同列）：登录链接由 server 交给浏览器、不返回给调用者，放行它不给 agent 任何会话；带 `&&`/`;`/非数字端口的变体仍被拦。内核分类器同样不把它当命中；端口取 默认 18765 ∪ `TENON_DASHBOARD_PORT` ∪ pidfile 里 server 记录的端口，`/api/health` 探针不算命中。
- `tools/test-hooks.sh` 新增原先可绕过的写法：无 `/api/` 的回环 GET、变量端口、`nc`、`/dev/tcp`、整数/十六进制 IP、脚本文件、`python3 -c`、`node -e`、分段 URL。

## 6. 其它

- CLI：`openBrowser` 真实现改为 `POST /api/session/open`；`tenon dashboard --open|--background` 先探测同状态域的既有 Dashboard，已在运行就只请它开浏览器（此前会再起一个候选进程，因 PID 对不上而失败），不需要冻结 Node；打不开时提示在终端前台 `tenon dashboard --port <空闲端口>`（打印一次性链接）。
- 文件长度门（`check:architecture`）：回环激活校验抽到 `loopActivationWiring.ts`，测试快照类型抽到 `typesTestSnapshot.ts`，CLI 的 attach 逻辑放在 `dashboard-open.ts`。
- 测试：`test-support.ts` 的 `createTestDashboardServer` 在 listen 后走真会话流程并把 cookie 记在端口上，`reqGet/reqPost/...` 自动带；新增匿名 / agent 模拟专项测试。
- e2e：`serve.mjs` 以 `TENON_DASHBOARD_PRINT_LINK=1` 起服务，读日志换 cookie，写进 `server.json`，fixtures 给每个 context `addCookies`。
- 文档：security-model（en/zh-CN）、dashboard-and-local-api（en/zh-CN）、README 引导语、troubleshooting、release-notes。
