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
 * 强制技能的声明处：一步该加载什么技能只看工作流 YAML（`templates/workflows/*.yaml` 的步骤 `skills`，
 * 带 `tracks:` 的逐分支）；manifest 的 `mandatory_skills` 矩阵已退出随包模板，但用户自己的 manifest
 * 仍可能带，所以两处并集扫描。声明处标注不分 profile：`<工作流>.<轨道>.<步骤>`（平铺工作流没有轨道段）。
 *
 * 判定按 token 而非按 id：`a|b` 是「满足其一即可」，因此只有**全部**备选都被证明不可调用才算坏。
 * 没有字节的备选（干净检出、`plugin:skill` 形态的宿主命名空间）判为未知，不构造证据也不冤枉人。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isSkillModelInvocable,
  loadManifest,
  parseSkillFrontmatter,
  parseWorkflow,
  skillTokenAlternatives,
  type SkillTable,
  type StepDef,
} from '@tenon/kernel'

export interface NonInvocableMandatorySkill {
  /** manifest 里逐字的 token（可能是 `a|b`）。 */
  readonly token: string
  /** 被证明不可调用的具体 skill id（token 的全部备选）。 */
  readonly skillIds: readonly string[]
  /** 声明它的格（manifest 矩阵的 `phase.track`，或工作流步骤的 `工作流.轨道.步骤`），排序稳定。 */
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

type TokenCells = Map<string, string[]>

function addCell(cells: TokenCells, token: string, cell: string): void {
  const seen = cells.get(token) ?? []
  if (!seen.includes(cell)) seen.push(cell)
  cells.set(token, seen)
}

function tokenCells(table: SkillTable, into: TokenCells): void {
  for (const [phase, row] of Object.entries(table)) {
    for (const [track, tokens] of Object.entries(row)) {
      for (const token of tokens ?? []) addCell(into, token, `${phase}.${track}`)
    }
  }
}

function workflowTokenCells(text: string, into: TokenCells): void {
  const definition = parseWorkflow(text)
  const addSteps = (prefix: string, steps: readonly StepDef[]): void => {
    for (const step of steps) {
      for (const skill of step.skills) addCell(into, skill.id, `${prefix}.${step.id}`)
    }
  }
  addSteps(definition.name, definition.steps)
  for (const [track, branch] of Object.entries(definition.tracks ?? {})) {
    addSteps(`${definition.name}.${track}`, branch.steps)
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** `<workflowsDir>/*.yaml` 的文件名，排序稳定；目录不存在 = 没有工作流。 */
async function workflowFiles(workflowsDir: string): Promise<readonly string[]> {
  try {
    return (await readdir(workflowsDir)).filter((name) => name.endsWith('.yaml')).sort()
  } catch {
    return []
  }
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * 扫描强制技能的声明处：`<root>/templates/workflows/*.yaml` 的步骤技能，加 `<root>/templates/manifest.yaml`
 * 的 mandatory_skills（用户自己的 manifest 可能还带）。两处都没有 = 该根不声明强制技能（合成 fixture /
 * 非完整载荷），跳过；存在但解析不了 = 无法证明，如实报不可读（detail 点名文件）。
 */
export async function scanMandatorySkillInvocability(
  root: string,
  options: {
    readonly manifestPath?: string
    readonly workflowsDir?: string
    readonly skillsRoot?: string
  } = {},
): Promise<MandatoryInvocabilityScan> {
  const manifestPath = options.manifestPath ?? join(root, 'templates', 'manifest.yaml')
  const workflowsDir = options.workflowsDir ?? join(root, 'templates', 'workflows')
  const skillsRoot = options.skillsRoot ?? join(root, 'skills')
  const declared: TokenCells = new Map()
  let anyDeclaration = false
  if (await readOptional(manifestPath) !== undefined) {
    anyDeclaration = true
    try {
      tokenCells(loadManifest(manifestPath).mandatorySkills, declared)
    } catch (error) {
      return { kind: 'unreadable-manifest', detail: messageOf(error) }
    }
  }
  for (const file of await workflowFiles(workflowsDir)) {
    anyDeclaration = true
    try {
      // 目录里列出来的文件读不了就是无法证明（不是「没有声明」）：不静默跳过。
      workflowTokenCells(await readFile(join(workflowsDir, file), 'utf8'), declared)
    } catch (error) {
      return { kind: 'unreadable-manifest', detail: `${file}: ${messageOf(error)}` }
    }
  }
  if (!anyDeclaration) return { kind: 'skipped' }
  const offenders: NonInvocableMandatorySkill[] = []
  for (const [token, cells] of declared) {
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
