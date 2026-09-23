# Tenon npm bootstrap 模板

这个 workspace 是 Tenon 可选公开 npx 入口的受审源文件。它本身保持 private，不是最终发布到
npm 的公共包。

发布自动化必须使用发布者实际拥有的 npm 包名运行 `tools/build-npx-package.mjs`。生成包只包含
这个薄入口、产品身份、许可证和本说明。入口会下载对应 release tag 的 Marketplace 安装脚本，
并校验内嵌 SHA-256；脚本随后使用对应的不可变稳定版本标签。因此 Marketplace 与 npx
会激活同一个已验证候选 digest，日常升级再由 `tenon update --codex` 解析最新稳定 Release。
已退役的 1.x 旧 launcher 不能在一次旧 updater 调用中安全自重绑新 tag；这些机器只需为每个宿主一次性
执行固定的 `v0.1.3/install.sh` 迁移命令。从 v0.1.0 起，每次常规升级都是单条 `tenon update --codex`。

在 publisher scope 与 npm 凭据尚未配置前，请使用已公开的 Marketplace bootstrap：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.3/install.sh | /bin/bash -s -- --codex
```

Codex CLI 缺失时先运行 `npm install -g @openai/codex`，再用 `codex --version` 验证。插件安装后，
包内 setup 会用 `codex login status` 只读检查认证，并在 ChatGPT 方案包含 Codex 时给出
`codex login`、
`codex login --device-auth` 与
`printenv OPENAI_API_KEY | codex login --with-api-key` 三条路径；API Key 在
https://platform.openai.com/api-keys 创建，Platform API Key 按用量计费。bootstrap 不会自动登录或保存凭证。
