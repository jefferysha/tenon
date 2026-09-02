# Tenon Dashboard redesign concepts

这是一个隔离的、只读的 UI 原型，不接生产 API，也不会改变 `packages/dashboard-app/src` 中的生产页面。

## 启动

在仓库根目录运行：

```bash
npx vite packages/dashboard-app/prototype/dashboard-redesign --host 127.0.0.1 --port 4180
```

然后打开：

- `http://127.0.0.1:4180/?variant=a` — A「任务指挥台」：面向执行者，突出当前 Change、下一步和实时信号。
- `http://127.0.0.1:4180/?variant=b` — B「流程画布」：面向理解流程，突出 stage 依赖、skill 编排和右侧上下文检查器。
- `http://127.0.0.1:4180/?variant=c` — C「引导式开发」：面向小白用户，一次只给一个关键决定，用旅程步骤降低门槛。

底部的切换器或键盘 `←` / `→` 可切换版本。所有按钮都只做本地展示状态，不会触发真实执行。
