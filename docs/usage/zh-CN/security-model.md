# 安全模型

Tenon 默认本地优先，但“在本机运行”不等于没有风险。插件能够读取项目、执行命令、记录证据并启动本地服务，因此必须保持最小权限和清晰信任边界。

## 信任边界

- 宿主 hooks/skills：来自已安装 release；
- 项目 workflow/track：来自当前仓库；
- agent 输出：不可信输入，必须经过 schema、路径和 guard 校验；
- Dashboard/API：只绑定 loopback；
- Pages：只包含公开白名单静态内容；
- 外部 provider：受凭证、预算和数据策略约束。

## 状态与路径

canonical state 只由 Tenon CLI 写。路径必须落在项目允许范围，拒绝 symlink、目录目标、遍历和绝对路径注入。文档 ledger 记录安全相对路径和摘要。

## Secrets

不得把 API key、OAuth token、prompt、headers、Tap trace、CA 私钥或真实用户数据写入 README、Issue、Pages artifact 或验证截图。诊断输出先脱敏。

## Dashboard

不要把 Dashboard 绑定到 `0.0.0.0` 或通过公共反向代理暴露。它包含项目 root、Change、session 和 mutation 能力。

## 测试证据

测试记录只有在「被它约束的 agent 造不出来」时才算证据。威胁模型是：想让门变绿的 coding agent，和你同一个系统用户。Tenon
把这件事变贵、并留下痕迹，不声称能拦住一个能读你文件的恶意进程。

- **证据只由 Tenon 写。** hook 拒绝 shell 与编辑器对运行记录、任务测试计划及其台账、共享基线、`known-failures.yaml`、
  本机封存文件与它的密钥的写入，认 13 种写法：解释器内联代码（`python -c`、`node -e`、`perl -e`）、`curl -o` 与 `wget -O`、
  `tar -x` 与 `unzip -d`、`git checkout|restore … -- <路径>`、`git apply` 与 `patch`、变量路径、点名了受保护路径又不是干净跟踪文件的
  脚本文件、`xargs sh -c` 与 `find -exec`、`cp/mv/install/rsync/ln` 变体、`tee` 变体、重定向变体（含喂给解释器的 heredoc）和就地编辑器。
  匹配是静态、尽力而为的。
- **hook 看不见的，由门检出。** 每个任务记录链的链头由 `tenon test run` 封存进按用户、HMAC 签名的本机文件；绕开命令写进来的记录使链头
  对不上封存（`record-unsealed`，没有人工出口，下一次运行另起新链）。Tenon 写出之后又被改动的基线与已知失败清单判
  `protected-file-tampered`。
- **「什么算通过」的定义要人确认。** 任务 diff 里的测试目录、基线、已知失败清单和项目工作流的改动会挡住评审门，直到你确认确切内容
  （`tenon review request` 逐项列出，委托确认不能批准它们）。已知失败只能指向一个具体用例，最长 30 天。
- **报告和候选被钉住。** 报告必须比本次运行新，并带摘要复制进本次运行的产物目录；工作区指纹只忽略目录或冻结工作流声明过的测试产物，
  所以没有东西能藏在一个只是看起来像测试输出的目录里。
- **仓库自带的命令首次执行前不可信。** 你在本机对目录与内联测试命令的确切文字运行过 `tenon test trust` 之后，`tenon test run` 才会执行；
  CI 显式设置 `TENON_TEST_TRUST=1`。agent 的调用里出现这两者，hook 一律拒绝。
- **评审者重跑不出通过。** 同一候选上评审者的每次运行都算数，取最严的结论，除非重跑写明并记录了原因。

残余风险：拥有你权限的进程可以读封存密钥、伪造一致的封存，可以构造 hook 解析不了的路径，也可以经 Dashboard 编辑
`.pipeline/workflows/*.yaml`；后两者靠评审里的人工确认兜底。

## 自动化

持续授权不包含发布、付费、外部通信或生产数据操作。AFK/loop 必须有预算、停止条件、隔离和可审计 policy snapshot。

## 供应链

