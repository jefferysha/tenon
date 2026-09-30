/**
 * 测试进程的 PATH 里要有「正在跑的这个 tenon」。
 *
 * 默认工作流的必需测试 `tenon test code-size --json` 是个 PATH 命令；用户自己的 CI 或没装启动器的机器上
 * PATH 解析不到 tenon，命令以 127 失败并挡住 Verify（真机验收 F17）。测试进程因此把运行中的 tenon 所在
 * 目录前置到 PATH：
 *   · 经稳定启动器（`~/.local/bin/tenon`）启动的（当前入口在受管 runtime 的发布目录里）：前置启动器目录，
 *     子进程解析到的就是同一个受管 runtime；
 *   · 直接 `node …/tenon.mjs` 跑的（开发检出、npx）：在本次运行的产物目录里写一个转发脚本，指向
 *     当前 Node 与当前入口。入口不是 tenon.mjs（vitest、被嵌入的调用）时什么都不加。
 * 转发脚本在 gitignored 的 `.tenon/users/<slug>/local/`，不进工作区指纹，也不进提交。
 */
import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative } from 'node:path'
import { stableLauncherPaths } from '../runtime/launchers.js'
import { resolveRuntimePaths } from '../runtime/paths.js'

export interface RunningTenonOptions {
  /** 本次运行的产物目录；需要转发脚本时写在它的 `bin/` 下。 */
  readonly runDir: string
  readonly home?: string
  readonly execPath?: string
  /** 当前 CLI 入口（缺省 process.argv[1]）。 */
  readonly entry?: string
  readonly platform?: NodeJS.Platform
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 当前入口是否在受管 runtime 的发布目录里（= 经稳定启动器 / bootstrap 启动的，而不是直接 node 跑的检出）。 */
function insideManagedRelease(entry: string | undefined, home: string, env: NodeJS.ProcessEnv): boolean {
  if (entry === undefined) return false
  try {
    const rel = relative(resolveRuntimePaths({ homeDir: home, env }).releasesRoot, entry)
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${'/'}`) && !isAbsolute(rel)
  } catch {
    return false
  }
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK)
    return isRegularFile(path)
  } catch {
    return false
  }
}

/** 运行中的 tenon 应当出现在 PATH 最前的目录；找不到可用的入口时是 undefined。 */
export async function runningTenonBinDir(
  env: NodeJS.ProcessEnv,
  options: RunningTenonOptions,
): Promise<string | undefined> {
  if ((options.platform ?? process.platform) === 'win32') return undefined
  const entry = options.entry ?? process.argv[1]
  const home = options.home ?? homedir()
  if (insideManagedRelease(entry, home, env)) {
    const launcher = stableLauncherPaths(home).tenon
    if (isExecutableFile(launcher)) return dirname(launcher)
  }
  if (entry === undefined || basename(entry) !== 'tenon.mjs' || !isRegularFile(entry)) return undefined
  const dir = join(options.runDir, 'bin')
  await mkdir(dir, { recursive: true })
  const shim = join(dir, 'tenon')
  await writeFile(shim, `#!/bin/sh\nexec ${shellQuote(options.execPath ?? process.execPath)} ${shellQuote(entry)} "$@"\n`, 'utf8')
  await chmod(shim, 0o755)
  return dir
}

/** 返回一份 PATH 最前是运行中 tenon 的环境副本；没有可前置的目录时原样返回。 */
export async function withRunningTenon(
  env: NodeJS.ProcessEnv,
  options: RunningTenonOptions,
): Promise<NodeJS.ProcessEnv> {
  const dir = await runningTenonBinDir(env, options)
  if (dir === undefined) return env
  const rest = (env.PATH ?? '').split(delimiter).filter((entry) => entry !== '' && entry !== dir)
  return { ...env, PATH: [dir, ...rest].join(delimiter) }
}
