import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { probeGitFinish } from './gitWorkspace.js'

const LEDGERS = [
  '.pipeline-history.jsonl',
  '.pipeline-interactions.jsonl',
  '.pipeline-skill-confirmations.jsonl',
  '.pipeline-skill-invocations.jsonl',
]

let root = ''
afterEach(() => { if (root !== '') rmSync(root, { recursive: true, force: true }) })

function repoWithDeliveredChange(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tenon-git-probe-'))
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@x.test', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'ignore' })
  }
  git('init', '-q')
  const change = join(dir, 'openspec/changes/demo')
  mkdirSync(change, { recursive: true })
  for (const file of [...LEDGERS, '.pipeline.yaml']) writeFileSync(join(change, file), '{}\n')
  git('add', '-A')
  git('commit', '-qm', 'feat(demo): deliver')
  return dir
}

describe('probeGitFinish · 交付步收尾的「还要不要提交」', () => {
  // 真机第六轮：交付步收尾后用户回复「继续」，续轮本身追加了交互 / 技能调用 / 技能确认台账，
  // next 又要求一次同名的 update deliverables 提交，模型跳过它在脏工作区上流转。
  test('只有 hook 追加的台账变化时 stepDirty 为 false', async () => {
    root = repoWithDeliveredChange()
    for (const file of LEDGERS) appendFileSync(join(root, 'openspec/changes/demo', file), '{"x":1}\n')
    const probe = await probeGitFinish(root, 'demo')
    expect(probe?.stepDirty).toBe(false)
    expect(probe?.workspaceDirty).toBe(true)
  })

  test('状态文件变化（如 set pr_url 写下的）仍算未提交', async () => {
    root = repoWithDeliveredChange()
    writeFileSync(join(root, 'openspec/changes/demo/.pipeline.yaml'), 'pr_url: no-remote\n')
    expect((await probeGitFinish(root, 'demo'))?.stepDirty).toBe(true)
  })
})
