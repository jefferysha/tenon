# 全局工作流 POST 用例漏发鉴权头

## Goal

修好 `packages/server/src/server.test.ts` 里「工作流全局存储（root 为空 = 用户级 configRoot/workflows）」用例，让它真正验证无 root 的 POST 写进全局目录。

## 根因

`reqPost(port, path, payload, opts)` 的第 4 个参数是 `{ host?, headers?, rawBody? }` 选项对象。该用例传的是 token **字符串**：

```ts
const posted = await reqPost(h.port, '/api/workflows/team', body, h.token)
```

字符串没有 `headers` 属性 → `Authorization` 头从未发出 → 写端点鉴权返回 401。同文件其它 POST 用例都写作 `{ headers: { Authorization: \`Bearer ${h.token}\` } }`。

这是用例自身的调用错误，不是服务端缺陷：该断言从提交 `4f1c04a` 起就没真正跑通过 POST 分支。

## Requirements

- 按同文件既有写法补上 `Authorization` 头。
- 修好后该用例必须真的走到写盘断言：全局目录出现 `team.yaml`，项目目录不出现 `.pipeline/workflows`。
- 若补上头之后仍非 200，则说明背后另有服务端缺陷，需另开任务，不得改断言迁就。

## Acceptance Criteria

- [x] `npx vitest run packages/server/src/server.test.ts -t "工作流全局存储"` 绿
- [x] 用例确实断言了全局目录内容与项目目录缺席，没有被弱化

## 实际改动

`packages/server/src/server.test.ts` 单行：第 4 个实参由 `h.token` 改为 `{ headers: { Authorization: \`Bearer ${h.token}\` } }`。补上头后 POST 直接返回 200，写盘断言原样通过，服务端无需改动——确认背后没有第二个缺陷。
