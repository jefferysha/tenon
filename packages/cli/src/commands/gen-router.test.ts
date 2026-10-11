import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CliDeps } from '../deps.js'
import { cmdGenRouterSh } from './gen-router.js'

const STEPS = `steps:
  - id: open
    label: 开始
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

function workflow(name: string, route: string): string {
  return `name: ${name}\nroute: ${route}\n${STEPS}`
}

function deps(root: string, out: string[], err: string[]): CliDeps {
  return {
    cwd: root,
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
  } as unknown as CliDeps
}

type Run = (deps: CliDeps, manifestPath: string | undefined, repoRoot: string | undefined) => Promise<number>
const run = cmdGenRouterSh as unknown as Run

describe('_gen-router-sh project data-cache command', () => {
  let base: string
  let root: string
  let manifest: string
  let globalDir: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'pipeline-gen-router-'))
    root = join(base, 'repo')
    manifest = join(base, 'plugin', 'templates', 'manifest.yaml')
    globalDir = join(base, 'home', 'config', 'workflows', '.pipeline', 'workflows')
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await mkdir(join(base, 'plugin', 'templates', 'workflows'), { recursive: true })
    await mkdir(globalDir, { recursive: true })
    vi.stubEnv('TENON_RUNTIME_HOME', join(base, 'home')) // 测试进程已隔离运行时根；这里只是把全局存储指到本用例的目录
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(base, { recursive: true, force: true })
  })

  test('emits router.v6 from the workflow files with canonical identity, source digest and inert hex data', async () => {
    const hostile = "'$(touch /tmp/router-owned)`printf pwn`|mobile-route-token"
    const project = workflow('catalog-flow', `{ keywords: [${hostile.replace(/[,[\]{}]/gu, ' ')}], exclude: [迁移], priority: 901 }`)
    await writeFile(join(root, '.pipeline', 'workflows', 'catalog-flow.yaml'), project, 'utf8')
    const out: string[] = []
    const err: string[] = []

    const code = await run(deps(root, out, err), manifest, root)
    expect(err).toEqual([])
    expect(code).toBe(0)
    expect(out).toHaveLength(1)

    const cache = `${out[0]}\n`
    const lines = cache.trimEnd().split('\n')
    expect(lines[0]).toBe('TENON_ROUTER_V6')
    const digest = createHash('sha256').update(`project/catalog-flow.yaml\n${project}\n`).digest('hex')
    expect(lines[1]?.split('|')).toEqual(['M', Buffer.from(await realpath(root), 'utf8').toString('hex'), digest])
    const row = lines[2]?.split('|') ?? []
    const decoded = row.map((field) => Buffer.from(field, 'hex').toString('utf8'))
    expect(decoded[3]).toBe('catalog-flow')
    expect(decoded[4]).toBe('catalog-flow')
    expect(row.slice(6, 9)).toEqual(['1', '0', '0'])
    expect(decoded[9]).toContain('mobile-route-token')
    expect(decoded[10]).toBe('(迁移)')
    expect(cache).not.toContain('$(')
    expect(cache).not.toContain('`')
    expect(cache).not.toContain('/tmp/router-owned')
  })

  test('reads the global store and plugin templates beside the manifest, and reports a broken workflow without failing', async () => {
    await writeFile(join(globalDir, 'extra.yaml'), workflow('extra', '{ keywords: [额外], priority: 5 }'), 'utf8')
    await writeFile(join(base, 'plugin', 'templates', 'workflows', 'tmpl.yaml'), workflow('tmpl', '{ keywords: [模板], priority: 6 }'), 'utf8')
    await writeFile(join(root, '.pipeline', 'workflows', 'broken.yaml'), 'name: broken\n???\n', 'utf8')
    const out: string[] = []
    const err: string[] = []

    expect(await run(deps(root, out, err), manifest, root)).toBe(0)

    const rows = (out[0] ?? '').split('\n').filter((line) => line.startsWith('R|'))
      .map((line) => Buffer.from(line.split('|')[3] ?? '', 'hex').toString('utf8'))
    expect(rows).toEqual(['extra', 'tmpl'])
    expect(err).toHaveLength(1)
    expect(err[0]).toMatch(/broken/u)
  })

  test('requires a manifest path and a repo root instead of silently generating a project-agnostic cache', async () => {
    const out: string[] = []
    const err: string[] = []
    expect(await run(deps(root, out, err), manifest, undefined)).toBe(2)
    expect(err.join('\n')).toMatch(/项目根|repo root/u)
    expect(await run(deps(root, out, err), undefined, root)).toBe(2)
    expect(err.join('\n')).toMatch(/manifest/u)
    expect(out).toEqual([])
  })

  test('refuses a repo root that differs from the CLI working context', async () => {
    const other = join(base, 'other')
    await mkdir(other, { recursive: true })
    const out: string[] = []
    const err: string[] = []
    expect(await run(deps(root, out, err), manifest, other)).toBe(2)
    expect(out).toEqual([])
    expect(err.join('\n')).toMatch(/不一致/u)
  })
})
