/**
 * 发布候选门禁的一条：`templates/manifest.yaml` 里每个强制 skill token，至少要有一个备选是
 * **宿主允许模型自己调用**的。
 *
 * 为什么必须在这里判：Tenon 的 step.next 会对强制 skill 下发 `load-skill <id>`，宿主 Skill 工具
 * 遇到 `disable-model-invocation: true` 会拒绝执行，于是既跑不起来也留不下 `Skill: <id>` 回执，
 * transition 的 step-skills-incomplete 把该 phase×track 永久锁死（0.1.0 的 explore.pm/frontend/backend
 * 就是这么废掉的）。skills/<id> 在仓库里是 gitignore 的，只有候选载荷（以及安装后的插件根）手里
 * 有真字节，所以这条判定只能在验证候选的这一刻做，做在纯仓库检查里必然是假绿。
 *
 * 判定按 token 而非按 id：`a|b` 是「满足其一即可」，因此只有**全部**备选都被证明不可调用才算坏。
 * 没有字节的备选（干净检出、`plugin:skill` 形态的宿主命名空间）判为未知，不构造证据也不冤枉人。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isSkillModelInvocable,
  loadManifest,
  parseSkillFrontmatter,
  skillTokenAlternatives,
  type SkillTable,
} from '@tenon/kernel'

export interface NonInvocableMandatorySkill {
  /** manifest 里逐字的 token（可能是 `a|b`）。 */
  readonly token: string
  /** 被证明不可调用的具体 skill id（token 的全部备选）。 */
  readonly skillIds: readonly string[]
  /** 声明它的 `phase.track` 格，排序稳定。 */
  readonly cells: readonly string[]
}

export type MandatoryInvocabilityScan =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'unreadable-manifest'; readonly detail: string }
  | { readonly kind: 'scanned'; readonly offenders: readonly NonInvocableMandatorySkill[] }

type Verdict = 'invocable' | 'not-invocable' | 'unknown'

async function verdictFor(skillsRoot: string, skillId: string): Promise<Verdict> {
  // `plugin:skill` 指向宿主自己的 Skill 根，不是本包的 skills/<id>，无从取字节。
  if (skillId.includes(':') || skillId.includes('/')) return 'unknown'
  let text: string
  try {
    text = await readFile(join(skillsRoot, skillId, 'SKILL.md'), 'utf8')
  } catch {
    return 'unknown'
  }
  return isSkillModelInvocable(parseSkillFrontmatter(text)) ? 'invocable' : 'not-invocable'
}

/** token 的全部备选都被 SKILL.md 证明不可调用时返回备选列表；否则（有一个可调用或未知）undefined。 */
async function provenNotInvocable(skillsRoot: string, token: string): Promise<readonly string[] | undefined> {
  const alternatives = skillTokenAlternatives(token)
  const verdicts = await Promise.all(alternatives.map((id) => verdictFor(skillsRoot, id)))
  return verdicts.length > 0 && verdicts.every((verdict) => verdict === 'not-invocable') ? alternatives : undefined
}

/**
 * 写入前的同一判定：一组将要成为强制技能的 token 里，哪些被证明宿主不许模型调用。
 * Dashboard 的 mandatory-skills 写端点用它在落盘前拒绝，而不是等 doctor / 发布校验事后才发现。
 * 语法非法的 token 由调用方的字符集校验先拦；这里遇到会抛出 skillTokenAlternatives 的错误。
 */
export async function nonInvocableSkillTokens(
  skillsRoot: string,
  tokens: readonly string[],
): Promise<readonly { readonly token: string; readonly skillIds: readonly string[] }[]> {
  const offenders: { token: string; skillIds: readonly string[] }[] = []
  for (const token of tokens) {
    const skillIds = await provenNotInvocable(skillsRoot, token)
    if (skillIds !== undefined) offenders.push({ token, skillIds })
  }
  return offenders
}

function tokenCells(table: SkillTable): Map<string, string[]> {
  const cells = new Map<string, string[]>()
  for (const [phase, row] of Object.entries(table)) {
    for (const [track, tokens] of Object.entries(row)) {
      for (const token of tokens ?? []) {
        const seen = cells.get(token) ?? []
        if (!seen.includes(`${phase}.${track}`)) seen.push(`${phase}.${track}`)
        cells.set(token, seen)
      }
    }
  }
  return cells
}

/**
 * 扫描 `<root>/templates/manifest.yaml` 的 mandatory_skills。manifest 不存在 = 该根不声明强制
 * 技能（合成 fixture / 非完整载荷），跳过；存在但解析不了 = 无法证明，如实报不可读。
 */
export async function scanMandatorySkillInvocability(
  root: string,
  options: { readonly manifestPath?: string; readonly skillsRoot?: string } = {},
): Promise<MandatoryInvocabilityScan> {
  const manifestPath = options.manifestPath ?? join(root, 'templates', 'manifest.yaml')
  const skillsRoot = options.skillsRoot ?? join(root, 'skills')
  let table: SkillTable
  try {
    await readFile(manifestPath, 'utf8')
  } catch {
    return { kind: 'skipped' }
  }
  try {
    table = loadManifest(manifestPath).mandatorySkills
  } catch (error) {
    return { kind: 'unreadable-manifest', detail: error instanceof Error ? error.message : String(error) }
  }
  const offenders: NonInvocableMandatorySkill[] = []
  for (const [token, cells] of tokenCells(table)) {
    let skillIds: readonly string[] | undefined
    try {
      skillIds = await provenNotInvocable(skillsRoot, token)
    } catch (error) {
      return { kind: 'unreadable-manifest', detail: error instanceof Error ? error.message : String(error) }
    }
    if (skillIds !== undefined) offenders.push({ token, skillIds, cells: [...cells].sort() })
  }
  return { kind: 'scanned', offenders: offenders.sort((left, right) => left.token.localeCompare(right.token)) }
}
