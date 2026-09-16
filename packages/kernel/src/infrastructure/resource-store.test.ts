import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  ResourceStoreError, copyResource, deleteCustomResource, loadResourceCatalog, readResourceFile,
  resourceStoreRoot, writeCustomResource,
} from './resource-store.js'

function entry(id: string, name = id): string {
  return [
    'schema: tenon-resource/v1',
    `id: ${id}`,
    `name: ${name}`,
    'category: icons',
    'frameworks: [react]',
    'styling: []',
    'baseline: false',
    'license:',
    '  spdx: MIT',
    '  url: https://example.com/LICENSE',
    '  redistributable: true',
    '  attribution: false',
    '  commercial: free',
    'install: []',
    'skills: []',
    'links:',
    '  home: https://example.com',
    'verified_at: 2026-09-16',
    '',
  ].join('\n')
}

let sandbox: string
let payloadRoot: string
let configRoot: string
const options = (): { payloadRoot: string; configRoot: string } => ({ payloadRoot, configRoot })
const storeRoot = (): string => resourceStoreRoot(configRoot)

function writePayload(id: string, text = entry(id)): void {
  const path = join(payloadRoot, 'templates', 'resources', 'builtin', `${id}.yaml`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function writeCustomFile(id: string, text = entry(id)): void {
  const path = join(storeRoot(), 'custom', `${id}.yaml`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tenon-resource-store-'))
  payloadRoot = join(sandbox, 'payload')
  configRoot = join(sandbox, 'config')
  writePayload('lucide')
  writePayload('heroicons')
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('loadResourceCatalog', () => {
  test('first read syncs the payload and reports the ids', async () => {
    const catalog = await loadResourceCatalog(options())
    expect(catalog.sync).toEqual({ id: 'resources', state: 'updated' })
    expect(catalog.resources.map((item) => item.entry.id)).toEqual(['heroicons', 'lucide'])
    expect(catalog.resources.every((item) => item.source === 'builtin')).toBe(true)
    expect(catalog.errors).toEqual([])
  })

  test('a payload change resyncs builtin and leaves custom alone', async () => {
    await loadResourceCatalog(options())
    await writeCustomResource(storeRoot(), 'mine', entry('mine'))
    writePayload('lucide', entry('lucide', 'Lucide Icons'))
    const catalog = await loadResourceCatalog(options())
    expect(catalog.sync).toEqual({ id: 'resources', state: 'updated' })
    expect(catalog.resources.find((item) => item.entry.id === 'lucide')?.entry.name).toBe('Lucide Icons')
    expect(catalog.resources.find((item) => item.entry.id === 'mine')?.source).toBe('custom')
  })

  test('an unchanged payload does not rewrite builtin', async () => {
    await loadResourceCatalog(options())
    expect((await loadResourceCatalog(options())).sync).toEqual({ id: 'resources', state: 'unchanged' })
  })

  test('leftover staging directories are cleaned and builtin stays readable', async () => {
    await loadResourceCatalog(options())
    await writeCustomResource(storeRoot(), 'mine', entry('mine'))
    mkdirSync(join(storeRoot(), 'builtin.staging-999'), { recursive: true })
    writeFileSync(join(storeRoot(), 'builtin.staging-999', 'lucide.yaml'), 'broken')
    writePayload('tabler-icons')
    const catalog = await loadResourceCatalog(options())
    expect(catalog.resources.map((item) => item.entry.id)).toEqual(['heroicons', 'lucide', 'tabler-icons', 'mine'])
    expect(readdirSync(storeRoot()).sort()).toEqual(['builtin', 'custom'])
  })

  test('a broken custom file is reported and the rest still load', async () => {
    await loadResourceCatalog(options())
    writeCustomFile('broken', 'schema: tenon-resource/v1\nid: broken\n')
    const catalog = await loadResourceCatalog(options())
    expect(catalog.errors).toEqual([{ file: 'broken.yaml', source: 'custom', errors: ['第 1 行：缺字段 license'] }])
    expect(catalog.resources.map((item) => item.entry.id)).toEqual(['heroicons', 'lucide'])
  })

  test('a custom id that shadows a builtin id is reported and excluded', async () => {
    await loadResourceCatalog(options())
    writeCustomFile('lucide')
    const catalog = await loadResourceCatalog(options())
    expect(catalog.errors).toEqual([{ file: 'lucide.yaml', source: 'custom', errors: ['与内置资源 id 重复'] }])
    expect(catalog.resources.filter((item) => item.entry.id === 'lucide')).toHaveLength(1)
  })
})

describe('custom writes', () => {
  test('write, read back and delete with the revision', async () => {
    await loadResourceCatalog(options())
    const stored = await writeCustomResource(storeRoot(), 'mine', entry('mine'))
    expect(stored.revision).toMatch(/^sha256:[0-9a-f]{64}$/u)
    const file = await readResourceFile(storeRoot(), 'mine')
    expect(file?.yaml).toBe(entry('mine'))
    await deleteCustomResource(storeRoot(), 'mine', stored.revision)
    expect(await readResourceFile(storeRoot(), 'mine')).toBeNull()
  })

  test('builtin entries are read-only', async () => {
    await loadResourceCatalog(options())
    await expect(writeCustomResource(storeRoot(), 'lucide', entry('lucide'))).rejects.toMatchObject({ code: 'builtin-readonly' })
    await expect(deleteCustomResource(storeRoot(), 'lucide')).rejects.toMatchObject({ code: 'builtin-readonly' })
  })

  test('a stale revision conflicts and an invalid body never reaches disk', async () => {
    await loadResourceCatalog(options())
    await writeCustomResource(storeRoot(), 'mine', entry('mine'))
    await expect(writeCustomResource(storeRoot(), 'mine', entry('mine'), 'sha256:old'))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(writeCustomResource(storeRoot(), 'mine', 'schema: wrong\n'))
      .rejects.toBeInstanceOf(ResourceStoreError)
    expect(readFileSync(join(storeRoot(), 'custom', 'mine.yaml'), 'utf8')).toBe(entry('mine'))
  })

  test('deleting an unknown id is not-found', async () => {
    await loadResourceCatalog(options())
    await expect(deleteCustomResource(storeRoot(), 'nothing')).rejects.toMatchObject({ code: 'not-found' })
  })

  test('copy suffixes the id and keeps every field', async () => {
    await loadResourceCatalog(options())
    expect(await copyResource(storeRoot(), 'lucide')).toBe('lucide-copy')
    expect(await copyResource(storeRoot(), 'lucide')).toBe('lucide-copy-2')
    const copy = await readResourceFile(storeRoot(), 'lucide-copy')
    expect(copy?.stored.entry.id).toBe('lucide-copy')
    expect(copy?.stored.entry.category).toBe('icons')
    expect(copy?.stored.source).toBe('custom')
  })
})
