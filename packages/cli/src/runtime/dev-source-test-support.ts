import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const roots: string[] = []

/** 测试的 afterEach 里调用：删掉本文件登记过的全部临时目录。 */
export function cleanupSourceRepoFixtures(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

export function trackFixtureRoot(root: string): string {
  roots.push(root)
  return root
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

/** 在 cwd 里跑 git（隔离用户的全局 git 配置），返回 stdout。 */
export function gitIn(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: GIT_ENV,
    ...(input === undefined ? {} : { input }),
  })
}

export function writeFixtureFile(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

/** 满足四项判据、有安装内容文件、有一个被忽略的上游技能与本机索引的最小源码仓库（返回 realpath）。 */
export function makeSourceRepo(options: { commit?: boolean } = {}): string {
  const root = trackFixtureRoot(realpathSync(mkdtempSync(join(tmpdir(), 'tenon-dev-source-'))))
  const write = (rel: string, text: string): void => writeFixtureFile(root, rel, text)
  write('package.json', JSON.stringify({ name: 'tenon', version: '0.3.2' }))
  write('.claude-plugin/marketplace.json', JSON.stringify({ name: 'tenon', plugins: [{ name: 'tenon', source: './' }] }))
  write('.claude-plugin/plugin.json', JSON.stringify({ name: 'tenon', version: '0.3.2' }))
  write('.codex-plugin/plugin.json', JSON.stringify({ name: 'tenon', version: '0.3.2' }))
  write('.agents/plugins/marketplace.json', '{}\n')
  write('skills/sources.yaml', 'version: 1\nskills: {}\n')
  write('skills/tenon/SKILL.md', 'tenon\n')
  write('runtime/tenon-bootstrap.mjs', '// bootstrap\n')
  write('hooks/gate.sh', '#!/usr/bin/env bash\n')
  write('templates/workflow.md', 'workflow\n')
  write('docs/readme.md', 'docs\n')
  write('.gitignore', '/skills/*\n!/skills/tenon/\n!/skills/sources.yaml\n')
  write('skills/ignored-skill/SKILL.md', 'ignored upstream skill\n')
  write('skills/skills.lock.json', '{"version":1}\n')
  gitIn(root, ['init', '-q', '-b', 'main'])
  gitIn(root, ['config', 'user.email', 'test@example.invalid'])
  gitIn(root, ['config', 'user.name', 'test'])
  if (options.commit !== false) {
    gitIn(root, ['add', '-A'])
    gitIn(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'])
  }
  return root
}
