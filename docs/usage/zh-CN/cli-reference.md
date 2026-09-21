# CLI 参考

本页列出常用 pipeline 命令族。精确参数以 `pipeline <command> --help` 为准。

## Setup 与运行时

```bash
tenon setup --codex
tenon setup --claude
tenon update --codex
tenon host-target-plan --json
tenon host-target-plan --host codex --operation setup --json
tenon doctor --json
tenon runtime status
tenon runtime repair --rollback
tenon dashboard --open
```

`host-target-plan` 是机器可读的只读契约。仅传 `--json` 时返回已注册宿主目录；同时传入
`--host` 与 `--operation setup|update` 时返回一个 `host-target-plan/v1` 计划。
它不会执行 setup/update，也不接受自定义宿主 ID。原生宿主计划面向用户级安装；适配器宿主
计划固定使用 `--target .`，复制或运行前必须先进入目标项目目录。

## Change 与状态

### Interaction observability

```text
tenon interaction scorecard <fixture-dir> --json
```

该只读命令重放 tracked v1 JSON fixtures，输出确定性的
tenon-interaction-scorecard/v1 JSON：三项固定指标、completeness、accepted stale、
same-state repeats、invalid resumes、diagnostics 及 unclassified extension codes。
存在时每个 Change 的 projection 是普通非 symlink 文件 .pipeline-interactions.jsonl；
projection 写失败只在 canonical 成功后 warning，不改变 canonical state。闭合 codec
拒绝 prompt、token、credential 与 artifact 字段。

```bash
tenon init <name> --track <track> --preset <preset>
tenon init <name> --track frontend --preset full --document-locale zh-CN
tenon list --json
tenon status <name> --json
tenon workflow plan <name> --json
tenon get <name> <field>
tenon set <name> <field> <value>
tenon transition <name> <event>
tenon check <name>
```

不要用 `set phase` 绕过 workflow event。canonical state 和 YAML projection 只能由 CLI 写。

`tenon workflow plan <name> --json` 是 Agent 编排在途 Change 的单一读取入口。它优先返回
WorkflowRun 初始化时冻结的完整计划，包括步骤、Skill、门禁、守卫、产物和转换。后来修改或删除
`.pipeline/workflows/<workflow>.yaml` 只影响新运行，不会改写已有运行的 Todo 和 Skill DAG。

`tenon status <name> --json` 还带一个 `step` 块：单个 `tenon` skill 执行当前步骤所需的全部输入
——本步技能、执行者、评审者、测试、文档、字段、评审回执、带阻塞原因的出口，以及一份闭集的
`next` 动作表，按序执行即可。

```text
tenon spec apply <change> [--dry-run] [--json]
```

`spec apply` 在 `openspec/` 的临时整拷里跑 `openspec validate --strict`、`openspec archive`
与逐 capability 的严格复验，再把改到的主规格字节按 compare-and-swap 写回，并登记
`applied-spec.md`。`--dry-run` 除回执外不写任何文件。退出码：`0` 通过，`1` 用法或状态，
`2` 校验或彩排失败，`3` PATH 上没有 openspec，`4` 主规格在彩排期间被改过。

## 文档证据

```bash
tenon document init <change>
tenon document scaffold <change> <kind>
tenon document scaffold <change> delta-spec --capability <capability>
tenon document record <change> <kind> <path> --producer <skill>
tenon document read <change> all
tenon document status <change> --json
```

scaffold 只创建缺失结构，不登记 producer；delta spec 必须显式提供真实 capability；record 必须对应真实 Skill。Change 语言固定在 `.pipeline-document-locale.json`，不写入严格 canonical schema，以保持旧版本回滚兼容。

## 项目规格骨架

```bash
tenon scaffold spec web
tenon scaffold spec cli --spec-dir docs/specs
tenon scaffold spec lib --document-locale en
```

项目规格骨架也默认生成中文。只有显式传入 `--document-locale en` 才生成英文；路径、命令、OpenSpec 与
workflow token 始终保持英文。冲突策略使用 `--strategy skip|overwrite|append`。
`overwrite` 会在可信项目根下先构建完整顶层项目 envelope，再以持久事务收据提交；进程在目录
切换中崩溃时，下一次调用会先恢复上一事务。检测到仍存活的 writer，或旧 envelope 移走后正式
路径被未知内容占用时，命令会 fail-closed 并保留 lock/stage/backup 恢复证据。

