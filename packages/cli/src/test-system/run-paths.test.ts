import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { pathRootsFor, relativizeRunStrings, type PathRoots } from './run-paths.js'

const scratch: string[] = []

async function scratchDir(name = 'tenon-run-paths-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), name))
  scratch.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** 纯字符串根：不碰文件系统。 */
function roots(repo: readonly string[], home?: string): PathRoots {
  return { repo, home }
}

describe('relativizeRunStrings：仓库根与主目录前缀', () => {
  const repo = '/work/projects/demo'
  const plain = roots([repo], '/home/dev')

  it('失败堆栈里的 <repo>/… 与 file://<repo>/… 改写为仓库相对路径', () => {
    const stack = [
      `Error: boom`,
      `    at Object.<anonymous> (${repo}/packages/cli/src/a.test.ts:10:5)`,
      `    at load (file://${repo}/node_modules/x.js:3:9)`,
    ].join('\n')
    expect(relativizeRunStrings(stack, plain)).toBe([
      'Error: boom',
      '    at Object.<anonymous> (packages/cli/src/a.test.ts:10:5)',
      '    at load (node_modules/x.js:3:9)',
    ].join('\n'))
  })

  it('主目录前缀改写为 ~/；仓库在主目录之下时仓库前缀优先，其余主目录路径才变 ~/', () => {
    const home = roots(['/home/dev/code/demo'], '/home/dev')
    expect(relativizeRunStrings('cannot read /home/dev/.config/tool/rc', home)).toBe('cannot read ~/.config/tool/rc')
    expect(relativizeRunStrings('/home/dev/code/demo/src/a.ts and /home/dev/.cache/b', home)).toBe('src/a.ts and ~/.cache/b')
  })

  it('恰好等于仓库根 / 主目录（后面没有斜杠）的出现也改写，记录里不留绝对路径', () => {
    expect(relativizeRunStrings(`ENOENT: scandir '${repo}'`, plain)).toBe("ENOENT: scandir '.'")
    expect(relativizeRunStrings(repo, plain)).toBe('.')
    expect(relativizeRunStrings('HOME=/home/dev', plain)).toBe('HOME=~')
  })

  it('不是前缀的同名片段不改：<repo>-other/、<repo>.bak/、前面还有别的路径段、以及 /home/devops', () => {
    const text = [
      `${repo}-other/src/a.ts`,
      `${repo}.bak/src/a.ts`,
      `/mnt${repo}/src/a.ts`,
      `prefix${repo}/src/a.ts`,
      '/home/devops/x',
      `${repo}中文/x`,
    ].join('\n')
    expect(relativizeRunStrings(text, plain)).toBe(text)
  })

  it('路径出现在引号、括号、等号、冒号之后同样改写（边界字符不算路径的一部分）', () => {
    const text = `open '${repo}/a' (${repo}/b) cwd=${repo}/c at:${repo}/d "${repo}/e"`
    expect(relativizeRunStrings(text, plain)).toBe(`open 'a' (b) cwd=c at:d "e"`)
  })

  it('仓库根含空格和中文：原样写法与 file:// 的百分号编码写法都改写', () => {
    const odd = '/work/我的 项目/demo app'
    const oddRoots = roots([odd])
    const url = pathToFileURL(odd).href
    expect(url).toContain('%20')
    const stack = `at ${odd}/src/a.test.ts:1:1\nat ${url}/node_modules/x.js:2:2\nat file://${odd}/y.js:3:3`
    expect(relativizeRunStrings(stack, oddRoots)).toBe('at src/a.test.ts:1:1\nat node_modules/x.js:2:2\nat y.js:3:3')
  })

  it('多个仓库根（逻辑 + 真实路径）：长的先匹配，两种写法都改写', () => {
    const both = roots(['/private/var/folders/xx/demo', '/var/folders/xx/demo'])
    expect(relativizeRunStrings('/var/folders/xx/demo/a.ts /private/var/folders/xx/demo/b.ts', both)).toBe('a.ts b.ts')
  })

  it('home 缺省、为空或为根目录时不改写主目录（绝不把 / 当前缀）', () => {
    const text = 'at /home/dev/x and /usr/lib/y'
    for (const home of [undefined, '', '/']) {
      expect(relativizeRunStrings(text, roots([repo], home))).toBe(text)
    }
    expect(relativizeRunStrings('/a/b', roots(['/', ''], undefined))).toBe('/a/b')
  })
})

describe('relativizeRunStrings：深拷贝，只改字符串', () => {
  const repo = '/work/projects/demo'
  const plain = roots([repo], '/home/dev')

  it('嵌套对象与数组里的字符串都改写；数字、布尔、null、undefined 原样；键不改', () => {
    const input = {
      suite: 'unit',
      exit_code: 1,
      ok: false,
      none: null,
      missing: undefined,
      reasons: [{ code: 'x', detail: `see ${repo}/log.txt` }],
      cases: [{ failure: { message: `at ${repo}/a.ts:1`, stack: 'at /home/dev/.npm/x', expected: undefined } }],
      [`${repo}/key`]: 'v',
    }
    const out = relativizeRunStrings(input, plain)
    expect(out).toEqual({
      suite: 'unit',
      exit_code: 1,
      ok: false,
      none: null,
      missing: undefined,
      reasons: [{ code: 'x', detail: 'see log.txt' }],
      cases: [{ failure: { message: 'at a.ts:1', stack: 'at ~/.npm/x', expected: undefined } }],
      [`${repo}/key`]: 'v',
    })
  })

  it('不改输入：返回新对象，原对象里的绝对路径保留（本机日志与判定用的原始数据不受影响）', () => {
    const input = { reasons: [{ code: 'x', detail: `${repo}/a` }], list: [`${repo}/b`] }
    const snapshot = JSON.parse(JSON.stringify(input)) as typeof input
    const out = relativizeRunStrings(input, plain)
    expect(out).not.toBe(input)
    expect(out.reasons).not.toBe(input.reasons)
    expect(out.reasons[0]).not.toBe(input.reasons[0])
    expect(input).toEqual(snapshot)
  })

  it('没有任何前缀可改的值：结构相等', () => {
    const input = { a: ['x', 1, { b: 'src/a.ts' }], c: true }
    expect(relativizeRunStrings(input, plain)).toEqual(input)
  })
})

describe('pathRootsFor', () => {
  it('逻辑路径与 realpath 都收进来，去重、长的在前；符号链接的两种写法都被改写', async () => {
    const real = await realpath(await scratchDir())
    const holder = await scratchDir()
    const link = join(holder, 'repo-link')
    await symlink(real, link)
    const found = await pathRootsFor(link, undefined)
    expect(found.repo).toContain(link)
    expect(found.repo).toContain(real)
    expect(new Set(found.repo).size, '去重').toBe(found.repo.length)
    expect([...found.repo].sort((a, b) => b.length - a.length), '长的在前').toEqual(found.repo)
    expect(found.home).toBeUndefined()
    const text = `at ${link}/src/a.ts:1\nat ${real}/src/b.ts:2\nat file://${real}/c.js`
    expect(relativizeRunStrings(text, found)).toBe('at src/a.ts:1\nat src/b.ts:2\nat c.js')
  })

  it('不存在的目录：只剩逻辑路径，不抛错', async () => {
    const missing = join(await scratchDir(), 'gone')
    const found = await pathRootsFor(missing, '/home/dev')
    expect(found.repo).toEqual([missing])
    expect(found.home).toBe('/home/dev')
  })

  it('末尾斜杠与 ./.. 段先规范化；仓库根含空格和中文也能认出', async () => {
    const base = await scratchDir()
    const odd = join(base, '我的 项目')
    await mkdir(odd)
    const found = await pathRootsFor(`${odd}/sub/..//`, undefined)
    expect(found.repo).toContain(odd)
    expect(relativizeRunStrings(`${odd}/x.ts`, found)).toBe('x.ts')
  })

  it('macOS 的 /var 与 /private/var 互为真实路径：用任一种写法建根，另一种写法也被改写', async () => {
    const logical = await scratchDir()
    const real = await realpath(logical)
    for (const given of [logical, real]) {
      const found = await pathRootsFor(given, undefined)
      expect(relativizeRunStrings(`${logical}/a.ts ${real}/b.ts`, found), `以 ${given} 建根`).toBe('a.ts b.ts')
    }
  })
})
