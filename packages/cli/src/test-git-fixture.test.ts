import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { FIXTURE_DATE, putFile, runGit } from './test-git-fixture.js'

describe('test git fixture helpers', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'git-fixture-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  test('putFile creates missing parent directories and defaults to an empty body', async () => {
    await putFile(cwd, 'a/b/c.txt')
    await putFile(cwd, 'a/b/d.txt', 'hello\n')

    expect(await readFile(join(cwd, 'a', 'b', 'c.txt'), 'utf8')).toBe('')
    expect(await readFile(join(cwd, 'a', 'b', 'd.txt'), 'utf8')).toBe('hello\n')
  })

  test('putFile overwrites an existing file', async () => {
    await putFile(cwd, 'x.txt', 'one')
    await putFile(cwd, 'x.txt', 'two')

    expect(await readFile(join(cwd, 'x.txt'), 'utf8')).toBe('two')
  })

  test('runGit reports a failing command with its status and the git message', () => {
    const result = runGit(cwd, ['rev-parse', '--verify', 'HEAD'])

    expect(result.status).not.toBe(0)
    expect(result.output).not.toBe('')
  })

  test('runGit commits with the fixture identity and stamps the given date on author and committer', async () => {
    expect(runGit(cwd, ['init', '-q']).status).toBe(0)
    await putFile(cwd, 'f.txt', 'x')
    expect(runGit(cwd, ['add', '-A']).status).toBe(0)
    expect(runGit(cwd, ['commit', '-q', '-m', 'fixture'], FIXTURE_DATE).status).toBe(0)

    const log = runGit(cwd, ['log', '-1', '--format=%an <%ae>|%at|%ct'])

    expect(log.status).toBe(0)
    const seconds = Date.parse(FIXTURE_DATE) / 1000
    expect(log.output.trim()).toBe(`runner <runner@example.com>|${seconds}|${seconds}`)
  })

  test('runGit without a date leaves the commit clock alone', async () => {
    expect(runGit(cwd, ['init', '-q']).status).toBe(0)
    await putFile(cwd, 'f.txt', 'x')
    expect(runGit(cwd, ['add', '-A']).status).toBe(0)
    const before = Math.floor(Date.now() / 1000)
    expect(runGit(cwd, ['commit', '-q', '-m', 'now']).status).toBe(0)

    const stamp = runGit(cwd, ['log', '-1', '--format=%at'])

    expect(Number(stamp.output.trim())).toBeGreaterThanOrEqual(before)
  })
})
