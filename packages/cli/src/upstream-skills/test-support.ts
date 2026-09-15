import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SetupEnv } from '../commands/setup.js'

/**
 * Local git fixtures for upstream skill tests. `https://github.com/<owner>/<name>.git` is redirected to
 * `<hub>/<owner>/<name>.git` through `GIT_CONFIG_COUNT` insteadOf keys on the injected runCommand only.
 */
export interface FixtureFile { readonly text: string; readonly executable?: boolean }
export interface FixtureHub {
  readonly root: string
  readonly hub: string
  readonly calls: string[][]
  readonly env: Pick<SetupEnv, 'runCommand'>
  commit(repo: string, files: Readonly<Record<string, string | FixtureFile | null>>, links?: Readonly<Record<string, string>>): string
  redirect(prefix: string, target: string): void
  cleanup(): void
}

function isolatedGitEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
  return {
    ...env,
    HOME: join(root, 'home'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'home', '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  }
}

export function createFixtureHub(): FixtureHub {
  const root = mkdtempSync(join(tmpdir(), 'tenon-upstream-skills-'))
  const hub = join(root, 'hub')
  mkdirSync(join(root, 'home'), { recursive: true })
  mkdirSync(hub, { recursive: true })
  const base = isolatedGitEnv(root)
  const redirects: [string, string][] = [[`url.file://${hub}/.insteadOf`, 'https://github.com/']]
  const calls: string[][] = []
  const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, env: base, encoding: 'utf8' }).trim()

  return {
    root,
    hub,
    calls,
    env: {
      runCommand: (cmd, args, options) => {
        calls.push([...args])
        const env: NodeJS.ProcessEnv = { ...base, GIT_CONFIG_COUNT: String(redirects.length) }
        redirects.forEach(([key, value], index) => {
          env[`GIT_CONFIG_KEY_${index}`] = key
          env[`GIT_CONFIG_VALUE_${index}`] = value
        })
        try {
          const stdout = execFileSync(cmd, args, {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env,
            ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
            ...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
          })
          return { code: 0, stdout, stderr: '' }
        } catch (error) {
          const failed = error as { status?: number | null; stdout?: string | null; stderr?: string | null }
          return { code: typeof failed.status === 'number' ? failed.status : 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? String(error) }
        }
      },
    },
    commit(repo, files, links = {}) {
      const dir = join(hub, `${repo}.git`)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
        git(dir, ['init', '-q', '-b', 'main'])
        git(dir, ['config', 'user.email', 'fixture@example.com'])
        git(dir, ['config', 'user.name', 'fixture'])
        git(dir, ['config', 'uploadpack.allowFilter', 'true'])
        git(dir, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])
      }
      for (const [path, content] of Object.entries(files)) {
        const target = join(dir, path)
        if (content === null) {
          rmSync(target, { recursive: true, force: true })
          continue
        }
        mkdirSync(dirname(target), { recursive: true })
        const file = typeof content === 'string' ? { text: content } : content
        writeFileSync(target, file.text, 'utf8')
        chmodSync(target, file.executable === true ? 0o755 : 0o644)
      }
      for (const [path, target] of Object.entries(links)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true })
        symlinkSync(target, join(dir, path))
      }
      git(dir, ['add', '-A'])
      git(dir, ['commit', '-q', '-m', `fixture ${Object.keys(files).join(' ')}`])
      return git(dir, ['rev-parse', 'HEAD'])
    },
    redirect(prefix, target) {
      redirects.push([`url.${target}.insteadOf`, prefix])
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Relative path → mode + bytes of every entry below `dir`, for byte-identical comparisons. */
export function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const visit = (current: string, rel: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name)
      const relPath = rel === '' ? name : `${rel}/${name}`
      const item = lstatSync(path)
      if (item.isDirectory()) {
        out[`${relPath}/`] = (item.mode & 0o777).toString(8)
        visit(path, relPath)
      } else {
        out[relPath] = `${(item.mode & 0o777).toString(8)}:${readFileSync(path, 'utf8')}`
      }
    }
  }
  if (existsSync(dir)) visit(dir, '')
  return out
}
