/**
 * router-gen.mjs <manifest> <repo-root>
 *
 * router.sh 的安装态冷生成 fallback。与 CLI `_gen-router-sh` 一样，调用 kernel `generateRouterCache`：
 * 读「项目 → 全局存储 → 插件模板」三处的工作流文件，把每条带 `route` 的分支编码成 `TENON_ROUTER_V6`。
 * `<manifest>` 只用来定位插件的 `templates/` 目录。这里绝不生成 shell assignment；项目可写 cache 永远
 * 只是 hex 编码的数据。被跳过的坏工作流在 stderr 各留一行，不影响退出码。
 */
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'

async function loadKernel() {
  const candidates = [
    new URL('../packages/kernel/dist/index.js', import.meta.url).href,
    '@tenon/kernel',
  ]
  let lastError
  for (const specifier of candidates) {
    try {
      return await import(specifier)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('kernel 不可解析')
}

async function main() {
  const manifestPath = process.argv[2]
  const repoRoot = process.argv[3]
  if (!manifestPath || !repoRoot) {
    process.stderr.write('router-gen: 用法 router-gen.mjs <manifest> <repo-root>\n')
    process.exitCode = 2
    return
  }

  const canonicalRoot = realpathSync(repoRoot)
  const kernel = await loadKernel()
  const result = kernel.generateRouterCache({
    repoRoot: canonicalRoot,
    templatesRoot: dirname(manifestPath),
    projectRoot: canonicalRoot,
  })
  for (const warning of result.warnings) process.stderr.write(`router-gen: ${warning}\n`)
  process.stdout.write(result.text)
}

main().catch((error) => {
  process.stderr.write(`router-gen: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
