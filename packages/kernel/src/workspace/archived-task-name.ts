/**
 * 归档目录名 `<YYYY-MM-DD>-<任务名>[-N]`（见 archive-task.ts）与任务名的对应：依赖已结束判定（guard 的文件面、
 * AFK 队列的就绪扫描）共用这一处，不各写一份目录名匹配。
 */

const ARCHIVE_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/u
const SEQUENCE_SUFFIX = /^-\d+$/u

/**
 * 任务状态里没有再记一份任务名，所以只能按目录名认：日期前缀之后必须正好是任务名，或任务名加同日同名冲突追加的 `-N`；
 * 不能用 `endsWith`，它会把 `new-api` 当成 `api`。
 * `foo` 的第二份归档与名为 `foo-2` 的任务归档后目录名相同（`<日期>-foo-2`），目录名本身分不开：这里按「同一个任务」放行。
 * 调用方只在活跃目录里没有这个任务时才问归档，所以代价只限于「依赖名写错、又恰好等于另一个已归档任务名加序号」。
 * 任务名按字面比较，不拼进正则。
 */
export function archiveDirIsTask(dirName: string, task: string): boolean {
  const prefix = ARCHIVE_DATE_PREFIX.exec(dirName)
  if (task === '' || prefix === null) return false
  const named = dirName.slice(prefix[0].length)
  return named === task || (named.startsWith(task) && SEQUENCE_SUFFIX.test(named.slice(task.length)))
}
