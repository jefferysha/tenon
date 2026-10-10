# 架构决策记录：Tenon 源码仓库只用源码开发安装；上游技能不入库、安装时自动拉取；会话开始检查漂移

## 背景

在 Tenon 自己的源码仓库里工作时，宿主加载的技能、hook 和 CLI 全部来自已安装的发布版：插件来自 GitHub `jefferysha/tenon@v0.3.2`，运行时来自 release payload。没有任何从本地源码安装的入口：`install.sh` 写死标签；`tenon setup/update` 只认稳定标签；规格「Managed release source SHALL 绑定稳定标签版本」也这样要求。

上游技能约 57 个，被 `.gitignore` 排除，按 `skills/sources.yaml` 的 default-branch 浮动拉取。已装版与仓库工作区版是两次不同时刻的快照，2026-10-07 实测有 12 个不一致。agent 照发布版 domain-modeling 新建了 `GLOSSARY.md`，与仓库约定的 `CONTEXT.md` 冲突。用户明确要求：在 Tenon 源码仓库里必须全部使用仓库源码。

## 决策

1. 新增正式的源码开发安装 `tenon setup --claude|--codex --from-source <repo>`：
   - 宿主插件市场指向仓库目录，托管运行时从工作区构建。
   - 复用正式安装的事务、校验、原子切换与回滚。
   - release 记录 `channel: dev`、commit、dirty、工作区摘要、技能索引摘要，不冒充任何稳定标签。
   - 不带 `--from-source` 的正式安装行为不变。
2. 上游技能正文与本机拉取索引都不进仓库。源码开发安装时，缺技能或缺索引就按 `sources.yaml` 自动拉取；任一失败则整体中止、不改宿主；两次安装之间不自动重拉。
3. 开发安装写本机安装通道标记并关闭 auto-update。开发安装下 `tenon update` 默认拒绝，提示用 `--from-source` 重新同步，或用 `--to-stable` 切回正式安装。
4. 在源码仓库里开会话时比较已装与工作区，比较范围是发布载荷所含路径的内容摘要与技能索引摘要。不一致，或装的是正式版，就在会话上下文给出同步命令。检查 fail-open，完整比较在 `tenon doctor` 的 `source:drift`。
5. `/api/health` 增加 `channel`、短 commit 与 `displayVersion`（`<version>+dev.<sha7>`），`serverVersion` 不变；`identity:release` 对开发版为黄色。

## 备选方案

- 上游技能正文与锁文件提交进仓库：可复现，但仓库体积与许可证核对成本高。用户选择不入库。
- 只把上游技能锁到具体 commit、提交锁文件：离线或上游删库时装不上。未采用。
- 借验收工具的本地标签加 `git url.insteadOf`，冒充发布走正式 setup：要改全局 git 配置、冒充发布标签，与真实更新冲突。否决。
- 只改技能的读取来源：hook 与 CLI 仍是发布版，不满足「全部用源码」。否决。
- 只做漂移检查、不改安装方式：发现不一致后仍没有正规途径同步。否决。

## 后果

- release manifest 新增一个与 stable target 互斥的开发来源字段，旧格式照常解码。正式安装的 release id 计算保持逐字节不变。
- 宿主对账代码要能读目录型 marketplace：Claude 的目录市场条目没有 `repo` 字段，现有代码会报错。
- 本机切到源码开发安装后，要靠 `tenon update --<host> --to-stable` 才能回到正式版。
- 上游技能在不同机器上仍可能拉到不同快照。漂移检查只保证「已装与本机工作区一致」，不保证跨机器一致。
- 新增一个端到端验收脚本（`npm run test:source-install`），在隔离 HOME 里覆盖开发安装、漂移、同步与回切。
