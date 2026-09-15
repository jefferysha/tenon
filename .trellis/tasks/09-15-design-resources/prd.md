# 前端设计资源目录

## Goal

前端开发能参考大量开源资源：组件库、图标库、区块与页面模板、DESIGN.md 设计系统、状态管理与样式方案；
新建项目时从目录中选择并写入项目指令文件，开发过程中 agent 能按框架和用途查询到合适的资源。

## Background (confirmed, see `research/design-resources.md`)

- Tenon 现有设计类技能都是 13–14 行的通用检查清单，没有任何组件库、图标、模板或 DESIGN.md 目录；
  `skills/shadcn-ui/SKILL.md` 只写了「不要整套照搬组件目录」。
- awesome-design-md（MIT，约 117 个品牌 `DESIGN.md`）描述的是各公司的品牌视觉，仓库声明不拥有这些视觉标识；
  DESIGN.md 格式来自 Google Labs design.md（Apache-2.0），放在项目根目录由 AGENTS.md 指向；`npx getdesign add <slug>` 可按需获取。
- v0 社区模板没有开源许可，只能给链接；v0 MCP 用于生成 UI（OAuth），不是目录。
- shadcn 注册表有开源索引、`npx shadcn add`、官方 MCP（支持 Claude 与 Codex）；Iconify 有搜索 API；Context7 MCP 可查文档。
- 许可证：大多数组件库、图标库为 MIT / ISC / Apache-2.0；不可随插件分发的有 Tailwind Plus、Aceternity 源码、v0 社区模板、
  SF Symbols、Remix Icon 图标集、Flowbite Pro、TailAdmin Pro、MUI X Pro；Preline、Font Awesome Free 需署名。
- GSAP 官方 skill `greensock/gsap-skills` 为 MIT，共 8 个（core、timeline、scrolltrigger、plugins、utils、react、performance、
  frameworks），可原样随插件打包；本机目前只装了其中 4 个。GSAP 库本身免费商用但不是 MIT（Webflow 许可禁止构建与其可视化动画
  编辑竞争的工具），只能让项目安装 `gsap` / `@gsap/react`，不打包其代码。详见 `research/animation-and-popular-components.md`。
- React Bits（165+ 组件，JS/TS × CSS/Tailwind）为 MIT + Commons Clause，禁止再分发组件本身，只能提供链接和
  `npx shadcn add https://reactbits.dev/r/...` 安装方式；Vue Bits 同样限制。shadcn/ui 与 Magic UI 提供官方 skill 和 MCP（支持
  Claude Code 与 Codex），Motion 提供 AI Kit（skill + MCP）。

## Key Decisions

- 2026-09-15 用户要求：前端需要状态管理、样式管理的选择，并能参考大量开源组件库、图标库和模板（如 awesome-design-md、v0）。
- 状态管理、样式管理作为指令模板的前端块由 `09-15-instruction-templates` 实现，候选项来自本目录。
- 2026-09-15 用户要求：动画必须参考 GSAP 的开源 skill；UI 组件参考 React Bits（https://github.com/DavidHDev/react-bits）
  等当下流行的开源组件库。调研中：`research/animation-and-popular-components.md`。
- 2026-09-15 用户要求：前端作业必须定义项目全局 `DESIGN.md`，并在 default 工作流的前端作业中体现，是必须填写的文件。
- 2026-09-15 用户澄清：`DESIGN.md` 是整个项目的设定，包括每个图标、UI 颜色、个性化等所有细节，参考 hue skill 的产出
  （见 `research/hue-output.md`）；什么时候产出需要想清楚，不是简单挂在某个任务步骤上。

## Requirements

- R1 目录条目：名称、类别（组件库 / 区块与模板 / 图标库 / DESIGN.md / 状态管理 / 样式方案）、适用框架、适用样式方案、
  许可证（SPDX、链接、能否再分发、是否需署名、是否商用收费）、安装方式、文档链接、注册表或来源链接、DESIGN.md 链接、
  MCP 或 llms.txt 链接、核验日期。
- R2 覆盖范围：
  - 组件库：React、Vue、Angular、Svelte、React Native、Flutter、SwiftUI、Jetpack Compose 的主流开源库；
  - 区块与模板：shadcn 注册表及其生态（Magic UI、HyperUI、Flowbite、Preline、Tremor、Park UI、Nuxt UI、daisyUI 等）、
    v0 模板（链接）；
  - 图标库：Lucide、Heroicons、Tabler、Phosphor、Radix Icons、Bootstrap Icons、Material Symbols、Font Awesome Free、Iconify 等；
  - DESIGN.md：awesome-design-md 全部条目；
  - 动画：GSAP 官方 8 个 skill 随插件打包，任何动画实现或评审前必须读取相关 skill（由 Tenon 技能门强制）；
    项目安装 `gsap` / `@gsap/react`；另收录 Motion、Anime.js、AutoAnimate、React Spring、dotLottie、Rive；
  - 动效与视觉组件：React Bits（必选参考，注册表链接）、shadcn/ui（基础，skill + MCP），以及 Magic UI、Motion Primitives、
    Animate UI、Cult UI、Kokonut UI、Animata、Eldora UI、coss ui，Vue 的 Inspira UI、Vue Bits；Aceternity、Skiper 仅链接；
  - 状态管理与样式方案：各框架主流方案，附一句适用场景。
