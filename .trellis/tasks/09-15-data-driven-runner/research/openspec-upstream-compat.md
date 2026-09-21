# 上游 OpenSpec CLI 与 Tenon Change 的兼容性（spike）

`@fission-ai/openspec` 1.6.0（仓库 devDependency，`node_modules/.bin/openspec`）。
在 scratchpad 里造了一个最小仓（`openspec/specs/auth/spec.md` + `openspec/changes/demo/{proposal,tasks}.md`
+ `openspec/changes/demo/specs/auth/spec.md`），逐条跑命令。

## 根目录解析

不需要 `.openspec.yaml` 或 `openspec/config.yaml`：CLI 以 cwd 向上找最近的 `openspec/` 目录
（JSON 里 `root.source = "nearest"`）。把 `openspec/` 整棵复制到临时目录、在那里以 cwd 运行，
就得到一次与仓库隔离的彩排。

## 逐条命令

| 命令 | 结果 |
| --- | --- |
| `openspec validate <c> --strict --no-interactive --json` | exit 0 / `items[0].valid=true`；缺 SHALL/MUST 时 exit 1，`issues[].message` 逐字给出 `ADDED "<名>" must contain SHALL or MUST` |
| `openspec archive <c> --yes --json` | exit 0；`archive.specsUpdated=true`、`archive.totals.{added,modified,removed,renamed}`；**重写** `openspec/specs/<cap>/spec.md`，并把 change 目录移到 `openspec/changes/archive/<date>-<c>/` |
| `openspec validate --specs --strict --no-interactive` | 归档后对主规格再跑一次，确认合并结果本身合法 |

`archive` 会顺带规范化主规格排版（例如去掉 `## Purpose` 后的空行），所以「应用」必须取彩排产物的
完整字节，不能只做文本插入。

## 对设计的确认

- §4.2 的三步彩排（临时副本 → validate --strict → archive --yes → validate --specs --strict）成立，
  且临时副本里 change 目录被移走这件事不影响仓库：仓库只接收主规格差异。
- 仓库里的 change 仍留在 `openspec/changes/<c>/`，Tenon 自己的完结步骤照旧跑
  `openspec archive <c> --skip-specs --yes --json`（规格已由 `tenon spec apply` 落过）。
- §3.8 的适配规则不变：Change 已存在且已绑定，上游 skill 的「新建 change」「归档」「同步规格」
  步骤一律不跑，改由 `step.next` 指派。

## 未解决

- `openspec archive` 没有 `--dry-run`；彩排只能靠整棵复制。复制要保模式与符号链接语义
  （实现里用 `cp -R` 的等价物：`node:fs` 的 `cp(..., { recursive: true, verbatimSymlinks: true })`）。
