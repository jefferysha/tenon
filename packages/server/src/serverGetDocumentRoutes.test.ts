import type { IncomingMessage } from 'node:http'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureWorkflowRootAnchor, closeWorkflowRootAnchor, type WorkflowRootAnchor } from './workflowRootAnchor.js'
import { DOCUMENT_READ_MAX_BYTES, isSafeDocumentPath, resolveDocumentReadRoute } from './serverGetDocumentRoutes.js'

const roots: string[] = []
const anchors: WorkflowRootAnchor[] = []

afterEach(async () => {
  for (const anchor of anchors.splice(0)) closeWorkflowRootAnchor(anchor)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<{ root: string; anchor: WorkflowRootAnchor }> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-doc-read-'))
  roots.push(root)
  const anchor = captureWorkflowRootAnchor(root)
  anchors.push(anchor)
  return { root, anchor }
}

function request(query: string): IncomingMessage {
  return { url: `/api/documents/read?${query}` } as IncomingMessage
}

function deps(anchor: WorkflowRootAnchor, registered: string) {
  return {
    workflowRootForRequest: (root: string) => root === registered
      ? { ok: true as const, anchor }
      : { ok: false as const, code: 404 as const, error: 'root 未登记' },
    errMsg: (error: unknown) => error instanceof Error ? error.message : String(error),
  }
}

describe('GET /api/documents/read', () => {
  it('非本路由返回 null，交给后续分发', async () => {
    const { root, anchor } = await makeRoot()
    expect(resolveDocumentReadRoute({ url: '/api/other' } as IncomingMessage, '/api/other', deps(anchor, root))).toBeNull()
  })

  it('读取已登记项目根内的 UTF-8 文本文件', async () => {
    const { root, anchor } = await makeRoot()
    await mkdir(join(root, 'openspec', 'changes', 'demo'), { recursive: true })
    await writeFile(join(root, 'openspec', 'changes', 'demo', 'proposal.md'), '# 提案\n\n正文', 'utf8')
    const result = resolveDocumentReadRoute(
      request(`root=${encodeURIComponent(root)}&path=${encodeURIComponent('openspec/changes/demo/proposal.md')}`),
      '/api/documents/read',
      deps(anchor, root),
    )
    expect(result?.status).toBe(200)
    expect(result?.body).toEqual({ ok: true, path: 'openspec/changes/demo/proposal.md', text: '# 提案\n\n正文', bytes: Buffer.byteLength('# 提案\n\n正文') })
  })

  it('缺失文件 404，路径逃逸 400，未登记 root 404', async () => {
    const { root, anchor } = await makeRoot()
    const missing = resolveDocumentReadRoute(request(`root=${encodeURIComponent(root)}&path=docs%2Fnope.md`), '/api/documents/read', deps(anchor, root))
    expect(missing?.status).toBe(404)
    for (const bad of ['../etc/passwd', '/etc/passwd', 'a//b.md', 'a\\b.md', '', 'docs/./x.md']) {
      expect(isSafeDocumentPath(bad)).toBe(false)
      const result = resolveDocumentReadRoute(request(`root=${encodeURIComponent(root)}&path=${encodeURIComponent(bad)}`), '/api/documents/read', deps(anchor, root))
      expect(result?.status).toBe(400)
    }
    const unknown = resolveDocumentReadRoute(request(`root=%2Fnot-registered&path=docs%2Fx.md`), '/api/documents/read', deps(anchor, root))
    expect(unknown?.status).toBe(404)
  })

  it('超过 256KB 的文件拒绝为 413，而不是截断返回', async () => {
    const { root, anchor } = await makeRoot()
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'huge.md'), 'x'.repeat(DOCUMENT_READ_MAX_BYTES + 1), 'utf8')
    const result = resolveDocumentReadRoute(request(`root=${encodeURIComponent(root)}&path=docs%2Fhuge.md`), '/api/documents/read', deps(anchor, root))
    expect(result?.status).toBe(413)
  })

  it('符号链接不跟随（403），不能借 root 内链接读到外部文件', async () => {
    const { root, anchor } = await makeRoot()
    const outside = await mkdtemp(join(tmpdir(), 'tenon-doc-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'secret.md'), 'secret', 'utf8')
    await mkdir(join(root, 'docs'), { recursive: true })
    await symlink(join(outside, 'secret.md'), join(root, 'docs', 'link.md'))
    const result = resolveDocumentReadRoute(request(`root=${encodeURIComponent(root)}&path=docs%2Flink.md`), '/api/documents/read', deps(anchor, root))
    expect(result?.status).toBe(403)
  })
})
