import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { probeGitFinish, WORKSPACE_COMMIT_PATHS } from './gitWorkspace.js'

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

describe('交付提交的范围（真机验收 F14）', () => {
  function stagedBy(dir: string): string[] {
    const run = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.email=t@x.test', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
    run('add', '-A', '--', ...WORKSPACE_COMMIT_PATHS)
    return run('diff', '--cached', '--name-only').split('\n').filter((line) => line !== '').sort()
  }

  test('本机生成的文件不进交付提交：所有权清单、测试输出目录、宿主 agent 文件；源码照常提交', () => {
    root = repoWithDeliveredChange()
    const put = (path: string, text = 'x\n'): void => {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    put('.pipeline-owned.json', '{}\n')
    put('.claude/agents/tenon-builder.md')
    put('test-results/unit.xml')
    put('packages/web/test-results/pw/shot.png')
    put('packages/web/playwright-report/index.html')
    put('coverage/lcov.info')
    put('src/cart.js', 'export {}\n')
    put('src/coverage/report.js', 'export {}\n')
    expect(stagedBy(root)).toEqual(['src/cart.js', 'src/coverage/report.js'])
  })

  test('门禁标记不进交付提交：单文件与按会话分文件的交互标记（含 hook 的原子写 / 认领临时文件）都被排除', () => {
    root = repoWithDeliveredChange()
    const put = (path: string, text = 'x\n'): void => {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    put('.pipeline-pending-confirm')
    put('.pipeline-pending-review')
    put('.pipeline-pending-interaction')
    put('.pipeline-pending-interaction.session-a-0001')
    put('.pipeline-pending-interaction.session-b-0002')
    put('.pipeline-pending-interaction.session-a-0001.tmp.4242')
    put('.pipeline-pending-interaction.claim.4242')
    put('src/cart.js', 'export {}\n')
    // 只排除项目根上的本机标记：别处同名前缀的文件与源码照常提交。
    put('docs/.pipeline-pending-interaction.session-c-0003')
    put('.pipeline-pending-interaction-notes.md')
    expect(stagedBy(root)).toEqual(['.pipeline-pending-interaction-notes.md', 'docs/.pipeline-pending-interaction.session-c-0003', 'src/cart.js'])
  })

  test('只剩门禁标记（含按会话分文件的）时工作区算干净', async () => {
    root = repoWithDeliveredChange()
    writeFileSync(join(root, '.pipeline-pending-interaction'), 'x\n')
    writeFileSync(join(root, '.pipeline-pending-interaction.session-a-0001'), 'x\n')
    const probe = await probeGitFinish(root, 'demo')
    expect(probe?.workspaceDirty).toBe(false)
    expect(probe?.deliverablesDirty).toBe(false)
    expect(probe?.stepDirty).toBe(false)
  })

  test('只剩这些本机文件时工作区算干净（不会发一条 nothing to commit 的提交）', async () => {
    root = repoWithDeliveredChange()
    writeFileSync(join(root, '.pipeline-owned.json'), '{}\n')
    mkdirSync(join(root, 'test-results'), { recursive: true })
    writeFileSync(join(root, 'test-results', 'unit.xml'), 'x\n')
    const probe = await probeGitFinish(root, 'demo')
    expect(probe?.workspaceDirty).toBe(false)
    expect(probe?.deliverablesDirty).toBe(false)
  })
})

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