依赖固定版本。CI 与 pre-tag release candidate 都运行 `npm run check:dependencies`；该单一门禁同时执行 High/Critical advisory audit 与
`npm ls --all`，invalid、extraneous 或不兼容解析树也会失败。正式发布必须把精确且仍为最新
`main` 的 40 位 SHA 与新 tag 交给 **Release candidate (pre-tag)**；恢复中断发布时，也可传入已
精确指向同一 SHA 的现有 tag。验证 job 只有读权限且不
持久化 checkout 凭据，并 fail-closed 要求该 SHA 的 canonical push CI 成功；全部构建、测试和
打包也在这个无发布 secrets 的 job 内完成。它先把 upload action 的裸 SHA-256 规范化为 GitHub
REST artifact digest 格式，再上传由该 digest 与逐资产 SHA-256
清单绑定的 payload，以及独立 approval 证据。默认分支拥有的 `workflow_run` writer 会重新验证
仓库、canonical workflow、完成 run、精确 artifact 与获批 SHA；writer 不 checkout、不执行仓库
代码、不运行 npm lifecycle。最小写权限 writer 创建 tag，或只在已有 tag 的 peeled commit 精确
等于获批 SHA 时幂等继续；随后校验已有 GitHub Release 的每个资产并补齐缺失项。发布自动化绝不
执行 `npm publish`，可选 npx 包只作为 GitHub Release 资产。
Pages deploy 只接受已验证 artifact；第三方搜索/分析默认不启用。

## 报告漏洞

优先使用 GitHub private vulnerability reporting。不要在公开 Issue 中包含利用细节、凭证、prompt、token 或本地 trace。

## 状态与发布控制

新文件采用原子 no-replace，避免并发覆盖。脚手架在真实父目录检查项目边界，不能只做字符串前缀判断；已有目标只接受非 symlink 普通文件。

`.pipeline-document-locale.json` 是不可变呈现 sidecar，不进入旧 canonical schema。新版本固定语言，旧版本回滚时可以安全忽略。

公共文档和本地控制面属于不同发布域。文档站只从白名单源生成静态内容；Dashboard、Change 状态、内部研究、绝对路径和 API 不得进入 Pages artifact。

静态构建至少扫描：

- 私钥头；
- `Authorization: Bearer`；
- 常见 token/query 参数；
- 用户主目录绝对路径；
- 内部 `docs/adr` 与 `docs/superpowers` 路径；
- source map 与调试快照。

自动扫描只是下限，发布前仍需人工检查源清单与 artifact。

## GitHub Pages

Pages workflow 可在 pull request 或手动分支上执行构建检查，但只有 `main` 的非 PR 运行可以配置、上传并部署 artifact。权限限制为读取内容和部署 Pages 所需的最小集合。

## 安装与更新

`tenon setup --codex`、`tenon setup --claude` 等入口必须显式选择宿主，不猜测环境。运行时安装到用户级标准数据目录，项目只保留必要 adapter 与规则投影。

release 使用内容寻址或不可变版本目录，更新通过指针切换；失败时回滚到已验证版本。setup/update 不能重写历史 Change 与 Archive。

自动发现新版本不等于可以绕过 hash、兼容检查或用户配置边界。

## 威胁与控制

| 威胁 | 主要控制 |
| --- | --- |
| 旧 Change 串入新对话 | 只在明确恢复时激活 |
| 路径或 symlink 逃逸 | realpath 边界与普通文件校验 |
| 并发覆盖文档 | 原子 no-replace |
| review 被错误复用 | exact phase/event receipt |
| agent 伪造或改写测试证据 | hook 拒绝 13 种写法 + 本机封存链头 + 评审里对测试配置改动的人工确认 |
| 克隆来的仓库带恶意测试命令 | 首次执行前由用户 `tenon test trust`，CI 显式 `TENON_TEST_TRUST=1` |
| 自动更新破坏历史 | 不可变 release 与 sidecar |
| 内部信息进入 Pages | 白名单、扫描、main-only deploy |

## 发布前清单

- Pages artifact 不含内部路径、token、私钥或 source map；
- Dashboard 仍只绑定 loopback；
- 文档脚手架拒绝 symlink 与越界；
- 更新与回滚在临时环境验证；
- CI 权限和部署分支受限；
- 验证报告与截图已脱敏；
- 未验证的安全承诺没有写进 README。

漏洞报告应包含受影响版本、最小复现、预期与实际结果、影响范围和可安全分享的日志。无法确认是否敏感时，先走私有渠道。
