import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanMandatorySkillInvocability } from './mandatory-invocability.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** The real flow manifest, with one mandatory cell replaced, so the narrow parser is exercised for real. */
async function rootWithExplorePm(cell: string, skills: Record<string, boolean>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mandatory-invocability-'))
  roots.push(root)
  await mkdir(join(root, 'templates'), { recursive: true })
  const manifest = await readFile(join(process.cwd(), 'templates', 'manifest.yaml'), 'utf8')
  await writeFile(
    join(root, 'templates', 'manifest.yaml'),
    manifest.replace(/^ {2}explore\.pm:.*$/mu, `  explore.pm: [${cell}]`),
    'utf8',
  )
  for (const [id, invocable] of Object.entries(skills)) {
    await mkdir(join(root, 'skills', id), { recursive: true })
    await writeFile(
      join(root, 'skills', id, 'SKILL.md'),
      ['---', `name: ${id}`, ...(invocable ? [] : ['disable-model-invocation: true']), '---', '', 'body', ''].join('\n'),
      'utf8',
    )
  }
  return root
}

describe('scanMandatorySkillInvocability', () => {
  it('flags a mandatory skill the host refuses to invoke and names the declaring cell', async () => {
    const scan = await scanMandatorySkillInvocability(await rootWithExplorePm('locked', { locked: false }))
    expect(scan).toMatchObject({ kind: 'scanned' })
    expect(scan.kind === 'scanned' && scan.offenders).toEqual([
      { token: 'locked', skillIds: ['locked'], cells: ['explore.pm'] },
    ])
  })

  it('accepts an a|b token as soon as one alternative is invocable', async () => {
    const scan = await scanMandatorySkillInvocability(
      await rootWithExplorePm('locked|open', { locked: false, open: true }),
    )
    expect(scan).toEqual({ kind: 'scanned', offenders: [] })
  })

  it('stays silent about ids whose bytes are absent, which is every id in a clean checkout', async () => {
    const scan = await scanMandatorySkillInvocability(await rootWithExplorePm('never-fetched', {}))
    expect(scan).toEqual({ kind: 'scanned', offenders: [] })
  })

  it('skips a root without a manifest and refuses to guess for one it cannot parse', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'mandatory-invocability-'))
    roots.push(empty)
    expect(await scanMandatorySkillInvocability(empty)).toEqual({ kind: 'skipped' })
    await mkdir(join(empty, 'templates'), { recursive: true })
    await writeFile(join(empty, 'templates', 'manifest.yaml'), 'phases: not-a-block\n', 'utf8')
    expect((await scanMandatorySkillInvocability(empty)).kind).toBe('unreadable-manifest')
  })

  it('clears the shipped repository manifest against the skills that are actually present', async () => {
    const scan = await scanMandatorySkillInvocability(process.cwd())
    expect(scan).toEqual({ kind: 'scanned', offenders: [] })
  })
})
