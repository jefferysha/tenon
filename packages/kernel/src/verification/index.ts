/**
 * kernel/verification 公共出口（GOAL 清单 H · H7 verifier）：结构化 verification 结果契约
 * （typed 判决 + 稳定寻址 binding + 可核 evidence + 派生 trust 的 issuer）+ 手写窄校验 + merge 授权谓词。
 *
 * 本子 barrel 由根 kernel src/index.ts re-export；loops/ledger-codec.ts 直连 './validate.js' 内嵌
 * collectVerificationResultErrors，用于校验 RunRecord.verification（loops/ledger-types.ts 承载字段）。
 */
export type {
  VerificationVerdict, VerificationBinding, EvidenceRef, VerificationIssuer, VerificationResult,
} from './types.js'
export {
  validateVerificationResult, collectVerificationResultErrors, isTrustedPass,
} from './validate.js'
export type { VerificationValidation } from './validate.js'
