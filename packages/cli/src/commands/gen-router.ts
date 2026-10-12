/**
 * `_gen-router-sh <manifest> <repo-root>` —— router.sh 的项目感知冷生成命令。
 *
 * 输出不是 shell 程序，而是 `TENON_ROUTER_V6` data-only cache：路由数据来自「项目 → 全局存储 → 插件模板」
 * 三处工作流文件里每条带 `route` 的分支（见 kernel `generateRouterCache`）。`manifest` 只用来定位插件的
 * `templates/` 目录（其下 `workflows/` 是随插件发布的模板），不再读它的内容；这个参数位置保持不变，
 * 老的调用方式因此继续可用。所有自由字符串由 kernel encoder 以 UTF-8 hex 写出，项目 cache 不可 source/eval。
 * 被跳过的坏工作流在 stderr 各留一行，不影响退出码。
 */
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { generateRouterCache } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'

export async function cmdGenRouterSh(
  deps: CliDeps,
  manifestPath: string | undefined,
  repoRoot?: string,
): Promise<number> {
  if (!manifestPath) {
    deps.io.err('_gen-router-sh: 缺 manifest 路径参数')
    return 2
  }
  if (!repoRoot) {
    deps.io.err('_gen-router-sh: 缺项目根（repo root）参数')
    return 2
  }

  try {
    const canonicalRoot = realpathSync(repoRoot)
    const depsRoot = realpathSync(deps.cwd)
    if (canonicalRoot !== depsRoot) {
      throw new Error(`项目根与 CLI 工作上下文不一致：${canonicalRoot} != ${depsRoot}`)
    }

    const result = generateRouterCache({
      repoRoot: canonicalRoot,
      templatesRoot: dirname(manifestPath),
      projectRoot: canonicalRoot,
    })
    for (const warning of result.warnings) deps.io.err(`_gen-router-sh: ${warning}`)
    // CliIO.out 自己补一个换行；剥掉 encoder 的最后一个换行，真实 stdout 与 mjs 逐字一致。
    deps.io.out(result.text.slice(0, -1))
    return 0
  } catch (e) {
    deps.io.err(`_gen-router-sh: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
}
