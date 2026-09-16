/**
 * 测试证据判定的注入面装配。身份缺失返回 undefined——记录按用户存放，没有身份就没有可读的证据集，
 * kernel 据此失败关闭，绝不把「读不到证据」当成「证据通过」。
 *
 * 工作区指纹是可降级能力：宿主没接就不传，判定跳过候选比对，其余三条新鲜度绑定照查
 * （见 kernel TestEvidenceContext 的注释）。生产装配（main.ts / server）恒有这项能力。
 */
import { evaluateTestEvidence, isTenonUser, userSlug } from '@tenon/kernel'
import type { TestEvidenceContext, TestEvidenceReader } from '@tenon/kernel'
import type { CliDeps } from './deps.js'

/** 判定读取器：缺省权威读取，只有单测覆写（见 CliDeps.testEvidence）。 */
export function testEvidenceReaderFor(deps: CliDeps): TestEvidenceReader {
  return deps.testEvidence ?? evaluateTestEvidence
}

export function testEvidenceContextFor(deps: CliDeps, changeName: string): TestEvidenceContext | undefined {
  const user = deps.user()
  if (!isTenonUser(user)) return undefined
  const fingerprint = deps.workspaceFingerprint
  return {
    user: { id: user.id, name: user.name, slug: userSlug(user.id) },
    ...(fingerprint === undefined ? {} : { currentCandidate: () => fingerprint(changeName) }),
  }
}
