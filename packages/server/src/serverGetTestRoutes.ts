/**
 * 工作台读测试记录与产物：`GET /api/tests/runs|run|artifact`。全部 loopback 只读，root 必须已登记。
 *
 * 产物是原始字节（trace zip、截图、报告），所以这条路由直接写 res：按扩展名白名单给 content-type，
 * 一律带 nosniff 与 `CSP: sandbox`，zip 作为附件下载；打开前 lstat 必须是普通文件，realpath 必须仍在
 * 该 run 的产物目录内，O_NOFOLLOW 打开，超过上限给 413。HTML 报告永不在 Dashboard 源里渲染。
 */
import { createReadStream } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, relative, sep } from 'node:path'
import {
  listTestRuns, readTestRunRecord, testEvidencePaths, testRunArtifactsDir, TEST_RUN_ID_RE,
} from '@tenon/kernel'
import type { WorkflowRootAnchor } from './workflowRootAnchor.js'
import { handleTestDirectionGet } from './serverTestDirectionRoutes.js'

const CHANGE_RE = /^[A-Za-z0-9_-]+$/u
const IDENT_RE = /^[A-Za-z0-9_-]{1,64}$/u
const SLUG_RE = /^[a-z0-9._-]{1,128}$/u
const MAX_RUNS = 50
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_TAIL = 1024 * 1024

type WorkflowRootCheck =
  | { ok: true; anchor: WorkflowRootAnchor }
  | { ok: false; code: 403 | 404; error: string }

export interface TestRouteDeps {
  workflowRootForRequest: (root: string) => WorkflowRootCheck
  sendJson: (res: ServerResponse, code: number, body: unknown) => void
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
  '.json': 'application/json',
}

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.')
  const extension = dot < 0 ? '' : path.slice(dot).toLowerCase()
  return CONTENT_TYPES[extension] ?? 'text/plain; charset=utf-8'
}

function isSafeArtifactPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

interface Params {
  readonly root: string
  readonly change: string
  readonly user: string
  readonly run: string
  readonly test: string
  readonly path: string
  readonly tail: string
}

function params(url: string): Params {
  const query = new URL(url, 'http://localhost').searchParams
  return {
    root: query.get('root') ?? '',
    change: query.get('change') ?? '',
    user: query.get('user') ?? '',
    run: query.get('run') ?? '',
    test: query.get('test') ?? '',
    path: query.get('path') ?? '',
    tail: query.get('tail') ?? '',
  }
}

async function artifactsPresent(readRoot: string, slug: string, change: string, runId: string): Promise<boolean> {
  try {
    return (await lstat(testRunArtifactsDir(readRoot, slug, change, runId))).isDirectory()
  } catch {
    return false
  }
}

export async function resolveTestRunsRoute(
  url: string,
  path: string,
  deps: TestRouteDeps,
): Promise<{ status: number; body: unknown } | null> {
  if (path !== '/api/tests/runs' && path !== '/api/tests/run') return null
  const query = params(url)
  if (query.root === '' || !CHANGE_RE.test(query.change)) {
    return { status: 400, body: { ok: false, error: '缺少 root 或 change 参数' } }
  }
  const rootCheck = deps.workflowRootForRequest(query.root)
  if (!rootCheck.ok) return { status: rootCheck.code, body: { ok: false, error: rootCheck.error } }
  const readRoot = rootCheck.anchor.fdPath ?? rootCheck.anchor.realPath
  if (path === '/api/tests/runs') {
    if (!IDENT_RE.test(query.test)) return { status: 400, body: { ok: false, error: 'test 参数非法' } }
    const runs = await listTestRuns(readRoot, query.change, { testId: query.test })
    const newestFirst = [...runs].reverse().slice(0, MAX_RUNS)
    return {
      status: 200,
      body: {
        ok: true,
        runs: await Promise.all(newestFirst.map(async (entry) => ({
          user: entry.slug,
          runId: entry.record.run_id,
          result: entry.record.result,
          exitCode: entry.record.exit_code,
          durationMs: entry.record.duration_ms,
          finishedAt: entry.record.finished_at,
          actor: { id: entry.record.actor.id, name: entry.record.actor.name },
          reasons: entry.record.reasons.map((reason) => reason.code),
          artifacts: await artifactsPresent(readRoot, entry.slug, query.change, entry.record.run_id),
        }))),
      },
    }
  }
  if (!SLUG_RE.test(query.user) || !TEST_RUN_ID_RE.test(query.run)) {
    return { status: 400, body: { ok: false, error: 'user 或 run 参数非法' } }
  }
  const recordPath = join(testEvidencePaths(readRoot, query.user, query.change).runsDir, `${query.run}.json`)
  let exists = false
  try {
    exists = (await lstat(recordPath)).isFile()
  } catch {
    exists = false
  }
  if (!exists) return { status: 404, body: { ok: false, error: '运行记录不存在' } }
  const record = await readTestRunRecord(recordPath)
  if (record === undefined) return { status: 422, body: { ok: false, error: '运行记录损坏' } }
  const runDir = testRunArtifactsDir(readRoot, query.user, query.change, query.run)
  const files: string[] = []
  for (const output of record.outputs) {
    if (output.artifact === null) continue
    try {
      await lstat(join(runDir, ...output.artifact.split('/')))
      files.push(output.artifact)
    } catch {
      // 本机产物可能已被保留策略清掉；缺席就不列。
    }
  }
  const log = await lstat(join(runDir, record.log.artifact)).then(() => true, () => false)
  return { status: 200, body: { ok: true, record, artifacts: { log, files } } }
}

