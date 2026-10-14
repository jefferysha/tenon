# 任务

## 立项

- [x] 写 proposal / design / tasks：记录测试设置的现状证据（字段、种类、登记、信任、指纹、探针）、范围、非目标与可验证结果。

## 调研

- [x] 按推荐定下待验证问题：每档缺省含义、轻量轨道选档、`plan` 档去留、计划里 `files` 节的去留、信任键粒度与封印密钥、旧 `test_policy` 的显示、种类别名的读取影响。 (explore)
- [x] 核实受影响的消费点：`test_policy` 的全部读点（kernel 求值、CLI next、agent 提示、server DTO、Dashboard），改动文件判定与认领的调用方，信任存储的读写点与 hook 受保护路径，指纹的输出目录规则。 (explore)
- [x] 写设计文档与 ADR，在 `CONTEXT.md` 统一「测试档位 / 档位定义 / 测试类 / 认领」术语。 (explore)

## 规格

- [x] 写 delta spec：新增 `test-settings`，修改 `step-test-waiver`、`workspace-verification-integrity`。 (spec)
- [x] 写实施计划：档位与种类 → 改动判定与自动认领 → 保留注释写回 → 场景映射与追溯 → code-size → 信任存储 → 相对路径 → 指纹规则 → next 与技能 → server / Dashboard → 文档；每段写明验收命令。 (spec)
- [x] 登记测试计划：kernel 单测、CLI 集成测试（lite 全程、跨 worktree 信任、在途旧计划）、server 与 Dashboard 测试、hook 测试。 (spec)

## 实现

- [x] kernel：`test` 档位的解析、编译、序列化与旧 `test_policy` 兼容；档位定义节与内建缺省；五类种类与别名。 (build)
- [x] kernel / CLI：改动判定排除控制目录、测试文件名要求源码扩展名、按 glob 自动认领、`--auto` 只追加精确路径。 (build)
- [x] kernel：目录写回只改被修改条目的行区间，保留注释。 (build)
- [x] 场景映射默认不要求、追溯矩阵按需展开；default 里 `code-size` 去掉上限，豁免展示附带实际数值。 (build)
- [x] 测试信任改为用户级存储、按「用户 + 仓库 + 命令摘要」共享，兼容旧检出信任。 (build)
- [x] 运行记录与日志里的绝对路径改写为相对路径；测试输出目录的通用指纹规则。 (build)
- [x] `next` 去掉 `test-register-files`，测试动作随新规则调整；同步 `skills/tenon/SKILL.md` 测试动作行。 (build)
- [x] `templates/workflows/default.yaml` 各轨道改用 `test:` 档位并重新生成 `default-workflow.generated.ts`；更新本仓库 `.tenon/tests/catalog.yaml`。 (build)
- [x] server DTO 与 Dashboard 测试设置单选、项目测试页显示档位定义、任务测试页调整。 (build)
- [x] 同步 `docs/usage/`、`docs/CONTRACT.md` 与发布说明。 (build)
- [x] 修复验证第 1 轮的 4 条 medium（先写失败测试）：证据扩展名移出 json/html/htm/zip/gz/har；报告里登记者自述文本与测试名统一转义；信任区分「不是 git 仓库」与「git 出错 / 伪造指针」；git 子进程环境清理抽成共享模块。同步文档后重新生成产物，跑全量回归。 (build)
- [x] 修复验证第 2 轮的 2 条 medium（先写失败测试）：
  - git 仓库里不再认检出里的旧封存（删掉旧封存是否被跟踪的判定），以前的信任重新确认一次；
  - 评审请求打印豁免理由前去掉控制字符与双向字符。

  同步文档与发布说明后重新生成产物，跑全量回归。 (build)
- [x] 验证第 3 轮之后：
  - rebase 到合入 `rework-document-mechanism` 之后的 `origin/main`，解决冲突；
  - 修 3 条 medium 与 1 条 high（先写失败测试）：
    - 抽出共用的字符串比较；
    - 没写 `covers` 的套件给出 `suites-without-covers` 提示；
    - 补齐代码规模、档位覆盖率门槛的端到端用例；
  - 补规格点名但缺的用例，统一清理展示给 agent 的不可信文本。

  同步文档后重新生成产物，跑全量回归。 (build)
- [x] 验证第 4 轮之后：
  - 修 1 条 medium（先写失败测试）：受保护目录改动的摘要列出档位定义 `levels` 与项目级不适用声明的变化，标明放宽或收紧；
  - 顺手修 3 条 low：hook 识别解释器内联代码与新写脚本里的信任字样，`protected-writes.sh` 缺失时信任相关命令失败关闭，信任目录与密钥校验属主；
  - `testsTabModel` 两处行构造的重复抽成一个小函数；
  - 就绪审查：摘要的门槛段与命令段各自截断；内联识别只把独立的词 `tenon` 当作 tenon 调用；
  - 回归暴露的 e2e 竞态（main 上同样存在）：`workspace-ended` 等已结束详情读到之后再开 ⋯ 菜单。

  重新生成产物，跑全量回归。 (build)

## 验证

- [x] 全量单测、类型检查、hook 与 adapter 测试、Dashboard e2e 通过。 (verify)
- [x] 本地跑齐 `check:*`（含 `check:default-workflow-freshness`、`check:repository-hygiene`、`check:openspec`）。 (verify)

## 交付

- [ ] 提交交付物并开 PR，`gh pr checks` 全绿。 (ship)

## 完结

- [ ] 归档变更。 (archive)
