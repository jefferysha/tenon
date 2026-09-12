/**
 * @tenon/automation 公共出口（BACKLOG #29/#29b, GOAL A5/M5）。
 * 5 包语义盘点 + 队列生命周期状态机见 ./types.ts 顶注。默认 L1 report-only（不自动 merge）。
 */
export * from './types.js'
export * from './artifacts/index.js'
export * from './triage/index.js'
// queue：状态机 / cas 并发闸 / 扫描 / 门联动
export * from './queue/state-machine.js'
export * from './queue/claim.js'
export * from './queue/scan.js'
export * from './queue/gate.js'
// scheduler：信号量 / 失败分类 / 轮调度
export * from './scheduler/semaphore.js'
export * from './scheduler/classify.js'
export * from './scheduler/scheduler.js'
// GOAL H · Stage B+C：ExecutionContext + loop admission（原子 preflight / reservation 生命周期 /
// kill-switch / 崩溃恢复）
export { makeIdGen } from './admission/execution-context.js'
export type {
  ExecutionContext, PreparationFailureReason, PreparedSkillSlot, PreparedSkillBundle,
  LoopPreparedExecutionContext, NonLoopExecutionContext, PreparedExecutionContext,
  PrepareOutcome, ExecutionPreparationPort, CapturedExecutionCoordinate, ExecutionCoordinatePort,
} from './admission/execution-context.js'
export * from './admission/loop-admission.js'
// lifecycle：沙箱生命周期编排 / build_sha barrier
export * from './lifecycle/barrier.js'
export * from './lifecycle/lifecycle.js'
// GOAL H · H7 verifier Phase 2：公共面只暴露 verifier 配置/类型与纯 gate；boundary 签发器和
// WeakSet provenance 检查保持包内，普通 RunChange 不能从 package 根给自己签发可信结果。
export {
  DEFAULT_VERIFIER_ISSUER_KIND, createDefaultVerifierPort, evaluateVerificationGate,
  VERIFY_BUILD_REVISION_REMEDIATION, VERIFY_BUILD_REVISION_UNTRUSTED,
} from './verifier/verifier.js'
export type {
  VerifierInput, VerifierPort, DefaultVerifierPortOptions, VerificationBlockReason,
  VerificationGateInput, VerificationGateResult,
} from './verifier/verifier.js'
// H14 生产 L3：宿主对权威 worktree revision 执行固定 Git 完整性核验，真实 exit code 签发。
export {
  createGitRevisionVerifier, GIT_REVISION_VERIFIER_ISSUER_IDENTITY,
} from './verifier/git-revision-verifier.js'
export type { GitRevisionVerifierOptions } from './verifier/git-revision-verifier.js'
// T4：沙箱内阶段回写（[TRANSITION] 检出）+ loop denylist 结算检查（决议 #12）
export * from './lifecycle/transitionWatch.js'
// 已提交 spec->build 的后置 AFK 入队（不启动 runner；由 Track policy 单独授权）。
export * from './lifecycle/spec-complete.js'
export * from './lifecycle/denylist.js'
// T20：runner 双支持——change → loop 声明 runner 的派生（分派口径在 runner.ts::buildAfkRunCommand）
export * from './lifecycle/runnerFor.js'
// runner：结构化握手解析 / docker 探针
export * from './runner/runner.js'
export * from './runner/docker.js'
// T21：per-root .pipeline/automation.json 读模块（AFK 执行参数配置面的数据面）
export * from './config/automationJson.js'
// sdk：对外编排 API
export * from './sdk/sdk.js'
export type { AfkInteractionReceiptPort } from './skillInvocationAfkLifecycle.js'
// #29-wire：真 docker 执行接线（createLifecyclePorts + runChangeInSandbox → RunChange）
export * from './sdk/dockerRunChange.js'
// ─── BACKLOG #29c：docker 全链执行（真 docker / 真 git worktree / 真 merge-back）───
// runner：exec 注入面 / boundedTail 64KiB / git 双挂载 / 三路 race / docker 容器全链
export * from './runner/exec.js'
export * from './runner/boundedTail.js'
export * from './runner/gitMounts.js'
export * from './runner/race.js'
export * from './runner/container.js'
// lifecycle：真 git worktree / 真 merge-back 守卫 / 生产 LifecyclePorts 装配
export * from './lifecycle/worktree.js'
export * from './lifecycle/mergeback.js'
export * from './lifecycle/ports.js'
// H10-T4：skill 内容定位（多根枚举 + 歧义拒绝）+ CAS 快照物化——H10-T7 CLI 生产装配（content-locator
// 根枚举、ExecutionPreparationDeps.locator 绑定）消费本出口，之前只在包内可见、跨包不可 import。
export * from './skills/content-locator.js'
export * from './skills/production-content-locator.js'
export * from './skills/wiring.js'
export * from './skills/snapshot-store.js'
export * from './skills/skill-provenance.js'
export * from './skills/types.js'
export * from './starters/wiring.js'
export * from './starters/execution-guard.js'
export * from './task-plan-run/journal.js'
export * from './task-plan-run/admission.js'
export * from './task-plan-run/executor.js'
// autonomous orchestration application boundary: provider-neutral assessment and
// Kernel-command-driven Skill execution. No vendor/provider implementation is bundled here.
export * from './orchestration/proposal.js'
export * from './orchestration/execution.js'
// v2 planner: immutable natural-language assessment, user/custom catalog
// normalization, deterministic WorkGraph and capability resolution.
export * from './orchestration/planner-v2.js'
export { materializeWorkflowPipelineV2 } from './orchestration/workflow-pipeline-v2.js'
export type { MaterializeWorkflowPipelineInputV2, PipelineIdentityV2 } from './orchestration/workflow-pipeline-v2.js'
// v2 durable executor: lease-aware, validator-bound, retryable runtime over the Kernel ledger.
export * from './orchestration/runtime-v2.js'
export * from './orchestration/input-materialization-v2.js'
export * from './orchestration/autonomous-orchestrator-v2.js'
export {
  readSealedAfkSkillInvocationContext,
  SealedAfkSkillInvocationContextError,
} from './skillInvocationSealedAfkContext.js'
export type { SealedAfkSkillInvocationContext } from './skillInvocationSealedAfkContext.js'
// Runtime artifact observation/publication adapter for arbitrary skill executions.
export * from './artifact-runtime/index.js'
