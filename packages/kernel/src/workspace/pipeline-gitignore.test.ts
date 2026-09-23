import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ensurePipelineGitignore, WORKFLOW_STATE_GITIGNORE } from './pipeline-gitignore.js'

describe('ensurePipelineGitignore', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pipeline-gitignore-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('creates .pipeline/.gitignore listing only local runtime state', async () => {
    await ensurePipelineGitignore(root)
    const content = await readFile(join(root, '.pipeline', '.gitignore'), 'utf8')
    expect(content).toBe(WORKFLOW_STATE_GITIGNORE)
    const entries = content.split('\n').filter((line) => line !== '' && !line.startsWith('#'))
    expect(entries).toEqual(['cache/', 'terminal-sessions/', 'codex-skill-receipts.jsonl'])
    // Shared configuration must stay tracked.
    for (const shared of ['workflows/', 'tracks.yaml', 'hooks.json', 'loops.yaml']) expect(entries).not.toContain(shared)
  })

  test('never overwrites an existing project-edited file', async () => {
    await mkdir(join(root, '.pipeline'))
    await writeFile(join(root, '.pipeline', '.gitignore'), 'custom\n')
    await ensurePipelineGitignore(root)
    expect(await readFile(join(root, '.pipeline', '.gitignore'), 'utf8')).toBe('custom\n')
  })

  test('refuses a .pipeline that is not a plain directory', async () => {
    await mkdir(join(root, 'elsewhere'))
    await symlink(join(root, 'elsewhere'), join(root, '.pipeline'))
    await expect(ensurePipelineGitignore(root)).rejects.toThrow('目录不是普通目录')
  })
})
