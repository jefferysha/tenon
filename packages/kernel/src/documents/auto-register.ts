import { readDocumentLedger } from '../state/document-ledger.js'
import { resolveDocument } from '../state/document-path.js'
import { skillsEquivalent } from '../state/document-record-policy.js'
import type { DocumentGovernancePolicy, DocumentKind } from '../workflow/document-contract.js'
import { canonicalDocumentPaths } from './document-paths.js'
import { recordDocument } from './document-recording.js'

export interface AutoRegisterInput {
  readonly repoRoot: string
  readonly changeDir: string
  readonly changeName: string
  readonly phase: string
  readonly policy: DocumentGovernancePolicy
  /** 刚完成调用的技能 id（宿主回执里的原样 id）。 */
  readonly producer: string
  readonly recordedAt: string
}

export interface AutoRegisterOutcome {
  readonly recorded: ReadonlyArray<{ kind: DocumentKind; path: string }>
  readonly skipped: ReadonlyArray<{ kind: DocumentKind; path: string; reason: string }>
}

/**
 * 技能调用结束后的自动登记：
 *   候选 = 当前阶段拥有的文档槽位 ∪ 本阶段允许改写的活文档，且 producerCandidates 含该技能；
 *   对每个候选 kind 的每条规范路径：文件存在且（未登记 或 digest 已变）→ recordDocument；
 *   已一致 → skip；登记失败 → skip 带原因，绝不抛（hook 总纲 fail-open）。
 * 不匹配规范路径的文件不登记、不猜。
 */
export interface AutoRegisterDeps {
  readonly record: typeof recordDocument
}

export async function autoRegisterDocuments(input: AutoRegisterInput, deps: AutoRegisterDeps = { record: recordDocument }): Promise<AutoRegisterOutcome> {
  const recorded: Array<{ kind: DocumentKind; path: string }> = []
  const skipped: Array<{ kind: DocumentKind; path: string; reason: string }> = []
  const requirements = [
    ...(input.policy.outputsByStep[input.phase] ?? []),
    ...(input.policy.mutableByStep[input.phase] ?? []),
  ].filter((requirement) => requirement.producerCandidates.some((candidate) => skillsEquivalent(candidate, input.producer)))
  if (requirements.length === 0) return { recorded, skipped }
  let ledger
  try {
    ledger = await readDocumentLedger(input.changeDir)
  } catch (error) {
    return { recorded, skipped: [{ kind: requirements[0]!.kind, path: '', reason: error instanceof Error ? error.message : String(error) }] }
  }
  const seen = new Set<string>()
  for (const requirement of requirements) {
    if (seen.has(requirement.kind)) continue
    seen.add(requirement.kind)
    const kind = requirement.kind
    for (const path of await canonicalDocumentPaths(input.repoRoot, input.changeName, kind)) {
      try {
        const current = await resolveDocument(input.repoRoot, path)
        const existing = (ledger?.records ?? []).filter((record) => record.kind === kind && record.path === path).at(-1)
        if (existing !== undefined && existing.sha256 === current.digest) {
          skipped.push({ kind, path, reason: 'up-to-date' })
          continue
        }
        await deps.record({
          repoRoot: input.repoRoot,
          changeDir: input.changeDir,
          phase: input.phase,
          policy: input.policy,
          kind,
          path,
          producer: input.producer,
          recordedAt: input.recordedAt,
        })
        recorded.push({ kind, path })
      } catch (error) {
        skipped.push({ kind, path, reason: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return { recorded, skipped }
}
