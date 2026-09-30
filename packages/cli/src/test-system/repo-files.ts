/**
 * 仓库里的文件清单（仓库相对、正斜杠）：`tenon test register --auto` 用它找「没有任何套件认领的测试文件」。
 * 首选 git（`ls-files --cached --others --exclude-standard`，尊重 .gitignore）；不是 git 仓库或 git 跑不起来时
 * 退回目录遍历，跳过依赖、构建产物和测试输出目录。清单有上限，超出部分丢弃（--auto 只是帮忙登记，漏掉的仍由门禁挡）。
 */
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const GIT_TIMEOUT_MS = 20_000
const MAX_BUFFER = 64 * 1024 * 1024
const MAX_FILES = 200_000
const MAX_DIRS = 20_000

const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'test-results', 'playwright-report', '.tenon', 'openspec',
  '.pipeline', '.next', '.turbo', 'target', 'vendor', 'venv', '.venv', '__pycache__', '.cache', 'out', '.claude',
])

async function gitFiles(repoRoot: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: repoRoot, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER,
    })
    return stdout.split('\0').filter((entry) => entry !== '').slice(0, MAX_FILES)
  } catch {
    return undefined
  }
}

async function walkFiles(repoRoot: string): Promise<string[]> {
  const out: string[] = []
  let dirs = 0
  const walk = async (rel: string): Promise<void> => {
    if (dirs++ > MAX_DIRS || out.length >= MAX_FILES) return
    let entries
    try {
      entries = await readdir(rel === '' ? repoRoot : join(repoRoot, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) await walk(path)
      } else if (entry.isFile()) {
        out.push(path)
      }
    }
  }
  await walk('')
  return out
}

/** 已跟踪 + 未跟踪未忽略的文件；git 用不了时遍历目录。已跟踪但在工作区被删掉的文件仍会列出，调用方自己确认文件还在。 */
export async function listRepoFiles(repoRoot: string): Promise<readonly string[]> {
  return (await gitFiles(repoRoot)) ?? await walkFiles(repoRoot)
}
