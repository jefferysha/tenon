/**
 * 本机生成的文件加进本机忽略（`.git/info/exclude`），不碰项目根的 `.gitignore`（它不归 Tenon 改写）。
 *
 * 任务期间 Tenon 生成宿主子代理文件 `.claude/agents/tenon-*.md`，测试命令写 `test-results/`、`playwright-report/`：
 * 它们都在 `git status` 里显示为未跟踪（真机验收 F14 / 产品评估 P2）。`info/exclude` 是 git 自己的本机忽略面，
 * 不进版本库、不影响其他人；已被跟踪的文件不受忽略规则影响。幂等，尽力而为：不是 git 仓、读写失败都只是跳过。
 */
import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

const HEADER = '# Tenon: locally generated files (not committed)'

/** 任务期间生成的宿主子代理文件（回收时删除）。 */
export const HOST_AGENT_EXCLUDES: readonly string[] = ['.claude/agents/tenon-*.md', '.codex/agents/tenon-*.toml']
/** 测试命令的输出目录。 */
export const TEST_OUTPUT_EXCLUDES: readonly string[] = ['test-results/', 'playwright-report/']

function excludeFile(cwd: string): Promise<string | undefined> {
  return new Promise((done) => {
    execFile('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd, timeout: 5000 }, (error, stdout) => {
      const path = String(stdout).trim()
      done(error === null && path !== '' ? (isAbsolute(path) ? path : resolve(cwd, path)) : undefined)
    })
  })
}

export async function ensureLocalExcludes(cwd: string, patterns: readonly string[]): Promise<'added' | 'present' | 'skipped'> {
  try {
    const file = await excludeFile(cwd)
    if (file === undefined) return 'skipped'
    let current = ''
    try {
      current = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'skipped'
    }
    const have = new Set(current.split('\n').map((line) => line.trim()))
    const missing = patterns.filter((pattern) => !have.has(pattern))
    if (missing.length === 0) return 'present'
    const lead = current === '' || current.endsWith('\n') ? '' : '\n'
    const header = have.has(HEADER) ? '' : `${HEADER}\n`
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${lead}${header}${missing.join('\n')}\n`, 'utf8')
    return 'added'
  } catch {
    return 'skipped'
  }
}
