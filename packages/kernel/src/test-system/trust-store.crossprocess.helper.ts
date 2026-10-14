/**
 * trust-store.test.ts 的跨进程用例用的子进程：逐条往同一个用户级信任存储里追加条目。
 * 由测试经 vite-node 启动；不是产品代码，没有任何入口引用它。
 */
import { addTrustEntries } from './trust-store.js'

const [root, slug, fromRaw, countRaw] = process.argv.slice(2)
if (root === undefined || slug === undefined || fromRaw === undefined || countRaw === undefined) {
  throw new Error('trust-store cross-process helper arguments missing')
}
const from = Number(fromRaw)
const count = Number(countRaw)
if (!Number.isSafeInteger(from) || !Number.isSafeInteger(count) || from < 0 || count < 1) {
  throw new Error('trust-store cross-process helper arguments invalid')
}
for (let index = from; index < from + count; index++) {
  await addTrustEntries(root, slug, [{
    repo: '/work/repo/.git',
    digest: `sha256:${String(index).padStart(64, '0')}`,
    command: `c${index}`,
    by: 'a@x.io',
    at: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
  }])
}
