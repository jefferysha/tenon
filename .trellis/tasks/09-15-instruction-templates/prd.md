# 项目指令文件与模板（AGENTS.md / CLAUDE.md）

## Goal

按各 agent 工具（harness）真实的加载规则管理指令文件：项目级文件每个项目一份、放在项目根目录、整个项目遵守；
用户级文件对该用户的所有项目生效；两级都能在 Dashboard 用 Markdown 编辑、预览、应用、删除；新建项目时可从模板生成项目级文件。

## Background (confirmed, see `research/current-instructions.md`)

- Tenon 目前没有项目指令功能，只在 AGENTS.md 里维护自己的 Codex 标记块（`adapters/codex/install.sh:61-126`）。
- 所有权判断找的是 `<!-- PIPELINE:START -->`，适配器写的是 `<!-- PIPELINE:CODEX:START -->`，二者不一致
  （`kernel/src/state/ownership-manifest.ts:60-61`）。
- Tenon 适配的宿主：aider、amp、cline、codex、continue、copilot、cursor、devin、gemini、pi、zed（`adapters/`），以及 Claude Code。
- 各宿主项目级 / 用户级指令文件的位置、是否同时生效、优先级与大小限制：`research/harness-instructions.md`
  - Claude Code、Codex、Gemini、Copilot、Cline、Continue、Amp、Devin、Pi、OpenCode：项目级与用户级**同时加载、叠加生效**，
    通常离工作目录越近的越优先；例外是 Copilot（个人 > 仓库）与 Cursor（团队 > 项目 > 用户）。
  - Zed 读取两级但项目级覆盖用户级；Cursor 的用户级只能在设置界面填写，没有文件；Aider 不自动加载任何文件。
  - 项目级通用文件是根目录 `AGENTS.md`；Claude Code 只读 `CLAUDE.md`，Gemini 需 `GEMINI.md` 或配置 `context.fileName`。
    用户级各宿主路径不同，没有通用位置（如 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.gemini/GEMINI.md`）。
- 调研发现两处现有适配器可能有缺陷，需实测：Zed 适配器写 `.rules`，Zed 首个匹配生效，会遮住 `AGENTS.md` / `CLAUDE.md`；
  Cursor 适配器写 `.cursor/rules/pipeline.md`，文档说该目录只认 `.mdc`。
- 指令文件与自定义 agent 是两件事：指令文件是项目级和用户级；agent 是任务级（见 `09-15-review-agents`）。
- 基准模板要求（用户给出的 15 条）草稿：`research/draft-template-react-java.md`。

## Key Decisions

- 2026-09-15 用户要求：层级按宿主规则设计——项目级每个项目只有一份，放在项目根目录，全项目遵守，支持修改；
  用户级也支持自定义、修改、删除。
- 2026-09-15 用户要求：编辑完全按 Markdown 格式；UI 支持 Markdown 编辑与预览、应用、删除等常规操作。
- 2026-09-15 用户要求：新建项目时可以选择模板；模板在 UI 上创建、预览、修改、删除；可以选择写给 Claude（CLAUDE.md）
  还是其他 agent（AGENTS.md），可多选。
- 同时选择多个宿主时，各宿主文件写入同源的完整内容，不使用 `@AGENTS.md` 导入（Claude Code 不自动读取 AGENTS.md）。
- 2026-09-15 用户确认：模板与 agent 库存放方式一致——内置模板由插件维护，安装或更新插件时自动写入全局 Tenon 目录；
  用户自建模板放在同一目录，插件更新不覆盖；内置模板只读、可复制。
- 2026-09-15 用户要求：内置模板覆盖所有主流语言。
- 2026-09-15 用户确认：模板按块组合（通用、前端、后端、移动端、系统、数据库、接口约定），新建项目时各类选需要的块拼成指令文件；
  首批清单：前端 TS + React / Vue 3 / Angular；后端 Java + Spring Boot DDD、Kotlin + Spring Boot、Go、Python（FastAPI / Django）、
  Node.js + NestJS、C# + ASP.NET Core、Rust（Axum）、PHP（Laravel）、Ruby（Rails）；移动端 Swift、Kotlin Android、Dart + Flutter；
  系统 C / C++；数据库 PostgreSQL、MySQL；接口约定 REST `/api/v1` + 统一响应。
- 2026-09-15 用户要求：清单还不够——前端要有状态管理、样式管理的独立选择；并且需要能参考大量开源组件库、图标库和模板
  （如 awesome-design-md、v0 等开源 UI 模板）。状态管理、样式管理作为前端模板的独立块纳入本子任务；组件库、图标库、区块与模板、
  DESIGN.md 的资源目录拆为子任务 `09-15-design-resources`，本子任务的前端块引用该目录中的选择。

## Requirements

- R1 项目级指令文件：每个项目根目录一份，按所选宿主使用各自文件名（如 `CLAUDE.md`、`AGENTS.md`）；在 Dashboard 项目中
  以 Markdown 编辑、预览、应用（写入文件）、删除。
- R2 用户级指令文件：写到各宿主的用户级位置（按调研结果），在 Dashboard 以 Markdown 编辑、预览、应用、删除；
  界面标明该级别对本机所有项目生效。
- R3 界面按调研结果说明两级在该宿主中是否同时生效、谁优先（只用一个标签表达，不写说明句）。
- R4 模板：Markdown 文档，存放在全局 Tenon 目录，可在 Dashboard 新建、预览、修改、复制、删除；新建项目时选择一个或多个模板，
  按所选宿主生成项目级文件；内置模板只读、可复制，安装或更新插件时自动写入，用户模板不受插件更新影响。
- R4a 内置模板覆盖所有主流语言，以用户给出的 15 条（前端 TS + React、后端 Java 21 + Spring Boot 4 DDD、PostgreSQL）为基准深度：
  每个语言模板包含技术栈、分层结构、编码规范、文件长度阈值、测试要求；覆盖清单与组合方式见 Open Questions。
- R4b 新建项目两种方式（2026-09-15 用户确认）：
  - 选已有目录：对已有代码仓库应用模板并登记为 Tenon 项目；
  - 新建空项目：输入名称与父目录，Tenon 创建目录并 `git init`，按所选模板生成指令文件，按所选前后端生成目录约束中的空目录
    （如 `frontend/`、`backend/`、`sql/`），登记为项目；
  - 两种方式之后的流程相同：选模板、选宿主、选资源、预览差异、应用；目录已存在、无写权限、已是 git 仓库等情况给出明确结果。
- R5 应用前显示与磁盘现有内容的差异；Tenon 自有的受管块（如 Codex 集成块）在编辑与应用时保持不变。
- R6 文件在磁盘上被外部修改后，界面检测到变化并提示重新载入，不覆盖他人修改。
- R7 修复 AGENTS.md 所有权标记不一致，并有回归测试。

## Acceptance Criteria

- [ ] 在 Dashboard 对一个项目编辑项目级指令（Markdown 编辑与预览），勾选 Claude Code 与 Codex 后应用：项目根目录的
      `CLAUDE.md`、`AGENTS.md` 内容一致；删除后文件被移除（受管块按规则处理）。
- [ ] 编辑用户级指令并应用：文件出现在各宿主的用户级位置；在另一个项目新开宿主会话能读到其中约束；删除后不再生效。
- [ ] 分别在 Claude Code 与 Codex 新开会话，询问项目级与用户级规范中的约束，回答与文件一致，并与调研得出的生效与优先规则相符。
- [ ] 模板新建、预览、修改、复制、删除后刷新状态一致；新建项目选择「前端 TS/React + 后端 Java/Spring DDD」生成的项目级文件为两个模板的合成内容。
- [ ] 外部修改文件后，界面提示重新载入，应用不会覆盖外部修改。
- [ ] 在 Dashboard 新建空项目（前端 React + 后端 Java）：目录被创建并初始化为 git 仓库，生成指令文件与 `frontend/`、`backend/`、`sql/`，
      项目出现在项目列表；选已有目录接入时不创建目录、不重复 `git init`。
- [ ] 所有权标记不一致的缺陷有回归测试。

## Out of Scope

- 在线模板市场、跨团队模板同步服务。
- tenon-local 自身 AGENTS.md 的改写。
- 企业托管策略级（managed policy）指令文件的编辑。

## Open Questions

- 内置模板的具体覆盖清单与组合方式（通用 + 语言/框架 + 数据库 分块组合，还是每个技术栈一份完整模板）。
