/**
 * compress —— 上下文压缩子系统出口（BACKLOG #30 / GOAL B13·D11）。
 * 本 barrel 由根 kernel src/index.ts re-export；消费方经 '@tenon/kernel' 包名导入。
 */
export type { CompressOptions, CompressStats, CompressedDoc, KeyField } from './types.js'
export type { FrontMatter, Heading } from './markdown.js'
export {
  isConstraint,
  isDecision,
  isDoneTodo,
  isHeading,
  openTodoText,
  parseFrontMatter,
  stripLeadMarkers,
} from './markdown.js'
export { compressDocument, ratioOf, renderHandoffSummary, statsFor } from './compress.js'
export {
  buildAttemptContext,
  detectAttemptStagnation,
  normalizeAttemptError,
  type AttemptContext,
  type AttemptContextOptions,
  type AttemptStagnation,
  type NormalizedAttemptError,
  type RunAttemptRecord,
} from './attempt-context.js'
export {
  compileContextBundle,
  contextBundleAggregateDigest,
  ContextBundleError,
  verifyContextBundleAggregate,
  type CompileContextBundleInput,
  type ContextBundleInputV1,
  type ContextBundleMode,
  type ContextBundleTier,
  type ContextBundleV1,
} from './context-bundle.js'
export {
  compileLedgerContextBundleWithPorts,
  DEFAULT_LEDGER_CONTEXT_BUNDLE_BUDGET_BYTES,
  DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS,
  LedgerContextBundleError,
  type CompiledLedgerContextBundle,
  type CompileLedgerContextBundleInput,
  type CompileLedgerContextBundleWithPortsInput,
  type LedgerContextBundleErrorCode,
  type LedgerContextBundleInputSummary,
  type LedgerContextBundleLedgerRepository,
  type LedgerContextBundlePreview,
  type LedgerContextBundlePrimitives,
  type LedgerContextBundleResourceLimits,
  type LedgerContextBundleSource,
  type LedgerContextBundleSourceReadLimit,
  type LedgerContextBundleSourceReader,
} from './ledger-context-bundle.js'
export {
  compileLedgerContextBundle,
  compileObservedContextBundle,
  nodeLedgerContextBundlePrimitives,
  type CompileObservedContextBundleInput,
} from './ledger-context-bundle-node-adapter.js'
// 观察模式（没有旧文档契约的新任务）：包的输入是当前步骤的交接输入，CLI 与 server 按 capabilities.documents.mode 选用。
export {
  compileObservedContextBundleWithPorts,
  type CompiledObservedContextBundle,
  type CompileObservedContextBundleWithPortsInput,
  type ObservedBundleRepository,
  type ObservedBundleSource,
  type ObservedContextBundleInputSummary,
  type ObservedContextBundlePreview,
} from './observed-context-bundle.js'
export {
  buildHandoff,
  nodeHandoffFs,
  phaseHandoffDocs,
  type DocKind,
  type HandoffDocResult,
  type HandoffDocSpec,
  type HandoffFs,
  type HandoffInput,
  type HandoffResult,
} from './handoff.js'
