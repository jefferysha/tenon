import type { IncomingMessage } from 'node:http'
import { LedgerContextBundleError } from '@tenon/kernel'
import { ContextBundleTrustedFileError, readTrustedFile } from './contextBundleTrustedReader.js'
import type { WorkflowRootAnchor } from './workflowRootAnchor.js'

/** 单次读取上限：工作台只读治理文档 / 报告，超过即拒绝而不是截断（截断会让阅读者误以为文档到此为止）。 */
export const DOCUMENT_READ_MAX_BYTES = 256 * 1024

type WorkflowRootCheck =
  | { ok: true; anchor: WorkflowRootAnchor }
  | { ok: false; code: 403 | 404; error: string }

export interface DocumentReadRouteDeps {
  workflowRootForRequest: (root: string) => WorkflowRootCheck
  errMsg: (error: unknown) => string
}

export interface DocumentReadResponse {
  ok: true
  path: string
  text: string
  bytes: number
}

const SAFE_SEGMENT = /^[^/\\]+$/u

/** root 相对路径：非空、不以 / 开头、无反斜杠、无空段 / `.` / `..`。与 readTrustedFile 的 safeParts 同口径，先在路由层给 400。 */
export function isSafeDocumentPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false
  return path.split('/').every((segment) => SAFE_SEGMENT.test(segment) && segment !== '.' && segment !== '..')
}

/**
 * GET /api/documents/read?root=<registered root>&path=<root-relative file>
 * 工作台「文件阅读」的唯一数据源：只读、限定在已登记项目根内、O_NOFOLLOW + inode 校验（readTrustedFile）、
 * 256KB 上限、UTF-8 严格解码。任何写能力都不在这里。
 */
export function resolveDocumentReadRoute(
  req: IncomingMessage,
  path: string,
  deps: DocumentReadRouteDeps,
): { status: number; body: unknown } | null {
  if (path !== '/api/documents/read') return null
  const url = new URL(req.url ?? '/', 'http://localhost')
  const root = url.searchParams.get('root') ?? ''
  const relative = url.searchParams.get('path') ?? ''
  if (root === '') return { status: 400, body: { ok: false, error: '缺少 root 参数' } }
  if (!isSafeDocumentPath(relative)) return { status: 400, body: { ok: false, error: 'path 必须是项目根内的相对路径' } }
  const rootCheck = deps.workflowRootForRequest(root)
  if (!rootCheck.ok) return { status: rootCheck.code, body: { ok: false, error: rootCheck.error } }
  try {
    const { text, sourceBytes } = readTrustedFile(rootCheck.anchor, relative, DOCUMENT_READ_MAX_BYTES)
    const body: DocumentReadResponse = { ok: true, path: relative, text, bytes: sourceBytes }
    return { status: 200, body }
  } catch (error) {
    if (error instanceof LedgerContextBundleError) {
      if (error.code === 'CONTEXT_BUNDLE_DOCUMENT_MISSING') return { status: 404, body: { ok: false, error: '文件不存在', path: relative } }
      if (error.code === 'CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED') {
        return { status: 413, body: { ok: false, error: `文件超过 ${DOCUMENT_READ_MAX_BYTES} 字节上限`, path: relative } }
      }
      return { status: 422, body: { ok: false, error: deps.errMsg(error), path: relative } }
    }
    if (error instanceof ContextBundleTrustedFileError) {
      return { status: 403, body: { ok: false, error: '文件未通过可信校验（符号链接或非普通文件）', path: relative } }
    }
    return { status: 500, body: { ok: false, error: deps.errMsg(error) } }
  }
}
