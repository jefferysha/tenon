# Design

`verify-skills.sh` 在收集候选时建立路径归属函数：canonical `skills/` 可进入发行清单，宿主配置/运行态路径直接排除；测试 sandbox 增加真实重复目录回归。identity checker 对 fs 读取统一捕获错误并打印上下文，不暴露原始堆栈。`AGENTS.md` 仅恢复 HEAD 内容。