/** 三条测试读路由的统一入口：JSON 两条 + 原始字节一条；返回 true 表示已处理。 */
export async function handleTestGetRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: TestRouteDeps & { readonly configRoot: string },
): Promise<boolean> {
  const runs = await resolveTestRunsRoute(req.url ?? '/', path, deps)
  if (runs !== null) {
    deps.sendJson(res, runs.status, runs.body)
    return true
  }
  if (await handleTestArtifactRoute(req, res, path, deps)) return true
  const directions = await handleTestDirectionGet(path, { configRoot: deps.configRoot })
  if (directions !== null) {
    deps.sendJson(res, directions.status, directions.body)
    return true
  }
  return false
}

/** 直接写 res 的原始字节路由；返回 true 表示已处理。 */
export async function handleTestArtifactRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: TestRouteDeps,
): Promise<boolean> {
  if (path !== '/api/tests/artifact') return false
  const query = params(req.url ?? '/')
  if (query.root === '' || !CHANGE_RE.test(query.change) || !SLUG_RE.test(query.user)
    || !TEST_RUN_ID_RE.test(query.run) || !isSafeArtifactPath(query.path)) {
    deps.sendJson(res, 400, { ok: false, error: '参数非法' })
    return true
  }
  const tail = query.tail === '' ? undefined : Number(query.tail)
  if (tail !== undefined && (!Number.isInteger(tail) || tail < 1 || tail > MAX_TAIL)) {
    deps.sendJson(res, 400, { ok: false, error: 'tail 超出范围 1–1048576' })
    return true
  }
  const rootCheck = deps.workflowRootForRequest(query.root)
  if (!rootCheck.ok) {
    deps.sendJson(res, rootCheck.code, { ok: false, error: rootCheck.error })
    return true
  }
  const readRoot = rootCheck.anchor.fdPath ?? rootCheck.anchor.realPath
  const runDir = testRunArtifactsDir(readRoot, query.user, query.change, query.run)
  const target = join(runDir, ...query.path.split('/'))
  let size = 0
  try {
    const entry = await lstat(target)
    if (entry.isSymbolicLink() || !entry.isFile()) {
      deps.sendJson(res, 403, { ok: false, error: '产物必须是普通文件' })
      return true
    }
    const contained = relative(await realpath(runDir), await realpath(target))
    if (contained.startsWith('..') || contained.startsWith(sep)) {
      deps.sendJson(res, 403, { ok: false, error: '产物路径逃出运行目录' })
      return true
    }
    size = entry.size
  } catch {
    deps.sendJson(res, 404, { ok: false, error: '产物不存在' })
    return true
  }
  if (size > MAX_ARTIFACT_BYTES && tail === undefined) {
    deps.sendJson(res, 413, { ok: false, error: `产物超过 ${MAX_ARTIFACT_BYTES} 字节上限` })
    return true
  }
  const start = tail === undefined ? 0 : Math.max(0, size - tail)
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  res.writeHead(200, {
    'Content-Type': contentTypeFor(query.path),
    'Content-Length': String(size - start),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    ...(contentTypeFor(query.path) === 'application/zip'
      ? { 'Content-Disposition': 'attachment' }
      : {}),
  })
  await new Promise<void>((resolve) => {
    const stream = createReadStream('', { fd: handle.fd, start, autoClose: false })
    stream.on('end', () => resolve())
    stream.on('error', () => resolve())
    stream.pipe(res)
  })
  await handle.close()
  res.end()
  return true
}
