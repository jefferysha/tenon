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
tenon review-attempt begin <change> --candidate <fingerprint> --json
tenon review-attempt lane <change> --attempt-id <id> --lane <lane> \
  --result <pass|fail> --report <项目内相对路径> --json
tenon review-attempt complete <change> --attempt-id <id> \
  --result <pass|fail> --report <项目内相对路径> --json
tenon review-budget show <change> --json
tenon review-budget set <change> --max-attempts <1..20> --json
```

delegated 需要 Change 绑定的持续授权，且不能跳过 check。

`review acknowledge` 退出码：`0` 已确认、重复确认或确认成功但 review marker 清理告警；`2` 没有匹配的待确认
review（缺失、已被消费、binding 失效或 event 已不是 workflow 出口）；`3` revision 冲突（仅 Dashboard CAS
路径）；`4` 幂等键冲突；`1` 非法命令（例如 `--event` 与待确认 receipt 不一致）或意外错误。失败时不写入任何内容。

自动 Review 与人工确认是两套不同边界。一次冻结候选只消耗一次 attempt，代码、规格、安全、
E2E、浏览器和视觉验收都是该 attempt 的 lane；lane 分片、重跑和恢复不会重复计数。
`review-budget set` 绑定当前 Run、Workflow 指纹和 step，active attempt 存在时不能改上限，
也不能把上限降到已使用次数以下。

Workflow 用显式契约识别 Review，不根据 Skill 名称或命令文本猜测：

```yaml
name: release-train
review_budget:
  version: v1
  max_attempts: 2
steps:
  - id: verify
    label: 验证
    gate: review
    review_lanes: [standards, spec, e2e]
    skills:
      - id: acme-quality-gate
        kind: review
        review_lane: standards
      - id: e2e-looking-work
        kind: work
```

默认插件在 `templates/manifest.yaml` 的 `review_skills` 中声明打包 Skill 与 lane 的映射；
自定义 Workflow 必须同时声明 `kind: review` 和所属 `review_lane`。未声明的第三方 Skill
一律是普通工作，不消耗 Review 次数。Dashboard 策略编辑器可以直接配置 `max_attempts`，
并会保留 lane 与 Skill 分类字段。

## 测试

```bash
tenon test run <change> <test-id> [--json]
```

工作流的每一步在 YAML 里声明需要跑的测试。只有经 `tenon test run` 的执行会产生记录，
agent 自己跑的结果满足不了必需测试。Tenon 在独立进程组里执行声明的命令，把退出码、耗时、
执行人、输入摘要与输出文件登记到 `.tenon/users/<slug>/tests/<change>/<run-id>.json`，
完整日志与输出副本留在该用户 gitignored 的本机目录。退出码：`0` 通过、`2` 失败（记录已落盘）、
`1` 用法或环境错误（不落记录）。命令可读到 `TENON_CHANGE_NAME`、`TENON_TEST_ID`、
`TENON_TEST_RUN_ID`、`TENON_TEST_ARTIFACTS` 与 `TENON_BASE_BRANCH`。

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
