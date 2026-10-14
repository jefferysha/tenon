/**
 * 测试信任按「用户 + 仓库 + 命令」共享的端到端场景：主检出信任过的命令，新 worktree 不用再确认；改一条命令只有这一条要重新确认；
 * 伪造的 `.git` 指针借不到信任；git 仓库里检出目录中的旧封存一律不认（信任只来自用户级存储）；旧检出封存只在不是 git 仓库时生效。
 * 全部走真的 buildProgram、真 git 仓库与 worktree；用户级信任存储落在 vitest 隔离出来的临时 TENON_RUNTIME_HOME 下，不碰真实用户目录。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addTrustEntries, catalogExecDigest, catalogExecEntries, parseTestCatalog, readTestSeal, readTrustStore, resolveProductPaths,
  stepTestExecEntries, testTrustPaths, updateTestSeal,
} from '@tenon/kernel'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { trustAnnotated } from './commands/statusStepTrust.js'
import { resolveTestCommand } from './commands/test-context.js'
import { catalogTrustTarget, cmdTestTrust, ensureTrusted } from './commands/test-trust.js'
import { FIXED_CLOCK, freshHarness, makeHarness, realDeps, type Harness } from './integration-harness.js'
import { commitAll, git, writeFiles } from './integration-harness-tests.js'
import { repoTrustIdentity } from './test-system/repo-identity.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }
/** 关掉测试装配默认的「已信任」：像刚克隆下来的仓库一样，用户还没确认过里面的命令。 */
const UNTRUSTED = { ...USER, TENON_TEST_TRUST: '' }
const SLUG = 'a-at-x.io'
const INIT = ['init', 'demo', '--track', 'backend', '--workflow', 'trusted', '--preset', 'full']

const WORKFLOW = `name: trusted
tracks:
  backend:
    steps:
      - id: build
        label: 实现
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        tests:
          - id: step-ok
            direction: unit
            command: node -e 'process.exit(0)'
            timeout_s: 60
          - id: step-other
            direction: unit
            command: node -e 'process.exit(Number(process.env.TENON_BAD ?? 0))'
            timeout_s: 60
        transitions:
          - event: build-done
            to: verify
      - id: verify
        label: 验证
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
`

function catalog(lintCommand = 'node lint.mjs'): string {
  return `schema: tenon-test-catalog/v1
suites:
  - id: unit
    kind: custom
    runner: custom
    command: node unit.mjs
    report: { format: exit-code }
  - id: lint
    kind: lint
    runner: custom
    command: ${lintCommand}
    report: { format: exit-code }
`
}

const FILES: Readonly<Record<string, string>> = {
  'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
  '.gitignore': 'test-results\nopenspec\n.tenon/users\n.pipeline-*\n.pipeline/cache\n.pipeline/.gitignore\n.tenon/.gitignore\n',
  'unit.mjs': 'process.exit(0)\n',
  'lint.mjs': 'process.exit(0)\n',
  '.tenon/tests/catalog.yaml': catalog(),
  '.pipeline/workflows/trusted.yaml': WORKFLOW,
}

/** 隔离出来的用户级状态根（vitest 的 setup 把 TENON_RUNTIME_HOME 指到临时目录）。 */
const stateRoot = (): string => resolveProductPaths({ env: process.env }).stateRoot

