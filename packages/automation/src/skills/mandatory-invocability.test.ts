import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanMandatorySkillInvocability } from './mandatory-invocability.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/**
 * The real flow manifest plus a `mandatory_skills` section (the shipped manifest no longer carries the
 * matrix, but a user's manifest still may), so the narrow parser is exercised for real.
 */
async function rootWithExplorePm(cell: string, skills: Record<string, boolean>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mandatory-invocability-'))
  roots.push(root)
  await mkdir(join(root, 'templates'), { recursive: true })
  const manifest = await readFile(join(process.cwd(), 'templates', 'manifest.yaml'), 'utf8')
  await writeFile(
    join(root, 'templates', 'manifest.yaml'),
    `${manifest}\nmandatory_skills:\n  explore.pm: [${cell}]\n`,
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

const step = (id: string, skill: string): string => `      - id: ${id}
        label: ${id}
        gate: null
        skills:
          - id: ${skill}
        inputs: []
        outputs: []
        guards: []
        transitions: []
`

const TRACKED_WORKFLOW = (backendSkill: string, frontendSkill: string): string => `name: demo
tracks:
  backend:
    steps:
${step('explore', backendSkill)}  frontend:
    steps:
${step('explore', frontendSkill)}`

const FLAT_WORKFLOW = (skill: string): string => `name: flat
steps:
${step('explore', skill).replaceAll(/^ {4}/gmu, '')}`

/** 强制技能现在只写在工作流 YAML 的步骤里（不分 profile）：造一个只有 `templates/workflows/*.yaml` 的根。 */
async function rootWithWorkflows(
  workflows: Record<string, string>,
  skills: Record<string, boolean>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mandatory-invocability-wf-'))
  roots.push(root)
  await mkdir(join(root, 'templates', 'workflows'), { recursive: true })
  for (const [file, text] of Object.entries(workflows)) {
    await writeFile(join(root, 'templates', 'workflows', file), text, 'utf8')
  }
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

describe('scanMandatorySkillInvocability · 工作流步骤里的技能', () => {
  it('flags a step skill the host refuses to invoke and names the declaring track and step', async () => {
    const root = await rootWithWorkflows(
      { 'demo.yaml': TRACKED_WORKFLOW('locked', 'open') },
      { locked: false, open: true },
    )

    const scan = await scanMandatorySkillInvocability(root)

    expect(scan).toEqual({
      kind: 'scanned',
      offenders: [{ token: 'locked', skillIds: ['locked'], cells: ['demo.backend.explore'] }],
    })
  })

  it('collects every cell that declares the same locked skill, sorted', async () => {
    const root = await rootWithWorkflows(
      { 'demo.yaml': TRACKED_WORKFLOW('locked', 'locked') },
      { locked: false },
    )

    const scan = await scanMandatorySkillInvocability(root)

    expect(scan.kind === 'scanned' && scan.offenders).toEqual([
      { token: 'locked', skillIds: ['locked'], cells: ['demo.backend.explore', 'demo.frontend.explore'] },
    ])
  })

  it('a flat workflow has no track segment in the cell name', async () => {
    const root = await rootWithWorkflows({ 'flat.yaml': FLAT_WORKFLOW('locked') }, { locked: false })

    const scan = await scanMandatorySkillInvocability(root)

    expect(scan.kind === 'scanned' && scan.offenders).toEqual([
      { token: 'locked', skillIds: ['locked'], cells: ['flat.explore'] },
    ])
  })

  it('is silent about step skills whose bytes are absent (a clean checkout)', async () => {
    const root = await rootWithWorkflows({ 'demo.yaml': TRACKED_WORKFLOW('never-fetched', 'also-absent') }, {})

    expect(await scanMandatorySkillInvocability(root)).toEqual({ kind: 'scanned', offenders: [] })
  })

  it('refuses to guess for a workflow it cannot parse, naming the file', async () => {
    const root = await rootWithWorkflows({ 'broken.yaml': 'name: broken\nsteps: not-a-list\n' }, {})

    const scan = await scanMandatorySkillInvocability(root)

    expect(scan.kind).toBe('unreadable-manifest')
    expect(scan.kind === 'unreadable-manifest' && scan.detail).toContain('broken.yaml')
  })

  it('a workflow file that is listed but cannot be read is unreadable, not silently skipped', async () => {
    const root = await rootWithWorkflows({}, {})
    await mkdir(join(root, 'templates', 'workflows', 'unreadable.yaml'))

    const scan = await scanMandatorySkillInvocability(root)

    expect(scan.kind).toBe('unreadable-manifest')
    expect(scan.kind === 'unreadable-manifest' && scan.detail).toContain('unreadable.yaml')
  })

  it('still skips a root that declares neither a manifest nor any workflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mandatory-invocability-empty-'))
    roots.push(root)
    await mkdir(join(root, 'templates', 'workflows'), { recursive: true })

    expect(await scanMandatorySkillInvocability(root)).toEqual({ kind: 'skipped' })
  })

  it('merges the manifest matrix and the workflow steps into one scan', async () => {
    const root = await rootWithExplorePm('locked-a', { 'locked-a': false })
    await mkdir(join(root, 'templates', 'workflows'), { recursive: true })
    await writeFile(join(root, 'templates', 'workflows', 'demo.yaml'), TRACKED_WORKFLOW('locked-b', 'open'), 'utf8')
    for (const [id, invocable] of [['locked-b', false], ['open', true]] as const) {
      await mkdir(join(root, 'skills', id), { recursive: true })
      await writeFile(
        join(root, 'skills', id, 'SKILL.md'),
        ['---', `name: ${id}`, ...(invocable ? [] : ['disable-model-invocation: true']), '---', '', 'body', ''].join('\n'),
        'utf8',
      )
    }

    const scan = await scanMandatorySkillInvocability(root)

    expect(scan.kind === 'scanned' && scan.offenders.map((offender) => offender.token)).toEqual(['locked-a', 'locked-b'])
  })
})
