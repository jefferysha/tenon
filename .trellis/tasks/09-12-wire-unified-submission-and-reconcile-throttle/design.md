# 设计

## 统一入口

CLI 和 server 在每个 change 上创建由 `artifactNamespaceForChange(changeDir)` 派生的 change-level namespace 的 submission service。Document adapter 继续调用 `recordDocument()`，field adapter 继续调用 StateStore reducer 并写 field sidecar，runtime adapter 调用 `submitArtifactOutput()`；三者只共享 subject resolution 和 submission receipt，不互相依赖存储。

CLI 通过 `CliDeps` 注入可选 submission factory，生产 main 和 integration harness 使用同一装配。旧命令在没有 factory 的测试 harness 中保留兼容路径，但生产路径必须显式注入。

## Namespace 与 subject resolution

namespace 绑定 change 的稳定身份，不使用 `runtime-artifacts`、`field`、`document` 这类 projection namespace。logical key 由 workflow contract/显式 declaration 提供；缺少 logical key 时生成 host-issued subject，并记录 unresolved diagnostic。

## Reconcile 降频

Codex executor 为每个执行 turn 建立一个 `reconcileScheduled` 标志：首个无 path managed completion 安排一次 reconcile，同一 turn 后续无 path 事件只累计诊断；有结构化 path 的事件仍立即 observe。阶段结束由 `StageArtifactRuntime.end()` 做最终 reconcile。

## Evidence

新增真实 backend runner/evidence JSON，执行 document、field、runtime、rename、reconcile-only、restart，并把当前 git SHA 与关键 runtime 事件写入证据；证据脚本失败即退出非零。
