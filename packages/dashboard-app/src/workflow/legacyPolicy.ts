/** 旧 `test_policy` 的只读摘要：涉及的种类（登记 / 必跑 / 有则跑，按出现顺序去重）与范围。 */
import type { WbStepTestPolicy } from '../api/governanceTypes'

export function legacyPolicyKinds(policy: WbStepTestPolicy): string[] {
  return [...new Set([...(policy.kinds ?? []), ...(policy.run ?? []), ...(policy.run_if_registered ?? [])])]
}
