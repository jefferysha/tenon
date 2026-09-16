/**
 * 测试证据判定的注入面装配。身份或工作区指纹任一缺失就返回 undefined——kernel 据此失败关闭，
 * 绝不把「读不到证据」当成「证据通过」。
 */
import { isTenonUser, userSlug, type TestEvidenceContext } from '@tenon/kernel'
import type { CliDeps } from './deps.js'

export function testEvidenceContextFor(deps: CliDeps, changeName: string): TestEvidenceContext | undefined {
  const user = deps.user()
  const fingerprint = deps.workspaceFingerprint
  if (!isTenonUser(user) || fingerprint === undefined) return undefined
  return {
    user: { id: user.id, name: user.name, slug: userSlug(user.id) },
    currentCandidate: () => fingerprint(changeName),
  }
}
