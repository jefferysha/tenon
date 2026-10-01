/**
 * memSessionLink.test —— v9-I GET /api/mem/session-link 真 HTTP 端到端（GOAL C9：零 mock）。
 * 真起 http server（listen(0)）+ 真建带 automation_worktree 的 change（kernel StateStore 真落盘）
 * + 真写 claude/codex/opencode 会话 fixture 树（nodeMemFs(fakeHome) 注入，hermetic 不碰真 ~/.claude）
 * → 真 node:http GET → 断言 found 三态 / resumeCmd 拼法 / 校验顺序（400/404 先例对齐）。
 *
 * 能力边界（端点如实返回，测试如实钉住）：
 *   · claude → `cd <dir> && claude --resume <sid>`；codex → `cd <dir> && codex resume <sid>`
 *     （二者拼法宿主机 --help 实测确认）；dir/sid 过 POSIX 单引号转义（codex 终稿 P2，
 *     与前端 shellQuote 同款）：安全字符原样、含空格/`$` 等则整体单引号；
 *     其余平台 resumeCmd:null（不造假命令）。
 *   · 查不到会话恒 200 { found:false, reason }——AFK 沙箱 claude 会话随容器 HOME=/tmp 销毁，
 *     宿主机查不到是常态不是错误。
 *   · 分别单独查 claude/codex 两个「有把握拼 resumeCmd」的平台各自最新一条，两者间选更新的那条
 *     ——不再是「fetch 一批混合结果再筛选」，不存在同目录下任意数量的 opencode/pi 会话（哪怕
 *     远超过第六轮修复用过的 limit:3）能把可恢复会话挤没机会被查到的数量上限（codex review 第七
 *     轮 P2，是第六轮 limit:3 修法留下的残留边界）；两个平台都没有才退回全平台最新那条
 *     （found:true + resumeCmd:null 的既有降级）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { nodeMemFs } from '@tenon/kernel'
import { createTestDashboardServer } from './test-server.js'
import { resolveServerPaths } from './paths.js'
import type { DashboardServer } from './types.js'
import { initChange, makeProject, makeTempHome, makeWorktreeDir, newStore, reqGet, testFlow } from './test-support.js'

// node:sqlite 是极新内建模块，vitest 的静态 import 解析认不得它（会当裸包名 "sqlite" 去找
// node_modules）——用 createRequire 惰性拿，与生产代码 kernel/mem/adapters/opencode.ts、
// 及其测试 kernel/mem/adapters/opencode.test.ts 同款绕法，非本文件独创。
type SqliteNS = typeof import('node:sqlite')
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as SqliteNS

const openServers: DashboardServer[] = []
afterEach(async () => {
  while (openServers.length) await openServers.pop()!.close()
})

/** 真写一个 claude 会话 fixture：<home>/.claude/projects/<dirName>/<sid>.jsonl（首事件带 cwd）。 */
async function writeClaudeSession(home: string, dirName: string, sid: string, cwd: string): Promise<string> {
  const dir = join(home, '.claude', 'projects', dirName)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${sid}.jsonl`)
  const evt = { type: 'user', cwd, timestamp: '2026-07-10T00:00:00Z', message: { role: 'user', content: 'hi' } }
  await writeFile(file, `${JSON.stringify(evt)}\n`, 'utf8')
  return file
}

/** 真写一个 codex 会话 fixture：<home>/.codex/sessions/2026/07/rollout-…-<n>.jsonl（首行 payload meta）。 */
async function writeCodexSession(home: string, sid: string, cwd: string): Promise<string> {
  const dir = join(home, '.codex', 'sessions', '2026', '07')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `rollout-2026-07-12T10-00-00-${sid}.jsonl`)
  const first = { timestamp: '2026-07-12T10:00:00.000Z', payload: { id: sid, cwd } }
  await writeFile(file, `${JSON.stringify(first)}\n`, 'utf8')
  return file
}

/**
 * 真写一个 opencode 会话 fixture：<home>/.local/share/opencode/opencode.db 的 session 表插一行。
 * schema 取自 packages/kernel/src/mem/adapters/opencode.test.ts 对 opencode-ai@1.17.14 的实测结果，
 * 列裁到 opencodeListSessions 实际 SELECT 的子集——resolveSessionLink 只查会话头，不读对话，
 * 无需 message/part 表。updatedIso 直接落 time_updated 整数列（毫秒），不像 claude/codex fixture
 * 靠文件 mtime 间接控排序——两种控排序手法都是各平台适配器的真实读取路径，不是测试专用捷径。
 */
async function writeOpencodeSession(home: string, sid: string, cwd: string, updatedIso: string): Promise<string> {
  const dbPath = join(home, '.local', 'share', 'opencode', 'opencode.db')
  await mkdir(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      workspace_id text,
      parent_id text,
      slug text NOT NULL,
      directory text NOT NULL,
      path text,
      title text NOT NULL,
      version text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL
    );
  `)
  db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, 'global', NULL, 'test-slug', ?, 'opencode fixture session', '1.17.14', ?, ?)`,
  ).run(sid, cwd, Date.parse(updatedIso), Date.parse(updatedIso))
  db.close()
  return dbPath
}

interface Harness {
  port: number
  root: string
  home: string
}

/** 真建 server + 一批 change（可带 automation_worktree），mem 根指向独立 fixture home。 */
async function startWith(changes: Record<string, { worktree?: string }>): Promise<Harness> {
  const store = newStore()
  const root = await makeProject()
  const home = await makeTempHome()
  for (const [name, cfg] of Object.entries(changes)) {
    await initChange(store, root, name)
    if (cfg.worktree !== undefined) {
      await store.set(join(root, 'openspec', 'changes', name), 'automation_worktree' as never, cfg.worktree)
    }
  }
  const srv = createTestDashboardServer({
    paths: resolveServerPaths({ home, env: {} }),
    hostHome: home,
    version: '9.9.9', token: 't', registry: () => [root], store, flow: testFlow(),
    // env 全 undefined——不让真跑这套测试的宿主 shell 里可能设置的 XDG_DATA_HOME 泄进来，
    // 否则 opencode fixture（写在 <home>/.local/share/...）可能被真实 XDG_DATA_HOME 覆盖路径
    // 而读不到（同 kernel/mem/adapters/opencode.test.ts 的 realFs() precaution）。
    clock: () => '2026-07-13T00:00:00Z', memFs: { ...nodeMemFs(home), env: () => undefined },
  })
  openServers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { port, root, home }
}

/** 生产默认 wiring：不注入 memFs，且宿主 home 与 Tenon 产品状态 home 刻意分离。 */
async function startWithDefaultMemFs(name: string, worktree: string): Promise<Harness> {
  const store = newStore()
  const root = await makeProject()
  const hostHome = await makeTempHome()
  const productHome = await makeTempHome()
  await initChange(store, root, name)
  await store.set(
    join(root, 'openspec', 'changes', name),
    'automation_worktree' as never,
    worktree,
  )
  const srv = createTestDashboardServer({
    paths: resolveServerPaths({ home: productHome, env: {} }),
    hostHome,
    version: '9.9.9',
    token: 't',
    registry: () => [root],
    store,
    flow: testFlow(),
    clock: () => '2026-07-13T00:00:00Z',
  })
  openServers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { port, root, home: hostHome }
}

function linkPath(root: string, name: string): string {
  return `/api/mem/session-link?root=${encodeURIComponent(root)}&name=${encodeURIComponent(name)}`
}

/** 批量端点 URL 拼装：重复键 root=&name=&root=&name=...（下标配对，同前端 fetchSessionLinks 拼法）。 */
function linksPath(pairs: Array<{ root: string; name: string }>): string {
  const sp = new URLSearchParams()
  for (const p of pairs) {
    sp.append('root', p.root)
    sp.append('name', p.name)
  }
  return `/api/mem/session-links?${sp.toString()}`
}

describe('GET /api/mem/session-link —— found 三态', () => {
  it('默认 memFs 只从显式 hostHome 读取会话，不借用产品 home 或 OS home', async () => {
    const wt = await makeWorktreeDir()
    const h = await startWithDefaultMemFs('host-bound', wt)
    await writeCodexSession(h.home, 'host-bound-session', wt)

    const j = (await reqGet(h.port, linkPath(h.root, 'host-bound'))).json<any>()
    expect(j).toMatchObject({
      found: true,
      platform: 'codex',
      sessionId: 'host-bound-session',
      dir: wt,
    })
  })

  it('claude 会话命中 worktree：found:true + `claude --resume` 恢复命令', async () => {
    const wt = await makeWorktreeDir()
    const h = await startWith({ hotfix: { worktree: wt } })
    const sid = 'aaaabbbb-1111-2222-3333-444455556666'
    await writeClaudeSession(h.home, 'proj-a', sid, wt)

    const r = await reqGet(h.port, linkPath(h.root, 'hotfix'))
    expect(r.status).toBe(200)
    const j = r.json<any>()
    expect(j.found).toBe(true)
    expect(j.platform).toBe('claude')
    expect(j.sessionId).toBe(sid)
    expect(j.dir).toBe(wt)
    // mkdtemp 路径全在安全集 [A-Za-z0-9_@%+=:,./-] 内 → 原样不带引号
    expect(j.resumeCmd).toBe(`cd ${wt} && claude --resume ${sid}`)
    expect(typeof j.mtime).toBe('string')
  })

  it('codex 会话命中 worktree：resumeCmd 用 `codex resume <id>` 拼法', async () => {
    const wt = await makeWorktreeDir()
    const h = await startWith({ cdx: { worktree: wt } })
    await writeCodexSession(h.home, 'cdx-uuid-1', wt)

    const j = (await reqGet(h.port, linkPath(h.root, 'cdx'))).json<any>()
    expect(j.found).toBe(true)
    expect(j.platform).toBe('codex')
    expect(j.sessionId).toBe('cdx-uuid-1')
    expect(j.resumeCmd).toBe(`cd ${wt} && codex resume cdx-uuid-1`)
  })

  it('cwd 含空格与 $ → resumeCmd 目录段单引号转义，仍是一条安全命令（codex 终稿 P2）', async () => {
    const wt = join(await makeWorktreeDir(), 'My $Work dir')
    await mkdir(wt, { recursive: true })
    const h = await startWith({ spicy: { worktree: wt } })
    const sid = 'ccccdddd-1111-2222-3333-444455556666'
    await writeClaudeSession(h.home, 'proj-s', sid, wt)

    const j = (await reqGet(h.port, linkPath(h.root, 'spicy'))).json<any>()
    expect(j.found).toBe(true)
    expect(j.dir).toBe(wt)
    // 目录整体单引号（内部无展开）；sid 是安全字符 → 原样
    expect(j.resumeCmd).toBe(`cd '${wt}' && claude --resume ${sid}`)
  })

  it('同 cwd 多会话取最近（mtime 倒序首条）', async () => {
    const wt = await makeWorktreeDir()
    const h = await startWith({ multi: { worktree: wt } })
    const oldFile = await writeClaudeSession(h.home, 'proj-m', 'old-session-id-0000', wt)
    await writeClaudeSession(h.home, 'proj-m', 'new-session-id-9999', wt)
    const past = new Date('2026-07-01T00:00:00Z')
    await utimes(oldFile, past, past) // 旧会话 mtime 拨回，新会话必须排前

    const j = (await reqGet(h.port, linkPath(h.root, 'multi'))).json<any>()
    expect(j.found).toBe(true)
    expect(j.sessionId).toBe('new-session-id-9999')
  })

  it('同 cwd 下 opencode 会话比 claude 新 → 仍优先选可恢复平台 claude，不被更新的 opencode 挡住（codex review 第六轮 P2）', async () => {
    const wt = await makeWorktreeDir()
    const h = await startWith({ mixed: { worktree: wt } })
    const sid = 'ffffaaaa-1111-2222-3333-444455556666'
    const claudeFile = await writeClaudeSession(h.home, 'proj-mixed', sid, wt)
    const past = new Date('2026-07-01T00:00:00Z')
    await utimes(claudeFile, past, past) // claude 会话故意拨旧
    // opencode 的 updated 直落 time_updated 列（晚于上面拨旧的 claude），listAll 排序后本会排 sessions[0]——
    // 旧代码盲选 sessions[0] 会被它挡住；修复后应在 fetched 的 3 条里跳过它选中 claude。
    await writeOpencodeSession(h.home, 'oc-newer-session', wt, '2026-07-12T00:00:00Z')

    const j = (await reqGet(h.port, linkPath(h.root, 'mixed'))).json<any>()
    expect(j.found).toBe(true)
    expect(j.platform).toBe('claude')
    expect(j.sessionId).toBe(sid)
    expect(j.dir).toBe(wt)
    expect(j.resumeCmd).toBe(`cd ${wt} && claude --resume ${sid}`)
  })

  it('3 条 opencode 会话都比 claude 新（挤满旧 limit:3 策略的全部名额）→ 仍必须穿透找到可恢复的 claude 会话（codex review 第七轮 P2：不依赖任何数量上限的修法）', async () => {
    const wt = await makeWorktreeDir()
    const h = await startWith({ swamped: { worktree: wt } })
    const sid = 'aaaa1111-1111-2222-3333-444455556666'
    const claudeFile = await writeClaudeSession(h.home, 'proj-swamped', sid, wt)
    const past = new Date('2026-07-01T00:00:00Z')
    await utimes(claudeFile, past, past) // claude 会话故意拨旧
    // 3 条 opencode 会话，updated 全比上面拨旧的 claude 会话新——第六轮 limit:3 的修法在
    // platform:'all', limit:3 下会被这 3 条 opencode 会话把 fetch 名额占满，claude 那条连被
    // fetch 到的机会都没有，.find(x => x.platform === 'claude' || 'codex') 必然落空，错误退化成
    // 全平台首条（某条 opencode）的静态兜底——这正是第七轮 codex review 点名的残留边界。
    await writeOpencodeSession(h.home, 'oc-swamp-1', wt, '2026-07-12T00:00:00Z')
    await writeOpencodeSession(h.home, 'oc-swamp-2', wt, '2026-07-12T01:00:00Z')
    await writeOpencodeSession(h.home, 'oc-swamp-3', wt, '2026-07-12T02:00:00Z')

    const j = (await reqGet(h.port, linkPath(h.root, 'swamped'))).json<any>()
    expect(j.found).toBe(true)
    expect(j.platform).toBe('claude')
    expect(j.sessionId).toBe(sid)
    expect(j.dir).toBe(wt)
    expect(j.resumeCmd).toBe(`cd ${wt} && claude --resume ${sid}`)
  })

  it('目录下只有 opencode 会话（无 claude/codex）→ fallback 未被破坏：仍 found:true + resumeCmd:null', async () => {
    const wt = await makeWorktreeDir()
    const h = await startWith({ ocOnly: { worktree: wt } })
    await writeOpencodeSession(h.home, 'oc-only-session', wt, '2026-07-05T00:00:00Z')

    const j = (await reqGet(h.port, linkPath(h.root, 'ocOnly'))).json<any>()
    expect(j.found).toBe(true)
    expect(j.platform).toBe('opencode')
    expect(j.sessionId).toBe('oc-only-session')
    expect(j.dir).toBe(wt)
    expect(j.resumeCmd).toBeNull()
  })

  it('automation_worktree 未设 → 回落 root 目录查（本机直跑会话）', async () => {
    const h = await startWith({ plain: {} }) // init 后 worktree 为空串
    const sid = 'root-session-id-1234'
    await writeClaudeSession(h.home, 'proj-r', sid, h.root)

    const j = (await reqGet(h.port, linkPath(h.root, 'plain'))).json<any>()
    expect(j.found).toBe(true)
    expect(j.sessionId).toBe(sid)
    expect(j.dir).toBe(h.root)
  })

  it('查不到任何会话：恒 200 found:false + reason（不是错误——AFK 沙箱会话随容器销毁是常态）', async () => {
    const wt = await makeWorktreeDir()
    const h = await startWith({ ghost: { worktree: wt } })

    const r = await reqGet(h.port, linkPath(h.root, 'ghost'))
    expect(r.status).toBe(200)
    const j = r.json<any>()
    expect(j.found).toBe(false)
    expect(j.dir).toBe(wt)
    expect(j.reason).toBe('no-session')
    expect(j.resumeCmd).toBeUndefined()
  })
})

describe('GET /api/mem/session-link —— 校验顺序（400/404 先例对齐）', () => {
  it('非法 change 名 → 400（先于 root 校验）', async () => {
    const h = await startWith({ ok: {} })
    const r = await reqGet(h.port, `/api/mem/session-link?root=${encodeURIComponent(h.root)}&name=${encodeURIComponent('../evil')}`)
    expect(r.status).toBe(400)
  })

  it('缺 root 参数 → 400', async () => {
    const h = await startWith({ ok: {} })
    const r = await reqGet(h.port, '/api/mem/session-link?name=ok')
    expect(r.status).toBe(400)
    expect(r.json<any>().error).toContain('root')
  })

  it('root 未注册 → 404（信任锚，同 /api/change/:name/history 先例）', async () => {
    const h = await startWith({ ok: {} })
    const evil = await makeProject()
    const r = await reqGet(h.port, linkPath(evil, 'ok'))
    expect(r.status).toBe(404)
  })

  it('change 不存在（无 .pipeline.yaml）→ 400（三兄弟端点统一状态码约定）', async () => {
    const h = await startWith({ ok: {} })
    const r = await reqGet(h.port, linkPath(h.root, 'nope'))
    expect(r.status).toBe(400)
  })

  it('伪造 Host 头 → 403（DNS 重绑定守卫统一施加）', async () => {
    const h = await startWith({ ok: {} })
    const r = await reqGet(h.port, linkPath(h.root, 'ok'), '127.0.0.1', { Host: 'evil.com' })
    expect(r.status).toBe(403)
  })
})

/**
 * v9-J：GET /api/mem/session-links（批量）—— 进度视图 failed 行 chip 一次预取全部失败行，
 * 复用单条端点同款 resolveSessionLink（不复制粘贴）。fail-soft 家族纪律：单个 pair 校验不过
 * 只让该 key found:false reason:'invalid'，不拖累整批 400；成功恒 200。
 */
describe('GET /api/mem/session-links —— 批量预取（v9-J）', () => {
  it('两个 change 都命中会话 → map 两条都对（claude/codex 各自拼法）', async () => {
    const wtA = await makeWorktreeDir()
    const wtB = await makeWorktreeDir()
    const h = await startWith({ a: { worktree: wtA }, b: { worktree: wtB } })
    const sidA = 'aaaaaaaa-1111-2222-3333-444455556666'
    const sidB = 'codex-uuid-batch-b'
    await writeClaudeSession(h.home, 'proj-a1', sidA, wtA)
    await writeCodexSession(h.home, sidB, wtB)

    const r = await reqGet(h.port, linksPath([{ root: h.root, name: 'a' }, { root: h.root, name: 'b' }]))
    expect(r.status).toBe(200)
    const j = r.json<any>()
    const keyA = `a@${h.root}`
    const keyB = `b@${h.root}`
    expect(j.links[keyA].found).toBe(true)
    expect(j.links[keyA].platform).toBe('claude')
    expect(j.links[keyA].resumeCmd).toBe(`cd ${wtA} && claude --resume ${sidA}`)
    expect(j.links[keyB].found).toBe(true)
    expect(j.links[keyB].platform).toBe('codex')
    expect(j.links[keyB].resumeCmd).toBe(`cd ${wtB} && codex resume ${sidB}`)
  })

  it('一条命中一条查无 → 各自诚实 found:true/false（不互相污染）', async () => {
    const wt = await makeWorktreeDir()
    const ghostWt = await makeWorktreeDir()
    const h = await startWith({ hit: { worktree: wt }, ghost: { worktree: ghostWt } })
    const sid = 'cccccccc-1111-2222-3333-444455556666'
    await writeClaudeSession(h.home, 'proj-hit', sid, wt)

    const r = await reqGet(h.port, linksPath([{ root: h.root, name: 'hit' }, { root: h.root, name: 'ghost' }]))
    expect(r.status).toBe(200)
    const j = r.json<any>()
    expect(j.links[`hit@${h.root}`].found).toBe(true)
    expect(j.links[`hit@${h.root}`].sessionId).toBe(sid)
    expect(j.links[`ghost@${h.root}`].found).toBe(false)
    expect(j.links[`ghost@${h.root}`].reason).toBe('no-session')
  })

  it('一个 pair 名字非法 → 该 key found:false reason:invalid，其余 pair 不受影响、整体仍 200（fail-soft）', async () => {
    const wt = await makeWorktreeDir()
    const h = await startWith({ ok: { worktree: wt } })
    const sid = 'dddddddd-1111-2222-3333-444455556666'
    await writeClaudeSession(h.home, 'proj-ok', sid, wt)

    const r = await reqGet(h.port, linksPath([{ root: h.root, name: 'ok' }, { root: h.root, name: '../evil' }]))
    expect(r.status).toBe(200)
    const j = r.json<any>()
    expect(j.links[`ok@${h.root}`].found).toBe(true)
    expect(j.links[`../evil@${h.root}`]).toEqual({ found: false, reason: 'invalid' })
  })

  it('root 未注册 / change 不存在的 pair 同样 fail-soft 为 invalid（不 404/400 整批）', async () => {
    const wt = await makeWorktreeDir()
    const h = await startWith({ ok: { worktree: wt } })
    const evilRoot = await makeProject() // 未注册
    const sid = 'eeeeeeee-1111-2222-3333-444455556666'
    await writeClaudeSession(h.home, 'proj-ok2', sid, wt)

    const r = await reqGet(
      h.port,
      linksPath([
        { root: h.root, name: 'ok' },
        { root: evilRoot, name: 'ok' },
        { root: h.root, name: 'nope' },
      ]),
    )
    expect(r.status).toBe(200)
    const j = r.json<any>()
    expect(j.links[`ok@${h.root}`].found).toBe(true)
    expect(j.links[`ok@${evilRoot}`]).toEqual({ found: false, reason: 'invalid' })
    expect(j.links[`nope@${h.root}`]).toEqual({ found: false, reason: 'invalid' })
  })

  it('超过 50 对 → 400', async () => {
    const h = await startWith({ ok: {} })
    const pairs = Array.from({ length: 51 }, (_, i) => ({ root: h.root, name: `n${i}` }))
    const r = await reqGet(h.port, linksPath(pairs))
    expect(r.status).toBe(400)
    expect(r.json<any>().error).toContain('上限')
  })

  it('root/name 数量不匹配（重复键脱节）→ 400', async () => {
    const h = await startWith({ ok: {} })
    const r = await reqGet(h.port, `/api/mem/session-links?root=${encodeURIComponent(h.root)}&name=a&name=b`)
    expect(r.status).toBe(400)
  })

  it('恰好 50 对 → 不触发上限拒绝，恒 200', async () => {
    const h = await startWith({ ok: {} })
    const pairs = Array.from({ length: 50 }, (_, i) => ({ root: h.root, name: `n${i}` }))
    const r = await reqGet(h.port, linksPath(pairs))
    expect(r.status).toBe(200)
  })

  it('伪造 Host 头 → 403（DNS 重绑定守卫统一施加，与单条端点同款）', async () => {
    const h = await startWith({ ok: {} })
    const r = await reqGet(h.port, linksPath([{ root: h.root, name: 'ok' }]), '127.0.0.1', { Host: 'evil.com' })
    expect(r.status).toBe(403)
  })
})
