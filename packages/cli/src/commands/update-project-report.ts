import { isAbsolute, join } from 'node:path'
import { CODEX_AGENTS_BLOCK, refreshManagedBlock } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import type { SetupEnv } from './setup.js'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/**
 * 项目的 AGENTS.md 里有 Tenon 的 Codex 受管块。更新由旧版本进程执行，拿不到新版本的块文本去比对新旧，所以只看
 * 「有没有块」：有块的项目要 `tenon sync --migrate` 才会刷新它（report-only 的 `tenon sync` 只报告不改写）。
 */
function hasCodexManagedBlock(env: SetupEnv, root: string): boolean {
  try {
    const text = env.readText(join(root, 'AGENTS.md'))
    return text !== undefined && refreshManagedBlock(text, CODEX_AGENTS_BLOCK).status !== 'absent'
  } catch {
    return false
  }
}

/** Report workspace sync commands without mutating any registered project during a plugin update. */
export function reportRegisteredProjects(deps: CliDeps, env: SetupEnv, pluginVersion: string): void {
  let registry: string | undefined
  try {
    registry = env.readText(resolveRuntimePaths({
      homeDir: env.homeDir(),
      env: env.runtimeEnv(),
    }).registryPath)
  } catch {
    deps.io.err('[update] WARN: 项目注册表无法读取；未修改任何工作区。')
    return
  }
  if (registry === undefined) return
  let roots: unknown
  try {
    roots = JSON.parse(registry)
  } catch {
    deps.io.err('[update] WARN: 项目注册表无法解析；未修改任何工作区。')
    return
  }
  if (!Array.isArray(roots)) return
  const registeredRoots = [...new Set(
    roots.filter((root): root is string => typeof root === 'string' && isAbsolute(root)),
  )]
  const outdated = registeredRoots.filter((root) => {
    try {
      return env.readText(join(root, '.pipeline-version'))?.trim() !== pluginVersion
    } catch {
      return true
    }
  })
  if (outdated.length === 0) return
  deps.io.out(`[update] ${outdated.length} 个已登记项目需要显式同步（本次更新未写工作区）：`)
  for (const root of outdated) {
    deps.io.out(hasCodexManagedBlock(env, root)
      ? `  cd ${shellQuote(root)} && tenon sync --migrate  # 同时刷新 AGENTS.md 里的 Tenon Codex 受管块（块外内容不动）`
      : `  cd ${shellQuote(root)} && tenon sync`)
  }
}
