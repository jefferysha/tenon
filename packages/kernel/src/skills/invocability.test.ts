import { describe, expect, it } from 'vitest'
import { isSkillModelInvocable, parseSkillFrontmatter, skillTextModelInvocable } from './invocability.js'

function skill(...frontmatter: readonly string[]): string {
  return ['---', ...frontmatter, '---', '', 'body', ''].join('\n')
}

describe('parseSkillFrontmatter', () => {
  it('reads single-line fields and unquotes values', () => {
    const fields = parseSkillFrontmatter(skill('name: grilling', 'description: "Grill, relentlessly"'))
    expect(fields?.get('name')).toBe('grilling')
    expect(fields?.get('description')).toBe('Grill, relentlessly')
  })

  it('returns null without an opening or closing fence', () => {
    expect(parseSkillFrontmatter('# no frontmatter\n')).toBeNull()
    expect(parseSkillFrontmatter('---\nname: x\n')).toBeNull()
  })
})

describe('isSkillModelInvocable', () => {
  it('refuses only an explicit disable-model-invocation: true', () => {
    // 这四行是宿主真实语义的复刻：只有明写 true 才拒绝代模型调用。
    expect(skillTextModelInvocable(skill('name: grilling'))).toBe(true)
    expect(skillTextModelInvocable(skill('name: x', 'disable-model-invocation: false'))).toBe(true)
    expect(skillTextModelInvocable(skill('name: x', 'disable-model-invocation: TRUE'))).toBe(false)
    expect(skillTextModelInvocable(skill('name: x', 'disable-model-invocation: true'))).toBe(false)
  })

  it('treats a file without frontmatter as invocable and a missing map as invocable', () => {
    expect(skillTextModelInvocable('plain markdown')).toBe(true)
    expect(isSkillModelInvocable(null)).toBe(true)
  })

  it('reproduces the exact upstream headers that broke the 0.1.0 explore step', () => {
    const grillWithDocs = [
      '---',
      'name: grill-with-docs',
      "description: A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go.",
      'disable-model-invocation: true',
      '---',
      '',
      'Call the Skill tool twice, for "grilling" and "domain-modeling".',
      '',
    ].join('\n')
    expect(skillTextModelInvocable(grillWithDocs)).toBe(false)
  })
})