## Review

```bash
tenon review request <change> --event <event>
tenon review acknowledge <change>
tenon review acknowledge <change> --delegated
```

delegated 需要 Change 绑定的持续授权，且不能跳过 check。

`review acknowledge` 退出码：`0` 已确认、重复确认或确认成功但 review marker 清理告警；`2` 没有匹配的待确认
review（缺失、已被消费、binding 失效或 event 已不是 workflow 出口）；`3` revision 冲突（仅 Dashboard CAS
路径）；`4` 幂等键冲突；`1` 非法命令（例如 `--event` 与待确认 receipt 不一致）或意外错误。失败时不写入任何内容。

自动评审与人工确认是两套不同边界：前者是步骤声明的 agent，后者是 `gate: review`，可以叠加。

```bash
tenon agent next <change> [--json]
tenon agent prompt <change> <agent> [--host <id>] [--json]
tenon agent record <change> <run-id> [--json]
```

工作流在步骤里声明执行者与评审者；Tenon 只排顺序、渲染交接内容、记录结论与校验候选版本，
模型一律由宿主跑。`next` 给出本波要跑的 agent，`prompt` 开始或续跑一个 agent 并打印交接内容，
`record` 读报告末尾的 ```tenon-result``` 块登记结论。评审结论由 Tenon 从问题级别与
`block_at` 计算，评审者不自报结论。

退出码：`0` 正常；`1` 用法、IO 或记录损坏；`2` 被拦下（未轮到、宿主不支持、评审期间候选已变化）。

```yaml
name: release-train
steps:
  - id: verify
    label: 验证
    gate: review
    skills:
      - id: acme-quality-gate
    agents:
      reviewers:
        - agent: security
          required: true
          block_at: medium
        - agent: code-size
          required: true
          block_at: medium
          reads_tests: [code-size]
        - agent: architecture
          required: false
          block_at: high
          depends_on: [security, code-size]
```

`required` 的评审者全部通过才能离开该步骤；`required: false` 的只报问题、不拦。
`reads_tests` 引用同一步骤声明的测试，结果由 Tenon 执行后交给评审者。agent 定义放在
全局 agent 库，任务创建时随工作流一起冻结进 `<change>/.pipeline-frozen/`，之后改库不影响
进行中的任务。

## 测试

```bash
tenon test run <change> <test-id> [--json]
tenon test status <change> [--step <id>] [--json]
tenon test baseline <change> <test-id> --run <run-id>
tenon test report <change> [--step <id>] [--write <path>] [--locale zh-CN|en]
tenon test code-size [--base <ref>]
```

工作流的每一步在 YAML 里声明需要跑的测试。只有经 `tenon test run` 的执行会产生记录，
agent 自己跑的结果满足不了必需测试。Tenon 在独立进程组里执行声明的命令，把退出码、耗时、
执行人、输入摘要与输出文件登记到 `.tenon/users/<slug>/tests/<change>/<run-id>.json`，
完整日志与输出副本留在该用户 gitignored 的本机目录。退出码：`0` 通过、`2` 失败（记录已落盘）、
`1` 用法或环境错误（不落记录）。命令可读到 `TENON_CHANGE_NAME`、`TENON_TEST_ID`、
`TENON_TEST_RUN_ID`、`TENON_TEST_ARTIFACTS` 与 `TENON_BASE_BRANCH`。

`test status` 用与转换拦截完全相同的判定列出该步骤每项测试，所以这里通过就是转换会放行；
必需测试失败、过期、未运行或运行中时 exit 2。候选版本、测试声明摘要或工作流指纹任一变化即过期。
`test baseline` 把一次通过运行的指标升为当前用户的基线，旧值进 history；基线按用户维护，
因为基准数值受机器影响。`test report` 由登记结果生成验证报告的测试段，`--write` 替换目标文件里的
标记区间。`test code-size` 是内建 `code-size` 方向背后的确定性探针，输出一行 JSON 指标。

## Session 与恢复

```bash
tenon session activate <change>
tenon session activate <change> --continuous --host-session <id>
tenon session route-context <change> --json
```

## 自动化与高级命令

```bash
tenon afk enqueue <change>
tenon loops list
tenon inbox --json
tenon handoff <change> --json
tenon tap ...
tenon channel ...
```

高级命令可能处理本地敏感数据，先阅读对应安全说明。
