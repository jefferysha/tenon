import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  BUILTIN_LIBRARIES, BUILTIN_LIBRARY_MARKER, builtinSourceDigest, parseBuiltinLibraryMarker, syncBuiltinLibraries, syncBuiltinLibrary,
  type BuiltinLibrary, type BuiltinSyncResult,
} from './builtin-library-sync.js'

const templates = BUILTIN_LIBRARIES[0] as BuiltinLibrary

/** 本套用例只喂模板库的源；其余内建库在这个 payload 下没有目录，按 id 取自己那一条结果。 */
const templateSync = async (): Promise<BuiltinSyncResult | undefined> =>
  (await syncBuiltinLibraries(payload, config)).find((result) => result.id === 'instruction-templates')

function blockText(id: string, extra = ''): string {
  return `---\nid: ${id}\ncategory: backend\ntitle: ${id}\n---\n## 后端（${id}）\n${extra}`
}

let payload: string
let config: string
let sandbox: string

function writeSource(rel: string, text: string): void {
  const path = join(payload, 'templates', 'instructions', 'builtin', ...rel.split('/'))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const builtinDir = () => join(config, 'templates', 'instructions', 'builtin')
const libraryDir = () => join(config, 'templates', 'instructions')

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tenon-builtin-sync-'))
  payload = join(sandbox, 'payload')
  config = join(sandbox, 'config')
  writeSource('backend/go.md', blockText('go'))
  writeSource('backend/rust-axum.md', blockText('rust-axum'))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('syncBuiltinLibraries', () => {
  test('首次同步复制整棵树并最后写入摘要标记', async () => {
    expect(await templateSync()).toEqual({ id: 'instruction-templates', state: 'updated' })
    expect(readFileSync(join(builtinDir(), 'backend', 'go.md'), 'utf8')).toBe(blockText('go'))
    const marker = parseBuiltinLibraryMarker(readFileSync(join(builtinDir(), BUILTIN_LIBRARY_MARKER), 'utf8'))
    expect(marker?.library).toBe('instruction-templates')
    expect(marker?.source_digest).toBe(builtinSourceDigest([
      { path: 'backend/go.md', bytes: Buffer.from(blockText('go')) },
      { path: 'backend/rust-axum.md', bytes: Buffer.from(blockText('rust-axum')) },
    ]))
    expect(readdirSync(libraryDir()).sort()).toEqual(['builtin'])
  })

  test('摘要相同 → unchanged，文件不重写', async () => {
    await syncBuiltinLibraries(payload, config)
    const before = statSync(join(builtinDir(), 'backend', 'go.md')).mtimeMs
    const markerBefore = readFileSync(join(builtinDir(), BUILTIN_LIBRARY_MARKER), 'utf8')
    expect(await templateSync()).toEqual({ id: 'instruction-templates', state: 'unchanged' })
    expect(statSync(join(builtinDir(), 'backend', 'go.md')).mtimeMs).toBe(before)
    expect(readFileSync(join(builtinDir(), BUILTIN_LIBRARY_MARKER), 'utf8')).toBe(markerBefore)
  })

  test('源变化 → 整份替换：删掉的文件消失，custom/ 字节不变', async () => {
    await syncBuiltinLibraries(payload, config)
    const custom = join(libraryDir(), 'custom', 'backend', 'mine.md')
    mkdirSync(dirname(custom), { recursive: true })
    writeFileSync(custom, blockText('mine'))
    rmSync(join(payload, 'templates', 'instructions', 'builtin', 'backend', 'rust-axum.md'))
    writeSource('backend/go.md', blockText('go', '\n- 新规则\n'))

    expect(await templateSync()).toEqual({ id: 'instruction-templates', state: 'updated' })
    expect(existsSync(join(builtinDir(), 'backend', 'rust-axum.md'))).toBe(false)
    expect(readFileSync(join(builtinDir(), 'backend', 'go.md'), 'utf8')).toContain('新规则')
    expect(readFileSync(custom, 'utf8')).toBe(blockText('mine'))
    expect(readdirSync(libraryDir()).sort()).toEqual(['builtin', 'custom'])
  })

  test('无效内建块 → failed，旧 builtin 保持原样', async () => {
    await syncBuiltinLibraries(payload, config)
    writeSource('backend/go.md', '---\nid: wrong\ncategory: backend\ntitle: go\n---\n## 后端\n')
    const result = await templateSync()
    expect(result?.state).toBe('failed')
    expect(result?.state === 'failed' && result.detail).toContain('backend/go.md')
    expect(readFileSync(join(builtinDir(), 'backend', 'go.md'), 'utf8')).toBe(blockText('go'))
  })

  test('payload 里的符号链接 → failed，旧 builtin 保持原样', async () => {
    await syncBuiltinLibraries(payload, config)
    const outside = join(sandbox, 'outside.md')
    writeFileSync(outside, blockText('evil'))
    symlinkSync(outside, join(payload, 'templates', 'instructions', 'builtin', 'backend', 'evil.md'))
    const result = await templateSync()
    expect(result).toEqual({ id: 'instruction-templates', state: 'failed', detail: 'backend/evil.md: 不允许符号链接' })
    expect(existsSync(join(builtinDir(), 'backend', 'evil.md'))).toBe(false)
  })

  test('源目录不存在 → failed，不创建任何目录', async () => {
    const [result] = await syncBuiltinLibraries(join(sandbox, 'empty-payload'), config)
    expect(result?.state).toBe('failed')
    expect(existsSync(config)).toBe(false)
  })

  test('残留的 staging / old 目录被清理', async () => {
    mkdirSync(join(libraryDir(), 'builtin.staging-1-abc', 'backend'), { recursive: true })
    mkdirSync(join(libraryDir(), 'builtin.old-def'), { recursive: true })
    await syncBuiltinLibraries(payload, config)
    expect(readdirSync(libraryDir()).sort()).toEqual(['builtin'])
  })

  test('与种类无关：任意库给出源、目标、扩展名和校验函数即可同步', async () => {
    const agents: BuiltinLibrary = {
      id: 'agents',
      source: 'templates/agents',
      target: 'agents/builtin',
      extensions: ['.md'],
      validate: (path, text) => (text.startsWith('---') ? [] : [`${path} 缺少 frontmatter`]),
    }
    mkdirSync(join(payload, 'templates', 'agents'), { recursive: true })
    writeFileSync(join(payload, 'templates', 'agents', 'builder.md'), '---\nname: builder\n---\n')
    writeFileSync(join(payload, 'templates', 'agents', 'notes.txt'), 'ignored')
    expect(await syncBuiltinLibrary(agents, payload, config)).toEqual({ id: 'agents', state: 'updated' })
    expect(readdirSync(join(config, 'agents', 'builtin')).sort()).toEqual([BUILTIN_LIBRARY_MARKER, 'builder.md'])
  })
})
