/**
 * 测试方向库：`GET /api/test-directions` 列出内建 + 自定义，`PUT/DELETE /api/test-directions/:id`
 * 只写 `custom/`。内建整份由 kernel 的内建库同步按摘要维护，这里永不写它，改内建 id 一律 409。
 * 方向只是创作模板：改它不影响任何已有工作流或在跑的任务，所以不需要引用扫描。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { atomicReplaceFile, parseTestDirection, type TestDirectionDef } from '@tenon/kernel'

export const TEST_DIRECTION_MAX_BYTES = 64 * 1024
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/u

export interface TestDirectionEntry {
  readonly id: string
  readonly label: string
  readonly source: 'builtin' | 'custom'
  readonly yaml: string
  readonly definition: TestDirectionDef
}

function directionsRoot(configRoot: string): string {
  return join(configRoot, 'test-directions')
}

async function readScope(configRoot: string, source: 'builtin' | 'custom'): Promise<TestDirectionEntry[]> {
  const dir = join(directionsRoot(configRoot), source)
  let names: string[]
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.yaml')).sort()
  } catch {
    return []
  }
  const entries: TestDirectionEntry[] = []
  for (const name of names) {
    try {
      const yaml = await readFile(join(dir, name), 'utf8')
      const definition = parseTestDirection(yaml)
      if (definition.id !== name.replace(/\.yaml$/u, '')) continue
      entries.push({ id: definition.id, label: definition.label, source, yaml, definition })
    } catch {
      // 损坏的方向文件不进列表：它不能当模板用，也不该让整个库读不出来。
    }
  }
  return entries
}

export async function listTestDirections(configRoot: string): Promise<readonly TestDirectionEntry[]> {
  return [...await readScope(configRoot, 'builtin'), ...await readScope(configRoot, 'custom')]
}

export interface TestDirectionRouteDeps {
  readonly configRoot: string
  readonly authorized: () => boolean
  readonly sendJson: (res: ServerResponse, code: number, body: unknown) => void
}

export async function handleTestDirectionGet(
  path: string,
  deps: Pick<TestDirectionRouteDeps, 'configRoot'>,
): Promise<{ status: number; body: unknown } | null> {
  if (path !== '/api/test-directions') return null
  try {
    return { status: 200, body: { ok: true, directions: await listTestDirections(deps.configRoot) } }
  } catch (error) {
    return { status: 500, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }
}

function idOf(path: string): string | null {
  const match = /^\/api\/test-directions\/([^/]+)$/u.exec(path)
  return match === null ? null : decodeURIComponent(match[1] ?? '')
}

async function isBuiltin(configRoot: string, id: string): Promise<boolean> {
  try {
    await readFile(join(directionsRoot(configRoot), 'builtin', `${id}.yaml`), 'utf8')
    return true
  } catch {
    return false
  }
}

export async function handleTestDirectionMutation(
  method: string,
  path: string,
  body: string,
  deps: TestDirectionRouteDeps,
): Promise<{ status: number; body: unknown } | null> {
  const id = idOf(path)
  if (id === null || (method !== 'PUT' && method !== 'DELETE')) return null
  if (!deps.authorized()) return { status: 401, body: { ok: false, error: '缺少写入凭证' } }
  if (!ID_RE.test(id)) return { status: 400, body: { ok: false, error: 'id 非法（仅允许 a-zA-Z0-9_-，≤64）' } }
  if (await isBuiltin(deps.configRoot, id)) {
    return { status: 409, body: { ok: false, error: `内建方向 '${id}' 只读；先复制成自定义再改` } }
  }
  const customDir = join(directionsRoot(deps.configRoot), 'custom')
  const target = join(customDir, `${id}.yaml`)
  if (method === 'DELETE') {
    try {
      await readFile(target, 'utf8')
    } catch {
      return { status: 404, body: { ok: false, error: `方向 '${id}' 不存在` } }
    }
    await rm(target, { force: true })
    return { status: 200, body: { ok: true } }
  }
  if (Buffer.byteLength(body, 'utf8') > TEST_DIRECTION_MAX_BYTES) {
    return { status: 400, body: { ok: false, error: `方向文件超过 ${TEST_DIRECTION_MAX_BYTES} 字节` } }
  }
  let definition: TestDirectionDef
  try {
    definition = parseTestDirection(body)
  } catch (error) {
    return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }
  if (definition.id !== id) {
    return { status: 400, body: { ok: false, error: `方向 id '${definition.id}' 与路径 '${id}' 不一致` } }
  }
  await mkdir(customDir, { recursive: true })
  await atomicReplaceFile(target, body.endsWith('\n') ? body : `${body}\n`)
  return { status: 200, body: { ok: true, direction: { id, label: definition.label, source: 'custom', yaml: body, definition } } }
}
