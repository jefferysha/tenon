import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { workflowsDirUnder } from '../workflow/global-store.js'
import { collectRouterSources, generateRouterCache, MAX_SOURCE_BYTES } from './router-sources.js'
import { routerSourceDigest } from './router-table.js'

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

const flat = (name: string, route = ''): string => `name: ${name}\n${route === '' ? '' : `${route}\n`}${STEPS}`
const routed = (name: string, keyword: string, priority = 100): string =>
  flat(name, `route: { keywords: [${keyword}], priority: ${priority} }`)

let base: string
let repo: string
let templates: string
let runtimeHome: string
let globalDir: string
const request = (): { repoRoot: string; templatesRoot: string; product: { env: Record<string, string> } } => ({
  repoRoot: repo, templatesRoot: templates, product: { env: { TENON_RUNTIME_HOME: runtimeHome } },
})

function put(dir: string, file: string, content: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), content)
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'router-sources-'))
  repo = join(base, 'repo')
  templates = join(base, 'plugin', 'templates')
  runtimeHome = join(base, 'home')
  mkdirSync(repo, { recursive: true })
  globalDir = workflowsDirUnder(join(runtimeHome, 'config', 'workflows'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('collectRouterSources', () => {
  it('按「项目、全局、模板」的范围顺序、范围内按文件名字节序给出，并带出内建标记', () => {
    put(workflowsDirUnder(repo), 'zeta.yaml', routed('zeta', 'z'))
    put(workflowsDirUnder(repo), 'alpha.yaml', routed('alpha', 'a'))
    put(globalDir, 'catalog.yaml', routed('catalog', 'c'))
    put(join(templates, 'workflows'), 'design-system.yaml', flat('design-system'))
    const { sources, warnings } = collectRouterSources(request())
    expect(sources.map((s) => `${s.scope}/${s.id}`)).toEqual([
      'project/alpha', 'project/zeta', 'global/catalog', 'template/design-system',
    ])
    expect(sources.map((s) => s.builtin)).toEqual([false, false, false, true])
    expect(sources.every((s) => !(s.ir instanceof Error))).toBe(true)
    expect(warnings).toEqual([])
  })

  it('不存在的目录等于没有文件；隐藏文件、非 .yaml、目录与符号链接一律不读', () => {
    expect(collectRouterSources(request()).sources).toEqual([])
    const dir = workflowsDirUnder(repo)
    put(dir, 'real.yaml', routed('real', 'r'))
    put(dir, '.hidden.yaml', routed('hidden', 'h'))
    put(dir, 'notes.txt', 'x')
    mkdirSync(join(dir, 'folder.yaml'))
    put(base, 'outside.yaml', routed('outside', 'o'))
    symlinkSync(join(base, 'outside.yaml'), join(dir, 'outside.yaml'))
    expect(collectRouterSources(request()).sources.map((s) => s.id)).toEqual(['real'])
  })

  it('坏文件变成带错误的条目而不是抛出：非法名、name 与文件名不一致、存储校验失败、超大', () => {
    const dir = workflowsDirUnder(repo)
    put(dir, 'bad name.yaml', flat('bad'))
    put(dir, 'mismatch.yaml', flat('other'))
    put(dir, 'garbage.yaml', 'name: garbage\n???\n')
    put(dir, 'default.yaml', flat('default'))
    put(dir, 'huge.yaml', `${flat('huge')}${'# pad\n'.repeat(Math.ceil(MAX_SOURCE_BYTES / 6) + 10)}`)
    const { sources } = collectRouterSources(request())
    const byId = Object.fromEntries(sources.map((s) => [s.id, s.ir]))
    expect(byId['bad name']).toBeInstanceOf(Error)
    expect(byId.mismatch).toBeInstanceOf(Error)
    expect(String((byId.mismatch as Error).message)).toMatch(/name/u)
    expect(byId.garbage).toBeInstanceOf(Error)
    expect(byId.default).toBeInstanceOf(Error)
    expect(String((byId.default as Error).message)).toMatch(/openspec/u)
    expect(byId.huge).toBeInstanceOf(Error)
    expect(String((byId.huge as Error).message)).toMatch(/1 MiB/u)
    const huge = sources.find((s) => s.id === 'huge')
    expect(Buffer.byteLength(huge?.source ?? '')).toBe(MAX_SOURCE_BYTES + 1)
  })

  it('每个目录最多读 64 个文件，多出的忽略并警告', () => {
    const dir = workflowsDirUnder(repo)
    for (let i = 0; i < 70; i += 1) put(dir, `w${String(i).padStart(2, '0')}.yaml`, flat(`w${String(i).padStart(2, '0')}`))
    const { sources, warnings } = collectRouterSources(request())
    expect(sources).toHaveLength(64)
    expect(sources.at(-1)?.id).toBe('w63')
    expect(warnings).toEqual([expect.stringMatching(/64/u)])
  })
})

describe('摘要与 router.sh 的重算约定一致', () => {
  it('同一批文件用 shell（head -c / printf / sha256）重算出相同的 sourceDigest', () => {
    put(workflowsDirUnder(repo), 'mine.yaml', routed('mine', '中文关键词'))
    put(globalDir, 'theirs.yaml', `${routed('theirs', 'x')}# 无结尾换行`)
    put(join(templates, 'workflows'), 'default-ish.yaml', flat('default-ish'))
    const { sources } = collectRouterSources(request())
    const script = [
      'cd "$1"; hash() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; }',
      '{',
      '  for f in "$2"/*.yaml; do printf "project/%s\\n" "${f##*/}"; head -c 1048577 -- "$f"; printf "\\n"; done',
      '  for f in "$3"/*.yaml; do printf "global/%s\\n" "${f##*/}"; head -c 1048577 -- "$f"; printf "\\n"; done',
      '  for f in "$4"/*.yaml; do printf "template/%s\\n" "${f##*/}"; head -c 1048577 -- "$f"; printf "\\n"; done',
      '} | hash',
    ].join('\n')
    const run = spawnSync('bash', ['-c', script, '_', base, workflowsDirUnder(repo), globalDir, join(templates, 'workflows')], {
      encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' },
    })
    expect(run.status).toBe(0)
    expect(run.stdout.split(/\s+/u)[0]).toBe(routerSourceDigest(sources))
  })
})

describe('generateRouterCache', () => {
  it('项目文件遮住模板；全局存储来自 resolveProductPaths 的配置根；缓存是 v6 纯数据', () => {
    put(join(templates, 'workflows'), 'catalog.yaml', routed('catalog', '模板词', 100))
    put(workflowsDirUnder(repo), 'catalog.yaml', routed('catalog', '项目词', 700))
    put(globalDir, 'extra.yaml', routed('extra', 'ex', 50))
    const { text, table, warnings } = generateRouterCache({ ...request(), projectRoot: repo })
    expect(text.split('\n')[0]).toBe('TENON_ROUTER_V6')
    expect(table.rows.map((r) => `${r.workflow}:${r.track}:${r.priority}`)).toEqual(['catalog:catalog:700', 'extra:extra:50'])
    expect(warnings).toEqual([])
    expect(text).not.toMatch(/项目词|模板词/u)
    expect(table.sourceDigest).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('一个坏工作流只产生警告，不影响其余路由，也不进缓存文本', () => {
    put(globalDir, 'good.yaml', routed('good', 'ok'))
    put(globalDir, 'broken.yaml', 'name: broken\n???\n')
    const { text, table, warnings } = generateRouterCache({ ...request(), projectRoot: repo })
    expect(table.rows.map((r) => r.workflow)).toEqual(['good'])
    expect(warnings).toEqual([expect.stringMatching(/broken/u)])
    expect(text).not.toMatch(/broken/u)
  })
})