describe('测试信任：用户 + 仓库 + 命令', () => {
  const extraRoots: string[] = []
  let h: Harness | undefined
  let savedRuntimeHome: string | undefined
  // 每个用例一个空的产品 home：用户级信任存储不在用例之间累积，断言才有意义。
  beforeEach(async () => {
    savedRuntimeHome = process.env.TENON_RUNTIME_HOME
    process.env.TENON_RUNTIME_HOME = await mkdtemp(join(tmpdir(), 'tenon-trust-home-'))
  })
  afterEach(async () => {
    if (h) await rm(h.cwd, { recursive: true, force: true })
    h = undefined
    await Promise.all(extraRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
    await rm(process.env.TENON_RUNTIME_HOME ?? '', { recursive: true, force: true })
    if (savedRuntimeHome === undefined) delete process.env.TENON_RUNTIME_HOME
    else process.env.TENON_RUNTIME_HOME = savedRuntimeHome
  })

  /** 已提交的 git 仓库：目录、工作流、脚本；主检出里已创建任务 demo。 */
  async function project(options: { readonly git?: boolean } = {}): Promise<Harness> {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, FILES)
    if (options.git !== false) {
      git(harness.cwd, ['init', '-q', '-b', 'main'])
      commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    }
    expect(await harness.run(INIT, { env: USER }), harness.err.join('\n')).toBe(0)
    return harness
  }

  /** 从主检出建一个链接的 worktree，并在里面创建同名任务。 */
  async function linkedWorktree(main: Harness): Promise<Harness> {
    const path = `${main.cwd}-wt`
    extraRoots.push(path)
    git(main.cwd, ['worktree', 'add', '-q', '-b', 'feature', path])
    const linked = makeHarness(path)
    expect(await linked.run(INIT, { env: USER }), linked.err.join('\n')).toBe(0)
    return linked
  }

  const tenon = (env: Record<string, string>, ...args: string[]): Promise<number> => (h as Harness).run(args, { env })
  const out = (): string => (h as Harness).out.join('\n')
  const err = (): string => (h as Harness).err.join('\n')
  const cwd = (): string => (h as Harness).cwd
  const writeCatalog = (text: string): Promise<void> => writeFile(join(cwd(), '.tenon/tests/catalog.yaml'), text, 'utf8')
  const userStore = (): Promise<readonly { readonly repo: string; readonly command: string }[]> => readTrustStore(stateRoot(), SLUG)

  test('主检出信任一次，新 worktree 里直接运行；信任记在用户级目录，不写检出封存，也不碰真实用户目录', async () => {
    const realRoot = join(resolveProductPaths({ env: {}, homeDir: homedir() }).stateRoot, 'test-trust')
    const realBefore = existsSync(realRoot) ? await readdir(realRoot) : null
    const main = await project()
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', '--suite', 'unit')).toBe(1)
    expect(err()).toContain('还没有得到你的信任')
    expect(err()).toContain('node unit.mjs')

    expect(await tenon(UNTRUSTED, 'test', 'trust', '--yes'), err()).toBe(0)
    expect(out()).toContain('node unit.mjs')
    expect(out()).toContain('node lint.mjs')
    const identity = await repoTrustIdentity(main.cwd)
    expect(identity).toEqual({ kind: 'repo', repo: join(await realpathOf(main.cwd), '.git') })
    const repo = await repoOf(main.cwd)
    expect((await userStore()).map((entry) => entry.repo)).toEqual([repo, repo])
    expect(existsSync(testTrustPaths(stateRoot(), SLUG).file)).toBe(true)
    expect((await readTestSeal(main.cwd, SLUG)).seal.trusted).toEqual([])

    const linked = await linkedWorktree(main)
    expect(await linked.run(['test', 'run', 'demo', '--suite', 'unit'], { env: UNTRUSTED }), linked.err.join('\n')).toBe(0)
    expect(linked.err.join('\n')).not.toContain('信任')
    expect(await linked.run(['test', 'run', 'demo', '--suite', 'lint'], { env: UNTRUSTED }), linked.err.join('\n')).toBe(0)
    expect(await linked.run(['test', 'trust', '--status'], { env: UNTRUSTED })).toBe(0)

    // 测试环境用的是隔离的 TENON_RUNTIME_HOME；真实用户目录既没被创建也没被写入。
    expect(stateRoot().startsWith(tmpdir())).toBe(true)
    expect(join(stateRoot(), 'test-trust')).not.toBe(realRoot)
    expect(existsSync(realRoot) ? await readdir(realRoot) : null).toEqual(realBefore)
  }, 120_000)

  test('改一个套件的命令：只有这一条未信任，只校验本次要执行的套件；--status / --json 逐条显示；再信任只列这一条', async () => {
    await project()
    expect(await tenon(UNTRUSTED, 'test', 'trust', '--yes'), err()).toBe(0)
    await writeCatalog(catalog('node lint.mjs --strict'))

    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', '--suite', 'unit'), err()).toBe(0)
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', '--suite', 'unit', '--suite', 'lint')).toBe(1)
    expect(err()).toContain('node lint.mjs --strict')
    expect(err()).not.toContain('node unit.mjs')

    expect(await tenon(UNTRUSTED, 'test', 'trust', '--status')).toBe(2)
    expect(out()).toMatch(/未信任.*node lint\.mjs --strict/u)
    expect(out()).toMatch(/已信任.*node unit\.mjs/u)
    expect(await tenon(UNTRUSTED, 'test', 'trust', '--json')).toBe(2)
    const [target] = JSON.parse(out()) as Array<{ kind: string; trusted: boolean; entries: Array<{ line: string; trusted: boolean }> }>
    expect(target).toMatchObject({ kind: 'catalog', trusted: false })
    expect(target?.entries.map((entry) => [entry.trusted, entry.line.includes('node lint.mjs --strict')])).toEqual([[true, false], [false, true]])

    expect(await tenon(UNTRUSTED, 'test', 'trust', '--yes'), err()).toBe(0)
    expect(out()).toContain('node lint.mjs --strict')
    expect(out()).not.toContain('node unit.mjs')
    expect(await tenon(UNTRUSTED, 'test', 'trust', '--status')).toBe(0)
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', '--suite', 'lint'), err()).toBe(0)
  }, 120_000)

  test('没有 --yes 又不是交互终端：不替用户确认，什么都不写', async () => {
    await project()
    expect(await tenon(UNTRUSTED, 'test', 'trust')).toBe(1)
    expect(err()).toContain('信任需要你本人确认')
    expect(await userStore()).toEqual([])
    expect(existsSync(testTrustPaths(stateRoot(), SLUG).file)).toBe(false)
  }, 60_000)

  /** 把当前目录的整份摘要写成检出旧封存里的信任（与老版本 `tenon test trust` 写下的一样），同时生成本机密钥。 */
  async function writeLegacyTrust(dir: string = cwd()): Promise<void> {
    const parsed = parseTestCatalog(catalog())
    if (!parsed.ok) throw new Error('fixture catalog invalid')
    await updateTestSeal(dir, SLUG, (seal) => ({ ...seal, trusted: [{ digest: catalogExecDigest(parsed.catalog), by: 'a@x.io', at: FIXED_CLOCK }] }))
  }
  const SEAL_FILE = `.tenon/users/${SLUG}/local/test-seal.json`
  const KEY_FILE = `.tenon/users/${SLUG}/local/env.key`

  test('git 仓库里检出目录中的旧封存（未被 git 跟踪，等同压缩包带来的封存与密钥）不认；在用户级存储里信任之后照常运行，旧封存文件不动', async () => {
    await project()
    await writeLegacyTrust()
    const sealBefore = await readFile(join(cwd(), SEAL_FILE), 'utf8')
    expect(await userStore()).toEqual([])
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', '--suite', 'unit')).toBe(1)
    expect(err()).toContain('还没有得到你的信任')
    expect(err()).toContain('不再被认')
    expect(err()).toContain('tenon test trust demo')
    expect(await tenon(UNTRUSTED, 'test', 'trust', '--status')).toBe(2)

    expect(await tenon(UNTRUSTED, 'test', 'trust', '--yes'), err()).toBe(0)
    expect(await userStore()).not.toEqual([])
    expect(await readFile(join(cwd(), SEAL_FILE), 'utf8')).toBe(sealBefore)

    // 之后的运行会往封存里记录链头（封存的其他用途），但信任列表仍是原来那一条。
    const trustedBefore = (await readTestSeal(cwd(), SLUG)).seal.trusted
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', '--suite', 'unit'), err()).toBe(0)
    expect((await readTestSeal(cwd(), SLUG)).seal.trusted).toEqual(trustedBefore)
  }, 120_000)

  test('「旧信任不再被认」的提示只在旧封存恰好记着当前整份摘要时才打：目录改过、封存损坏、没有旧封存都不打', async () => {
    await project()
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', '--suite', 'unit')).toBe(1)
    expect(err()).not.toContain('不再被认')

    await writeLegacyTrust()
    await writeCatalog(catalog('node lint.mjs --strict'))
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', '--suite', 'unit')).toBe(1)
    expect(err()).not.toContain('不再被认')

    await writeCatalog(catalog())
    await writeFile(join(cwd(), SEAL_FILE), 'not json\n', 'utf8')
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', '--suite', 'unit')).toBe(1)
    expect(err()).toContain('还没有得到你的信任')
    expect(err()).not.toContain('不再被认')
  }, 120_000)

  test('旧封存与密钥被 git 跟踪（git add -f 能绕过 .gitignore）：同样不认，暂存、提交、取消跟踪之后都一样', async () => {
    await project()
    await writeLegacyTrust()

    git(cwd(), ['add', '-f', SEAL_FILE, KEY_FILE])
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', '--suite', 'unit')).toBe(1)
    expect(err()).toContain('还没有得到你的信任')
    expect(err()).toContain('node unit.mjs')
    expect(await tenon(UNTRUSTED, 'test', 'trust', '--status')).toBe(2)
    expect(out()).toMatch(/未信任.*node unit\.mjs/u)

    commitAll(cwd(), 'ship seal and key', '2026-01-02T00:00:00Z')
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', '--suite', 'unit')).toBe(1)
    expect(err()).toContain('还没有得到你的信任')

    // 取消跟踪之后也不认：git 仓库里检出目录中的旧封存与它是否被跟踪无关。
    git(cwd(), ['rm', '-q', '--cached', SEAL_FILE, KEY_FILE])
    expect(await tenon(UNTRUSTED, 'test', 'trust', '--status')).toBe(2)
    expect(await userStore()).toEqual([])
  }, 180_000)

  test('不是 git 仓库：旧封存照规格有效，不去问 git', async () => {
    const main = await project({ git: false })
    expect(await repoTrustIdentity(main.cwd)).toEqual({ kind: 'not-repo' })
    await writeLegacyTrust()
    expect(await tenon(UNTRUSTED, 'test', 'trust', '--status'), err()).toBe(0)
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', '--suite', 'unit'), err()).toBe(0)
    expect(await userStore()).toEqual([])
  }, 120_000)

  test('不是 git 仓库：退回检出目录里的旧封存，不写用户级存储', async () => {
    const main = await project({ git: false })
    expect(await repoTrustIdentity(main.cwd)).toEqual({ kind: 'not-repo' })
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', '--suite', 'unit')).toBe(1)
    expect(await tenon(UNTRUSTED, 'test', 'trust', '--yes'), err()).toBe(0)
    expect((await readTestSeal(main.cwd, SLUG)).seal.trusted).toHaveLength(1)
    expect(await userStore()).toEqual([])
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', '--suite', 'unit'), err()).toBe(0)
  }, 120_000)

  test('伪造的 .git 指针借不到信任：命令一字不差也一样', async () => {
    const main = await project()
    expect(await tenon(UNTRUSTED, 'test', 'trust', '--yes'), err()).toBe(0)
    const forgedPath = `${main.cwd}-forged`
    extraRoots.push(forgedPath)
    await mkdir(forgedPath)
    await writeFiles(forgedPath, FILES)
    await writeFile(join(forgedPath, '.git'), `gitdir: ${join(await realpathOf(main.cwd), '.git')}\n`)
    expect(git(forgedPath, ['rev-parse', '--git-common-dir']).trim()).toBe(join(await realpathOf(main.cwd), '.git'))
    expect(await repoTrustIdentity(forgedPath)).toEqual({ kind: 'unresolved' })
    const forged = makeHarness(forgedPath)
    expect(await forged.run(INIT, { env: USER }), forged.err.join('\n')).toBe(0)
    expect(await forged.run(['test', 'run', 'demo', '--suite', 'unit'], { env: UNTRUSTED })).toBe(1)
    expect(forged.err.join('\n')).toContain('还没有得到你的信任')
    expect(forged.err.join('\n')).toContain('node unit.mjs')
  }, 120_000)

  /** 带 `.git` 却读不出身份的检出：伪造的指针，或内容损坏（git 自己读不了）。 */
  const UNRESOLVED_CHECKOUTS: readonly (readonly [string, (main: Harness) => Promise<string>])[] = [
    ['伪造的 .git 指针', async (main) => `gitdir: ${join(await realpathOf(main.cwd), '.git')}\n`],
    ['损坏的 .git 文件（git 出错）', async () => 'this is not a gitfile\n'],
  ]

  test.each(UNRESOLVED_CHECKOUTS)('%s：检出里记着当前摘要的旧封存不认，运行与 --status 都按未信任', async (_name, pointer) => {
    const main = await project()
    const brokenPath = `${main.cwd}-broken`
    extraRoots.push(brokenPath)
    await mkdir(brokenPath)
    await writeFiles(brokenPath, FILES)
    await writeFile(join(brokenPath, '.git'), await pointer(main))
    expect(await repoTrustIdentity(brokenPath)).toEqual({ kind: 'unresolved' })
    const broken = makeHarness(brokenPath)
    expect(await broken.run(INIT, { env: USER }), broken.err.join('\n')).toBe(0)
    await writeLegacyTrust(brokenPath)
    // 对照：同样的旧封存放在没有 .git 的目录里是认的（见「不是 git 仓库」的用例）；这里有 .git 读不出身份，就不认。
    expect(await broken.run(['test', 'run', 'demo', '--suite', 'unit'], { env: UNTRUSTED })).toBe(1)
    expect(broken.err.join('\n')).toContain('还没有得到你的信任')
    expect(broken.err.join('\n')).toContain('node unit.mjs')
    // 提示要指向真正的原因：此时让用户去运行 tenon test trust 也写不进去。
    expect(broken.err.join('\n')).toContain('读不出仓库身份')
    broken.out.length = 0
    expect(await broken.run(['test', 'trust', '--status'], { env: UNTRUSTED })).toBe(2)
    expect(broken.out.join('\n')).toMatch(/未信任.*node unit\.mjs/u)
  }, 120_000)

  test('真实克隆上 git 暂时用不了（PATH 里没有 git）：读不出身份，连用户级存储也不查；git 回来后照旧有效', async () => {
    await project()
    expect(await tenon(UNTRUSTED, 'test', 'trust', '--yes'), err()).toBe(0)
    expect(await tenon(UNTRUSTED, 'test', 'trust', '--status'), err()).toBe(0)
    const noGit = await mkdtemp(join(tmpdir(), 'tenon-no-git-'))
    extraRoots.push(noGit)
    const savedPath = process.env.PATH
    try {
      process.env.PATH = noGit
      expect(await tenon(UNTRUSTED, 'test', 'trust', '--status')).toBe(2)
      expect(out()).toMatch(/未信任.*node unit\.mjs/u)
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
    }
    expect(await tenon(UNTRUSTED, 'test', 'trust', '--status'), err()).toBe(0)
  }, 120_000)

  test.each(UNRESOLVED_CHECKOUTS)('%s：tenon test trust --yes 拒绝写入，检出封存与用户级存储都不动', async (_name, pointer) => {
    const main = await project()
    const brokenPath = `${main.cwd}-broken`
    extraRoots.push(brokenPath)
    await mkdir(brokenPath)
    await writeFiles(brokenPath, FILES)
    await writeFile(join(brokenPath, '.git'), await pointer(main))
    const broken = makeHarness(brokenPath)
    expect(await broken.run(INIT, { env: USER }), broken.err.join('\n')).toBe(0)
    expect(await broken.run(['test', 'trust', '--yes'], { env: UNTRUSTED })).toBe(1)
    expect(broken.err.join('\n')).toContain('读不出仓库身份')
    expect(broken.out.join('\n')).not.toContain('已信任')
    expect(existsSync(join(brokenPath, SEAL_FILE))).toBe(false)
    expect(await userStore()).toEqual([])
    expect(existsSync(testTrustPaths(stateRoot(), SLUG).file)).toBe(false)
  }, 120_000)

  /** 没有用户级状态目录（deps.productPaths 缺失）的 git 仓库里运行 `tenon test trust --yes`：信任只记在用户级存储里，无处可写。 */
  async function trustWithoutStateRoot(): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
    const outLines: string[] = []
    const errLines: string[] = []
    const { productPaths: _unused, ...deps } = realDeps(cwd(), outLines, errLines, { ...process.env, ...UNTRUSTED })
    const code = await cmdTestTrust(deps, undefined, { yes: true })
    return { code, out: outLines.join('\n'), err: errLines.join('\n') }
  }

  test('没有用户级状态目录的 git 仓库：写不进用户级存储，列命令、确认之前就拒绝，检出里不写也不改旧封存', async () => {
    await project()
    expect(existsSync(join(cwd(), SEAL_FILE))).toBe(false)
    const first = await trustWithoutStateRoot()
    expect(first.code).not.toBe(0)
    expect(first.err).toContain('没有用户级状态目录')
    expect(first.out).not.toContain('将被信任的命令')
    expect(first.out).not.toContain('已信任')
    expect(existsSync(join(cwd(), SEAL_FILE))).toBe(false)
    expect(await userStore()).toEqual([])

    // 检出里已经有记着当前摘要的旧封存：git 仓库里不认它，同样拒绝，文件内容不动。
    await writeLegacyTrust()
    const sealBefore = await readFile(join(cwd(), SEAL_FILE), 'utf8')
    const second = await trustWithoutStateRoot()
    expect(second.code).not.toBe(0)
    expect(second.err).toContain('没有用户级状态目录')
    expect(second.out).not.toContain('将被信任的命令')
    expect(second.out).not.toContain('已信任')
    expect(await readFile(join(cwd(), SEAL_FILE), 'utf8')).toBe(sealBefore)
    expect(await userStore()).toEqual([])
  }, 120_000)

  /** 执行前的信任校验（tenon test run 走的那一道）对整份目录的结果与它打到 stderr 的全部文字。 */
  async function ensureCatalogTrusted(withStateRoot: boolean): Promise<{ readonly trusted: boolean; readonly err: string }> {
    const errLines: string[] = []
    const { productPaths, ...withoutPaths } = realDeps(cwd(), [], errLines, { ...process.env, ...UNTRUSTED })
    const deps = withStateRoot ? { ...withoutPaths, productPaths } : withoutPaths
    const trusted = await ensureTrusted(deps, SLUG, catalogTrustTarget(parseTestCatalog(catalog()).catalog), 'demo')
    return { trusted, err: errLines.join('\n') }
  }

  test('没有用户级状态目录的 git 仓库：执行前的信任校验照样列出未信任的命令，但不再让用户去运行写不进去的 tenon test trust', async () => {
    await project()
    const result = await ensureCatalogTrusted(false)
    expect(result.trusted).toBe(false)
    expect(result.err).toContain('还没有得到你的信任')
    expect(result.err).toContain('node unit.mjs')
    expect(result.err).toContain('没有用户级状态目录：git 仓库的信任只记在用户级存储里，写不进去')
    expect(result.err).not.toContain('请你在自己的终端里运行')
    expect(existsSync(join(cwd(), SEAL_FILE))).toBe(false)
  }, 120_000)

  test('有用户级状态目录的 git 仓库：执行前的信任校验仍然提示在自己的终端里运行 tenon test trust', async () => {
    await project()
    const result = await ensureCatalogTrusted(true)
    expect(result.trusted).toBe(false)
    expect(result.err).toContain('请你在自己的终端里运行 tenon test trust demo 逐条确认')
    expect(result.err).not.toContain('没有用户级状态目录')
  }, 120_000)

  test('检出旧封存写不进去（local 的位置被一个普通文件占了）：非零退出并给出原因，不抛未捕获异常', async () => {
    await project({ git: false })
    const userDir = join(cwd(), '.tenon', 'users', SLUG)
    await mkdir(userDir, { recursive: true })
    await writeFile(join(userDir, 'local'), 'not a directory\n', 'utf8')
    expect(await tenon(UNTRUSTED, 'test', 'trust', '--yes')).toBe(1)
    expect(err()).toContain('无法写入检出里的旧封存')
    expect(out()).not.toContain('已信任')
  }, 120_000)

  test('步骤内联测试：同样逐条信任，只校验要执行的那一条，worktree 共享', async () => {
    const main = await project()
    const identity = await repoOf(main.cwd)
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', 'step-ok')).toBe(1)
    expect(err()).toContain('node -e')
    // 只信任 step-ok 这一条（用户级存储里按单条命令的摘要记）。
    const [okEntry] = stepTestExecEntries([{ step: 'build', id: 'step-ok', command: "node -e 'process.exit(0)'", cwd: '.' }])
    if (okEntry === undefined) throw new Error('no entry')
    await addTrustEntries(stateRoot(), SLUG, [{ repo: identity, digest: okEntry.digest, command: okEntry.line, by: 'a@x.io', at: FIXED_CLOCK }])
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', 'step-ok'), err()).toBe(0)
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', 'step-other')).toBe(1)
    expect(err()).toContain('step-other')
    expect(err()).not.toContain('step-ok')

    const linked = await linkedWorktree(main)
    expect(await linked.run(['test', 'run', 'demo', 'step-ok'], { env: UNTRUSTED }), linked.err.join('\n')).toBe(0)
    expect(await tenon(UNTRUSTED, 'test', 'trust', 'demo', '--yes'), err()).toBe(0)
    expect(out()).toContain('step-other')
    expect(out()).not.toContain('step-ok')
    expect(await tenon(UNTRUSTED, 'test', 'run', 'demo', 'step-other'), err()).toBe(0)
  }, 120_000)

  test('status 的 run-tests 信任预告只列未信任的命令', async () => {
    await project()
    const deps = (): ReturnType<typeof realDeps> => realDeps(cwd(), [], [], { ...process.env, ...UNTRUSTED })
    const context = await resolveTestCommand(deps(), 'demo', { requireOwner: false })
    if (typeof context === 'number') throw new Error('context unavailable')
    const actions = [{ action: 'run-tests', command: 'tenon test run demo --stage' }, { action: 'fix' }]
    const before = await trustAnnotated(deps(), 'demo', context.plan, actions)
    const notice = before[0]?.trust as { command: string; commands: string[] }
    expect(notice.command).toBe('tenon test trust demo')
    expect(notice.commands.join('\n')).toContain('node unit.mjs')
    expect(notice.commands.join('\n')).toContain('node lint.mjs')
    expect(notice.commands.join('\n')).toContain('步骤 build 的测试 step-ok')
    expect(before[1]).toEqual({ action: 'fix' })

    expect(await tenon(UNTRUSTED, 'test', 'trust', 'demo', '--yes'), err()).toBe(0)
    expect(await trustAnnotated(deps(), 'demo', context.plan, actions)).toEqual(actions)

    await writeCatalog(catalog('node lint.mjs --strict'))
    const after = await trustAnnotated(deps(), 'demo', context.plan, actions)
    const changed = (after[0]?.trust as { commands: string[] }).commands
    expect(changed).toHaveLength(1)
    expect(changed[0]).toContain('node lint.mjs --strict')
  }, 120_000)

  test('用户级存储里的条目与 catalogExecEntries 的摘要一一对应（审计友好：存的是确认时给用户看的那一行）', async () => {
    await project()
    expect(await tenon(UNTRUSTED, 'test', 'trust', '--yes'), err()).toBe(0)
    const parsed = parseTestCatalog(catalog())
    if (!parsed.ok) throw new Error('fixture catalog invalid')
    const expected = catalogExecEntries(parsed.catalog)
    const stored = await readTrustStore(stateRoot(), SLUG)
    expect(stored.map((entry) => entry.digest)).toEqual(expected.map((entry) => entry.digest))
    expect(stored.map((entry) => entry.command)).toEqual(expected.map((entry) => entry.line))
    expect(stored.every((entry) => entry.by === 'a@x.io')).toBe(true)
    expect(JSON.parse(await readFile(testTrustPaths(stateRoot(), SLUG).file, 'utf8')).schema).toBe('tenon-test-trust/v1')
  }, 60_000)
})

const realpathOf = (path: string): Promise<string> => realpath(path)

/** 夹具仓库的仓库身份（common dir）；读不出就让用例直接失败。 */
async function repoOf(path: string): Promise<string> {
  const identity = await repoTrustIdentity(path)
  if (identity.kind !== 'repo') throw new Error(`fixture checkout has no repo identity: ${identity.kind}`)
  return identity.repo
}
