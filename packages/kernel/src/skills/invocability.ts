/**
 * SKILL.md frontmatter 里的「宿主允不允许模型自己调这个技能」这一位事实。
 *
 * 宿主（Claude Code / Codex）把 `disable-model-invocation: true` 当作「只能由人手动触发」：
 * Skill 工具拒绝代模型执行它，因此 Tenon 的 `step.next: load-skill <id>` 永远跑不起来，也就
 * 永远拿不到 `Skill: <id>` 回执，transition 的 step-skills-incomplete 会把该 step 锁死。
 * 所以「强制技能必须模型可调用」是一条契约，不是偏好；判定实现只此一处，获取期（写进
 * skills.lock.json 的 model_invocable）、发布候选校验与 doctor 都从这里取同一份语义。
 */

/** `---` 包起来的单行 `key: value` 头；没有闭合的 `---` 块时返回 null（与非 Skill 文件一视同仁）。 */
export function parseSkillFrontmatter(text: string): ReadonlyMap<string, string> | null {
  const lines = text.split(/\r?\n/u)
  if (lines[0]?.trim() !== '---') return null
  const fields = new Map<string, string>()
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') return fields
    const match = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/u.exec(line)
    const key = match?.[1]
    if (key === undefined || fields.has(key)) continue
    fields.set(key, unquote(match?.[2] ?? ''))
  }
  return null
}

function unquote(value: string): string {
  const s = value.trim()
  return s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.at(-1) === s[0] ? s.slice(1, -1) : s
}

export const SKILL_MODEL_INVOCATION_DISABLED_FIELD = 'disable-model-invocation'

/**
 * 只有明写 `disable-model-invocation: true` 才算不可调用。缺字段、写 false、写别的值都按可调用
 * 处理——宿主本身就是这么读的，这里不自造更严格的方言。
 */
export function isSkillModelInvocable(fields: ReadonlyMap<string, string> | null): boolean {
  return fields?.get(SKILL_MODEL_INVOCATION_DISABLED_FIELD)?.trim().toLowerCase() !== 'true'
}

/** SKILL.md 全文 → 模型可调用与否。无 frontmatter 的文件同样按可调用处理。 */
export function skillTextModelInvocable(text: string): boolean {
  return isSkillModelInvocable(parseSkillFrontmatter(text))
}
