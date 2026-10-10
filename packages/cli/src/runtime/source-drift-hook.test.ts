import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { checkTenonSourceRepo, computeDevSourceIdentity, DEV_PAYLOAD_PATHSPECS } from './dev-source-identity.js'
import { cleanupSourceRepoFixtures, gitIn, makeSourceRepo, writeFixtureFile } from './dev-source-test-support.js'

afterEach(cleanupSourceRepoFixtures)

const hook = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'hooks', 'source-drift.sh')

/** source 钩子文件后调用其中一个函数；参数以位置参数传入，免去引号转义。 */
function bashFunction(fn: string, ...args: string[]): string {
  const result = spawnSync('bash', ['-c', `. "$1"; shift; ${fn} "$@"`, 'bash', hook, ...args], { encoding: 'utf8' })
  return result.stdout.trim()
}

describe('hooks/source-drift.sh stays in lock step with the Node identity', () => {
  test('it enumerates exactly the managed payload entries', () => {
    const block = /PIPELINE_SOURCE_DRIFT_PATHSPECS=\(\n([\s\S]*?)\n\)/u.exec(readFileSync(hook, 'utf8'))
    expect(block).not.toBeNull()
    const listed = (block?.[1] ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
    expect(listed).toEqual([...DEV_PAYLOAD_PATHSPECS])
  })

  test('bash and Node compute identical digests through edits, new files, staging, commits and deletions', () => {
    const root = makeSourceRepo()
    const compare = (label: string): void => {
      const node = computeDevSourceIdentity(root)
      expect({ label, worktree: bashFunction('pipeline_source_worktree_digest', root) })
        .toEqual({ label, worktree: node.worktreeDigest })
      expect({ label, skills: bashFunction('pipeline_source_skills_digest', root) })
        .toEqual({ label, skills: node.skillsIndexDigest })
    }
    compare('clean')
    appendFileSync(join(root, 'hooks', 'gate.sh'), '# edit\n')
    compare('edited')
    writeFixtureFile(root, 'templates/new.md', 'new\n')
    compare('untracked file')
    gitIn(root, ['add', '-A'])
    compare('staged')
    gitIn(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'more'])
    compare('committed')
    rmSync(join(root, 'hooks', 'gate.sh'))
    compare('deleted tracked file')
    appendFileSync(join(root, 'skills', 'skills.lock.json'), '\n')
    appendFileSync(join(root, 'skills', 'ignored-skill', 'SKILL.md'), 'x\n')
    appendFileSync(join(root, 'docs', 'readme.md'), 'x\n')
    compare('changes outside the digest scope')
    rmSync(join(root, 'skills', 'skills.lock.json'))
    compare('index removed')
  })

  test('bash and Node agree on the four source-repository criteria', () => {
    const damages: Array<[string, (root: string) => void]> = [
      ['intact', () => undefined],
      ['package name', (root) => writeFixtureFile(root, 'package.json', JSON.stringify({ name: 'other' }))],
      ['marketplace name', (root) => writeFixtureFile(root, '.claude-plugin/marketplace.json',
        JSON.stringify({ name: 'other', plugins: [{ name: 'tenon', source: './' }] }))],
      ['plugin source', (root) => writeFixtureFile(root, '.claude-plugin/marketplace.json',
        JSON.stringify({ name: 'tenon', plugins: [{ name: 'tenon', source: './sub' }] }))],
      ['sources.yaml', (root) => rmSync(join(root, 'skills', 'sources.yaml'))],
      ['bootstrap', (root) => rmSync(join(root, 'runtime', 'tenon-bootstrap.mjs'))],
    ]
    for (const [label, damage] of damages) {
      const root = makeSourceRepo({ commit: false })
      damage(root)
      const bash = spawnSync('bash', ['-c', '. "$1"; pipeline_source_is_tenon_repo "$2"', 'bash', hook, root]).status === 0
      expect({ label, bash }).toEqual({ label, bash: checkTenonSourceRepo(root).ok })
    }
  })
})