- R3 Dashboard 浏览：按类别、框架、样式方案、许可证筛选与搜索，查看详情，打开官网 / 文档 / 预览链接。
- R4 新建项目：在选定前端框架后选择组件库、图标库、状态管理、样式方案，可选一个 DESIGN.md；选择结果写入指令文件的前端块
  （含安装命令与使用约束）；选了 DESIGN.md 时放到项目根目录，并在指令文件中要求 UI 工作遵循它。
- R5 开发中查询：agent 能按框架、类别、关键字查询目录条目；能使用 shadcn 注册表、Iconify、文档查询等在线来源找到具体组件或图标。
- R6 许可证约束：不可再分发的资源只提供链接，不复制源码；需要署名的资源在指令文件中注明署名要求。
- R7 目录可更新：条目有核验日期；用户可新增、编辑、删除自定义条目。
- R8 项目全局 `DESIGN.md`（完整设计体系，达到 hue 产出的完整度）：
  - 项目级，每个项目一份，放在项目根目录，全项目所有前端工作遵循它；
  - 内容：理念与原则、颜色（基础色阶、亮暗两套语义色、状态色）、字体与字号阶梯、间距、圆角、阴影层级、动效个性、
    图标（选定一套图标库及用法）、组件规格（按钮、卡片、输入、列表、导航、标签、浮层、空/加载/错误/禁用状态）、
    首屏视觉、文案语气、禁止事项、平台映射（CSS 变量、Tailwind 配置、SwiftUI 等），并附可在浏览器打开的预览页；
  - 输入来源：品牌名、网址、截图、已有代码、文字描述，或本目录中的 DESIGN.md 条目（如 awesome-design-md）起步再定制；
  - 产出过程有两个人工确认点（设计方向、核心令牌）和一道确定性校验（结构、令牌引用、对比度、默认 AI 字体）；
  - 默认产出方式（2026-09-15 用户确认）：作为项目前置条件，由专门的「设计体系」任务产出（方向确认 → 生成与校验 → 预览评审）；
    前端轨道任务立项时检查项目已有有效的 `DESIGN.md`，没有则拦截并引导先建设计体系任务；普通前端任务需要新增或调整设计时，
    在规格步骤提出对 `DESIGN.md` 的变更并随规格评审，交付步骤合并回项目 `DESIGN.md`；实现、验证步骤把它作为必读输入；
  - 时机可自定义（2026-09-15 用户要求）：每个工作流 / 轨道可以声明 `DESIGN.md` 在哪一步产出或更新、哪一步检查存在，
    例如产品轨道可以在 build 步骤定义它；default 前端轨道使用上面的默认方式；
  - Tenon 自带的 `hue` 目前只有 14 行，改为打包完整的上游 hue（MIT，保留许可证并固定版本），输出改为项目根目录。

## Acceptance Criteria

- [ ] Dashboard 能按「React + Tailwind + 图标」等条件筛选出正确条目，详情显示许可证与是否可再分发。
- [ ] 新建 React 项目时选择 shadcn/ui + Lucide + Zustand + Tailwind + 某个 DESIGN.md：项目根目录出现 `DESIGN.md`，
      指令文件前端块写明所选组件库、图标、状态管理、样式方案、安装命令与遵循 DESIGN.md 的要求。
- [ ] 在 Claude Code 与 Codex 中让 agent 为该项目做一个页面：agent 能查询目录与在线来源找到组件和图标，产出遵循 DESIGN.md 与所选方案。
- [ ] 目录中标记为不可再分发的条目只展示链接，插件包内不包含其源码或图标文件。
- [ ] 新增、编辑、删除自定义条目后刷新状态一致。

## Out of Scope

- 自建组件库或图标库。
- 付费资源（Tailwind Plus 等）的内容获取。

## Content Delivery (derived from licenses and the upstream-skills decision)

- 目录只收录条目信息与链接，随插件维护、安装到全局 Tenon 目录。
- 资源里的 skill（GSAP 8 个、hue、shadcn、Magic UI、Motion 等）按 `09-15-upstream-skills` 从上游安装最新版本，不在 Tenon 内维护副本。
- 组件库、图标库、动画库在项目中用包管理器或注册表安装（如 `npx shadcn add`），Tenon 不打包它们的代码。
- DESIGN.md 条目在选用时从来源获取到项目根目录；React Bits、Vue Bits、Aceternity、Skiper、v0 社区模板、Tailwind Plus 等限制再分发的资源只给链接与安装命令。

- 2026-09-15 用户确认：不自动配置 shadcn、Context7、Iconify、v0 等 MCP 服务；开发中遇到需要时再按目录链接与在线来源查询。

## Open Questions
