/**
 * 步骤内的技能完成证据：`.pipeline-history.jsonl` 里「最近一次进入当前步骤之后」完成了哪些技能。
 *
 * 技能门与动画门共用这一份扫描：两者问的是同一个事实（本次进入该步骤之后有没有读过某个技能），
 * 只是各自据此做不同判定。宿主形态有两种，都由 hooks/skill-tracker.sh 写入：
 * Claude 的 `Skill: <id>` 与 Codex 对已打包 SKILL.md 的受控读取 `CodexSkillRead: <id>`。
 */
export interface HistLine {
  readonly kind: string
  readonly to?: string
  readonly raw?: string
}

function decodeHistoryLine(value: unknown): HistLine | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.kind !== 'string') return null
  if (record.to !== undefined && typeof record.to !== 'string') return null
  if (record.raw !== undefined && typeof record.raw !== 'string') return null
  return {
    kind: record.kind,
    ...(typeof record.to === 'string' ? { to: record.to } : {}),
    ...(typeof record.raw === 'string' ? { raw: record.raw } : {}),
  }
}

/** 容错解析 .pipeline-history.jsonl 原文——单行损坏不该拖垮整条 gate 判定，跳过即可（fail-open 精神）。 */
export function parseHistoryLines(raw: string): HistLine[] {
  const out: HistLine[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const decoded = decodeHistoryLine(JSON.parse(line))
      if (decoded) out.push(decoded)
    } catch {
      // 损坏行跳过，不拖垮整体判定
    }
  }
  return out
}

export function skillIdFromToolRaw(raw: string): string | null {
  const m = /^(?:Skill|CodexSkillRead): (.+)$/.exec(raw)
  return m?.[1] ?? null
}

/** Pipeline-owned skills are presented by Codex as `tenon:<id>`, while workflow YAML and
 * immutable cache receipts use their bare id. Canonicalize this one plugin namespace before DAG
 * membership and prior-completion comparisons; leave third-party namespaces intact so custom
 * workflows can still model them explicitly. */
export function canonicalTenonSkillId(skillId: string): string {
  return skillId.startsWith('tenon:') ? skillId.slice('tenon:'.length) : skillId
}

/**
 * 「本次进入 currentStepId 之后」完成的技能集合。
 *
 * 复用 workflow-skill-orchestration.integration.test.ts 的 index-based 分段扫描写法（先定位
 * 分段起点索引，再 slice 之后的区间），只是这里要找"最近一次"（倒序扫描取第一个命中）而非
 * 该测试里固定线性顺序的"第一次"（正序 findIndex）——需求不同，扫描 shape 相同。
 */
export function completedSkillsSinceStepEntry(lines: readonly HistLine[], currentStepId: string): ReadonlySet<string> {
  let enteredAt = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.kind === 'transition' && lines[i]?.to === currentStepId) {
      enteredAt = i
      break
    }
  }
  const completed = new Set<string>()
  for (const line of lines.slice(enteredAt + 1)) {
    if (line.kind !== 'tool') continue
    const id = skillIdFromToolRaw(line.raw ?? '')
    if (id) completed.add(canonicalTenonSkillId(id))
  }
  return completed
}
