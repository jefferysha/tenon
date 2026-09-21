/**
 * 文档治理策略的内容指纹：排序归一后做 sha256。workflow plan 指纹只引用它的结果，
 * 所以它单独成文件，effective-plan 不必为此多背 35 行。
 */
import { sha256Hex } from '../sha256.js'
import type { DocumentGovernancePolicy } from './document-contract.js'

function canonicalRequirement(requirement: {
  readonly kind: string; readonly producerCandidates: readonly string[]
}): { readonly kind: string; readonly producerCandidates: readonly string[] } {
  return {
    kind: requirement.kind,
    producerCandidates: [...new Set(requirement.producerCandidates)].sort(),
  }
}
export function documentGovernanceFingerprint(policy: DocumentGovernancePolicy): string {
  const canonical = {
    id: policy.id,
    steps: [...policy.steps],
    outputsByStep: Object.fromEntries(policy.steps.map((step) => [
      step,
      [...(policy.outputsByStep[step] ?? [])]
        .map(canonicalRequirement)
        .sort((left, right) => left.kind.localeCompare(right.kind)),
    ])),
    mutableByStep: Object.fromEntries(policy.steps.map((step) => [
      step,
      [...(policy.mutableByStep[step] ?? [])]
        .map(canonicalRequirement)
        .sort((left, right) => left.kind.localeCompare(right.kind)),
    ])),
    readsByStep: Object.fromEntries(policy.steps.map((step) => [
      step,
      [...new Set(policy.readsByStep[step] ?? [])].sort(),
    ])),
    ...(policy.requiresByStep === undefined ? {} : { requiresByStep: Object.fromEntries(policy.steps.map((step) => [step, [...new Set(policy.requiresByStep?.[step] ?? [])].sort()])) }),
  }
  return sha256Hex(JSON.stringify(canonical))
}
