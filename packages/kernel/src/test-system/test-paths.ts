/**
 * 测试文件判定用的路径规则（纯函数）：控制目录过滤与源码扩展名。
 * 只用于「本任务改动里有没有测试文件」的判定；Tenon 自己写下的状态、归档与证据不是测试，数据 / 报告文件也不是。
 */

/** 控制目录：Tenon 的规格、状态与流水线产物所在，里面的文件永远不算测试改动。 */
export const TEST_CONTROL_DIRS = ['openspec', '.tenon', '.pipeline'] as const

/** 测试文件名规则只认这些源码扩展名；`.spec.report`、`.spec.json`、快照等证据格式不算测试文件。 */
export const TEST_SOURCE_EXTENSIONS = [
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'cs', 'swift',
  'scala', 'vue', 'svelte',
] as const

const CONTROL_DIRS: ReadonlySet<string> = new Set(TEST_CONTROL_DIRS)
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(TEST_SOURCE_EXTENSIONS)

/** 去掉首段在控制目录里的路径；保持输入顺序，不改动入参。路径为仓库相对、正斜杠。 */
export function withoutControlPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => !CONTROL_DIRS.has(path.split('/', 1)[0] ?? ''))
}

/** 文件名最后一段扩展名（小写、不含点）是否是源码扩展名；没有扩展名或点在开头的隐藏文件为 false。 */
export function hasTestSourceExtension(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return false
  return SOURCE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())
}
