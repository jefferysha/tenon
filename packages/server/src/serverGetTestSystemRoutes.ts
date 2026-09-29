/**
 * 测试体系的只读路由（Dashboard 只展示，不登记、不执行）：
 *   GET /api/tests/catalog?root=                      项目目录（解析结果或问题清单）+ 已知失败 + 各套件最近结果
 *   GET /api/tests/baselines?root=&suite=             一个套件按机器画像的基线与历史
 *   GET /api/tests/plan?root=&change=                 任务测试计划状态（缺失 / 被改动 / 内容）
 *   GET /api/tests/records?root=&change=[&suite=]     任务的 v2 运行记录列表（新的在前，含链状态）
 *   GET /api/tests/record?root=&change=&user=&run=    一次运行的完整明细与产物文件索引
 * 产物字节仍走 `GET /api/tests/artifact`（serverGetTestRoutes.ts）：逐文件下载，路径限定在该次运行的产物目录内。
 * root 必须已登记；参数一律先校验再碰文件系统；失败带稳定的 code。
 */
import { SUITE_ID_RE, loadCatalogInput, TEST_RUN_ID_RE } from '@tenon/kernel'
import type { TestRouteDeps } from './serverGetTestRoutes.js'
import {
  MAX_RECORD_RUNS, catalogView, readKnownFailuresView, readPlanView, readRecordDetail, readRecordListing,
  readSuiteBaselines, readSuiteLatest,
} from './testSystemReads.js'

const CHANGE_RE = /^[A-Za-z0-9_-]{1,128}$/u
const SLUG_RE = /^[a-z0-9._-]*-at-[a-z0-9._-]*$/u

type Answer = { status: number; body: unknown }

function fail(status: number, code: string, error: string): Answer {
  return { status, body: { ok: false, error, code } }
}

export const TEST_SYSTEM_PATHS: readonly string[] = [
  '/api/tests/catalog', '/api/tests/baselines', '/api/tests/plan', '/api/tests/records', '/api/tests/record',
]

export async function resolveTestSystemRoute(
  url: string,
  path: string,
  deps: TestRouteDeps,
  now: () => number = Date.now,
): Promise<Answer | null> {
  if (!TEST_SYSTEM_PATHS.includes(path)) return null
  const query = new URL(url, 'http://localhost').searchParams
  const root = query.get('root') ?? ''
  if (root === '') return fail(400, 'invalid-params', '缺少 root 参数')
  const rootCheck = deps.workflowRootForRequest(root)
  if (!rootCheck.ok) return fail(rootCheck.code, rootCheck.code === 403 ? 'root-forbidden' : 'root-unregistered', rootCheck.error)
  const readRoot = rootCheck.anchor.fdPath ?? rootCheck.anchor.realPath
  try {
    if (path === '/api/tests/catalog') {
      const input = await loadCatalogInput(readRoot)
      const today = new Date(now()).toISOString().slice(0, 10)
      return {
        status: 200,
        body: {
          ok: true,
          catalog: catalogView(input),
          knownFailures: await readKnownFailuresView(readRoot, today),
          latest: input.state === 'ok' ? await readSuiteLatest(readRoot) : [],
        },
      }
    }
    if (path === '/api/tests/baselines') {
      const suite = query.get('suite') ?? ''
      if (!SUITE_ID_RE.test(suite)) return fail(400, 'invalid-params', 'suite 参数非法')
      return { status: 200, body: { ok: true, suite, ...await readSuiteBaselines(readRoot, suite) } }
    }
    const change = query.get('change') ?? ''
    if (!CHANGE_RE.test(change)) return fail(400, 'invalid-params', 'change 参数非法')
    if (path === '/api/tests/plan') return { status: 200, body: { ok: true, plan: await readPlanView(readRoot, change) } }
    if (path === '/api/tests/records') {
      const suite = query.get('suite')
      if (suite !== null && !SUITE_ID_RE.test(suite)) return fail(400, 'invalid-params', 'suite 参数非法')
      const listing = await readRecordListing(readRoot, change, suite ?? undefined)
      return { status: 200, body: { ok: true, limit: MAX_RECORD_RUNS, users: listing.users, runs: listing.runs } }
    }
    const user = query.get('user') ?? ''
    const run = query.get('run') ?? ''
    if (!SLUG_RE.test(user) || !TEST_RUN_ID_RE.test(run)) return fail(400, 'invalid-params', 'user 或 run 参数非法')
    const found = await readRecordDetail(readRoot, user, change, run)
    if (found.state === 'missing') return fail(404, 'record-not-found', '运行记录不存在')
    if (found.state === 'unreadable') return fail(422, 'record-unreadable', '运行记录损坏')
    return { status: 200, body: { ok: true, record: found.detail } }
  } catch (error) {
    return fail(500, 'read-failed', `读取测试数据失败（${error instanceof Error ? error.name : 'Error'}）`)
  }
}
