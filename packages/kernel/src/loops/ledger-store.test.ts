import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { LOCK_DIR_NAME, LOCK_OWNER_FILE, STALE_LOCK_MS } from '../state/lock.js'
import { decodeLedgerLine, encodeLedgerRecord } from './ledger-codec.js'
import {
  createLoopLedgerStore, LEDGER_DIR, LEDGER_FILE, ledgerDirPath, ledgerFilePath,
} from './ledger-store.js'
import type {
  BudgetReservationRecord,
  LedgerRecord,
  ReservationActivatedRecord,
  RunRecord,
  SkillBundleSnapshotRecord,
  UsageRecord,
} from './ledger-types.js'

// ── 样本工厂（record_id 由调用方生成——store 契约如此，测试即调用方）────────────

let seq = 0
function nextId(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}`
}

function makeRecordBase() {
  return { schema_version: 1 as const, record_id: nextId('rec'), recorded_at: '2026-07-17T05:00:00.000Z' }
}

function makeReservation(over: Partial<BudgetReservationRecord> = {}): BudgetReservationRecord {
  return {
    ...makeRecordBase(),
    kind: 'budget-reservation',
    reservation_id: nextId('res'),
    attempt_id: nextId('att'),
    loop_id: 'loop-a',
    change: 'w1-ledger',
    budget_day: '2026-07-17',
    reserved_runs: 1,
    reserved_tokens: 60_000,
    token_basis: 'risk-default',
    limits_snapshot: { max_runs_per_day: 6, max_in_flight: 1, on_exceed: 'skip-run' },
    expires_at: '2026-07-17T06:00:00.000Z',
    ...over,
  }
}

function makeActivated(over: Partial<ReservationActivatedRecord> = {}): ReservationActivatedRecord {
  return {
    ...makeRecordBase(),
    kind: 'reservation-activated',
    reservation_id: 'res-x',
    attempt_id: nextId('att'),
    loop_id: 'loop-a',
    change: 'w1-ledger',
    started_at: '2026-07-17T05:01:00.000Z',
    ...over,
  }
}

function makeUsage(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ...makeRecordBase(),
    kind: 'usage',
    usage_id: nextId('usage'),
    attempt_id: nextId('att'),
    loop_id: 'loop-a',
    provider: 'anthropic',
    tokens: { input: 1200, output: 3400, total: 4600 },
    source: 'provider-structured',
    observed_at: '2026-07-17T05:02:00.000Z',
    ...over,
  }
}

function makeSkillBundleSnapshot(over: Partial<SkillBundleSnapshotRecord> = {}): SkillBundleSnapshotRecord {
  return {
    ...makeRecordBase(),
    kind: 'skill-bundle-snapshot',
    attempt_id: nextId('att'),
    reservation_id: 'res-x',
    loop_id: 'loop-a',
    skill_bundle_id: 'pm',
    policy_epoch: 'epoch-a1',
    resolution_source: 'default',
    workflow_run_id: 'wfr-1',
    workflow: 'default',
    step: 'verify',
    track: 'pm',
    coordinate_digest: '1'.repeat(64),
    snapshot_sha256: 'e'.repeat(64),
    cas_relative_path: `.pipeline/loops/skill-snapshots/sha256/${'e'.repeat(64)}`,
    slots: [{ token: 'pm-writing', alternatives: ['pm-writing'], concrete_skill_id: 'pm-writing', tree_sha256: 'c'.repeat(64) }],
    ...over,
  }
}

function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    ...makeRecordBase(),
    kind: 'run',
    run_record_id: nextId('run'),
    attempt_id: nextId('att'),
    loop_id: 'loop-a',
    change: 'w1-ledger',
    level: 'L2',
    runner: 'claude-code',
    admitted_at: '2026-07-17T05:00:30.000Z',
    finished_at: '2026-07-17T05:10:00.000Z',
    result: 'merged',
    usage_record_ids: [],
    accounting: { reserved_tokens: 60_000, charged_tokens: 0, charge_source: 'none' },
    ...over,
  }
}

describe('loops/ledger-store —— 仓级锁 append + 宽容读 + run 窗口投影（真 fs 临时目录）', () => {
  let repoRoot: string
  const store = createLoopLedgerStore()

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'lite-ledger-'))
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  test('路径常量：ledger 落在 <repoRoot>/.pipeline/loops/ledger.jsonl', () => {
    expect(LEDGER_DIR).toEqual(['.pipeline', 'loops'])
    expect(LEDGER_FILE).toBe('ledger.jsonl')
    expect(ledgerDirPath(repoRoot)).toBe(join(repoRoot, '.pipeline', 'loops'))
    expect(ledgerFilePath(repoRoot)).toBe(join(repoRoot, '.pipeline', 'loops', 'ledger.jsonl'))
  })

  describe('append —— 锁内整行写 + fsync + 编解码往返校验', () => {
    test('append 后立即读回一致（全新 repoRoot 无 .pipeline，目录自动创建）', async () => {
      const rec = makeUsage()
      await store.append(repoRoot, rec)
      const { records, rejected } = await store.read(repoRoot)
      expect(records).toEqual([rec])
      expect(rejected).toEqual([])
    })

    test('多条 append 保序（append 顺序 = 读回顺序）', async () => {
      const a = makeReservation()
      const b = makeActivated({ reservation_id: a.reservation_id })
      // 带 reservation_id 的 terminal 走 closeReservationIfOpen（普通 append 拒之，见幂等原语）。
      const c = makeRun({ reservation_id: a.reservation_id, attempt_id: a.attempt_id })
      await store.append(repoRoot, a)
      await store.append(repoRoot, b)
      await store.closeReservationIfOpen(repoRoot, a.reservation_id, () => c)
      const { records } = await store.read(repoRoot)
      expect(records.map((r) => r.record_id)).toEqual([a.record_id, b.record_id, c.record_id])
    })

    test('append 拒写不可解码记录（未知 kind）→ reject 且一个字节都不落盘', async () => {
      const bogus = { ...makeUsage(), kind: 'usage-v2' } as unknown as LedgerRecord
      await expect(store.append(repoRoot, bogus)).rejects.toThrow(/往返|解码|kind/)
      const { records, rejected } = await store.read(repoRoot)
      expect(records).toEqual([])
      expect(rejected).toEqual([])
    })

    test('文件逐字节：每条恰一行（encode 原文 + 行尾换行），无多余空行', async () => {
      const a = makeUsage()
      const b = makeRun()
      await store.append(repoRoot, a)
      await store.append(repoRoot, b)
      const raw = await readFile(ledgerFilePath(repoRoot), 'utf8')
      expect(raw).toBe(`${encodeLedgerRecord(a)}\n${encodeLedgerRecord(b)}\n`)
    })
  })

  describe('read —— 宽容读与错误纪律', () => {
    test('文件不存在 → 空结果（ENOENT-only 宽容，对齐 server readJsonlHistory 纪律）', async () => {
      const { records, rejected } = await store.read(repoRoot)
      expect(records).toEqual([])
      expect(rejected).toEqual([])
    })

    test('坏行隔离：非法 JSON 行与半行进 rejected（行号正确），前后合法行照读', async () => {
      const good1 = makeUsage()
      const good2 = makeRun()
      await store.append(repoRoot, good1)
      await store.append(repoRoot, good2)
      // 手工污染：中部插入非法行，尾部塞半行（模拟崩溃写坏），再补一条合法行
      const good3 = makeReservation()
      const contaminated =
        `${encodeLedgerRecord(good1)}\n` +
        '{oops not json\n' +
        `${encodeLedgerRecord(good2)}\n` +
        `${encodeLedgerRecord(good3)}\n` +
        '{"schema_version":1,"kind":"usage","usage_id":"trunc' // 无行尾换行的半行
      await writeFile(ledgerFilePath(repoRoot), contaminated, 'utf8')

      const { records, rejected } = await store.read(repoRoot)
      expect(records.map((r) => r.record_id)).toEqual([good1.record_id, good2.record_id, good3.record_id])
      expect(rejected).toHaveLength(2)
      expect(rejected[0]!.line).toBe(2)
      expect(rejected[1]!.line).toBe(5)
    })

    test('rejected 不回传原文：条目只有 line/raw_hash/error，raw_hash 为短 hex 哈希', async () => {
      const secretLine = '{"password":"hunter2" broken'
      await mkdir(ledgerDirPath(repoRoot), { recursive: true })
      await writeFile(ledgerFilePath(repoRoot), `${secretLine}\n`, 'utf8')

      const { rejected } = await store.read(repoRoot)
      expect(rejected).toHaveLength(1)
      const entry = rejected[0]!
      expect(Object.keys(entry).sort()).toEqual(['error', 'line', 'raw_hash'])
      expect(entry.raw_hash).toMatch(/^[0-9a-f]{12}$/)
      expect(JSON.stringify(entry)).not.toContain('hunter2')
    })

    // 旧测试「空白行跳过、不计 rejected」把内部空白行也固化成合法,与 fail-closed 相悖,
    // 按 codex review 修复对齐:唯二豁免只有完全空文件与末尾换行的收尾空段,其余空白行是损坏。
    test('唯二豁免:完全空文件、以及「每行以 \\n 结尾」惯例下末尾换行的收尾空段,不计 rejected', async () => {
      await mkdir(ledgerDirPath(repoRoot), { recursive: true })
      await writeFile(ledgerFilePath(repoRoot), '', 'utf8')
      expect(await store.read(repoRoot)).toEqual({ records: [], rejected: [] })

      const rec = makeUsage()
      await writeFile(ledgerFilePath(repoRoot), `${encodeLedgerRecord(rec)}\n`, 'utf8')
      const { records, rejected } = await store.read(repoRoot)
      expect(records).toEqual([rec])
      expect(rejected).toEqual([])
    })

    test('内部空白行不是合法 JSONL,是损坏痕迹 → 进 rejected 且行号正确(fail-closed,修复对齐 codex review)', async () => {
      const a = makeUsage()
      const b = makeRun()
      await mkdir(ledgerDirPath(repoRoot), { recursive: true })
      // 行 2 = 空行、行 3 = 纯空白行,均在文件中部;行 5 是末尾换行的收尾空段(豁免)
      await writeFile(ledgerFilePath(repoRoot), `${encodeLedgerRecord(a)}\n\n \t\n${encodeLedgerRecord(b)}\n`, 'utf8')
      const { records, rejected } = await store.read(repoRoot)
      expect(records.map((r) => r.record_id)).toEqual([a.record_id, b.record_id])
      expect(rejected).toHaveLength(2)
      expect(rejected[0]!.line).toBe(2)
      expect(rejected[1]!.line).toBe(3)
      expect(rejected[0]!.error).toMatch(/空白|blank/)

      // 尾部无换行的纯空白半行同样是损坏——它不是「末尾换行符产生的空段」
      await writeFile(ledgerFilePath(repoRoot), `${encodeLedgerRecord(a)}\n  `, 'utf8')
      const tail = await store.read(repoRoot)
      expect(tail.records).toEqual([a])
      expect(tail.rejected).toHaveLength(1)
      expect(tail.rejected[0]!.line).toBe(2)
    })

    test('ledger 路径被目录占位（EISDIR 类）→ read 抛错，不得静默降级成空结果', async () => {
      await mkdir(ledgerFilePath(repoRoot), { recursive: true })
      await expect(store.read(repoRoot)).rejects.toThrow(/EISDIR/)
    })
  })

  describe('withLedgerLock —— 临界区串行 + 锁内 read/append 组合', () => {
    test('并发两个临界区零交叠（进入/退出严格成对）', async () => {
      const trace: string[] = []
      await Promise.all([
        store.withLedgerLock(repoRoot, async () => {
          trace.push('A-in')
          await sleep(25)
          trace.push('A-out')
        }),
        store.withLedgerLock(repoRoot, async () => {
          trace.push('B-in')
          await sleep(25)
          trace.push('B-out')
        }),
      ])
      expect(trace.join(',')).toMatch(/^(A-in,A-out,B-in,B-out|B-in,B-out,A-in,A-out)$/)
    })

    test(
      'fn 内可先 read 再 append 多条（append 感知已持锁，不与外层死锁）——admission 式临界区',
      async () => {
        const res = makeReservation()
        await store.append(repoRoot, res)
        const seen = await store.withLedgerLock(repoRoot, async () => {
          const before = await store.read(repoRoot)
          await store.append(repoRoot, makeActivated({ reservation_id: res.reservation_id }))
          // closeReservationIfOpen 在既有 withLedgerLock 内可重入直通（不再抢锁、不死锁）。
          await store.closeReservationIfOpen(repoRoot, res.reservation_id, () => makeRun({ reservation_id: res.reservation_id, attempt_id: res.attempt_id }))
          return before.records.length
        })
        expect(seen).toBe(1)
        const { records, rejected } = await store.read(repoRoot)
        expect(records).toHaveLength(3)
        expect(rejected).toEqual([])
      },
      // 死锁回归形态实测过（去掉 append 的持锁感知后跑本测试）：内层 withLock 挂在 lock.ts
      // 进程内 FIFO promise 链上等外层结算，acquire 根本不启动、其 10s 超时不触发——是无限
      // 自等。此处放大 vitest 超时到 15s 仅为把「偶发慢 IO」与「真死锁」拉开区分度。
      15_000,
    )

    test('fn 抛错 → 异常透传且锁释放（随后 append 立即可用）', async () => {
      await expect(store.withLedgerLock(repoRoot, async () => {
        throw new Error('admission denied')
      })).rejects.toThrow('admission denied')
      const rec = makeUsage()
      await store.append(repoRoot, rec)
      const { records } = await store.read(repoRoot)
      expect(records).toEqual([rec])
    })

    test('返回值透传', async () => {
      const out = await store.withLedgerLock(repoRoot, async () => ({ token: 42 }))
      expect(out).toEqual({ token: 42 })
    })

    // ── 可撤销令牌:「异步上下文曾继承锁」≠「物理锁当前仍存活」(codex review P1)────────
    // 漏洞形态:外层 withLedgerLock 的 fn 里 fire-and-forget 一个后代(不 await),外层结束
    // (物理锁已释放)后,后代仍带着继承的 ALS 持锁记忆去 append → 绕锁,击穿 admission
    // 临界区的互斥(预算超卖)。下面两个测试从两个观测面钉死同一漏洞。

    test('fire-and-forget 后代在外层锁释放后 append,必须排队到主流程的下一个临界区释放之后才完成', async () => {
      const events: string[] = []
      let openGate!: () => void
      const gate = new Promise<void>((r) => { openGate = r })
      let notifyAttempted!: () => void
      const attempted = new Promise<void>((r) => { notifyAttempted = r })
      const recA = makeUsage()
      const recB = makeUsage()
      let descendant!: Promise<void>

      // 外层临界区只负责播种:在锁内启动后代(其异步上下文由此继承本临界区的持锁记忆),不 await
      await store.withLedgerLock(repoRoot, async () => {
        descendant = (async () => {
          await gate // 显式编排:后代直到主流程的第二个临界区已持锁才动手
          const p = store.append(repoRoot, recB)
          notifyAttempted()
          await p
          events.push('descendant-append-done')
        })()
      })

      // 外层已结束(物理锁已释放)。主流程立刻再进 withLedgerLock 并持锁,此时后代才尝试 append。
      await store.withLedgerLock(repoRoot, async () => {
        events.push('main-critical-enter')
        openGate()
        await attempted // 后代的 append 已发起(带失效令牌的旧实现在此已绕锁进入物理写)
        await store.append(repoRoot, recA) // 锁内写 A
        events.push('main-critical-exit')
      })
      await descendant

      // 后代必须被真实阻塞到主流程释放锁之后:完成序 + 文件序双断言
      expect(events).toEqual(['main-critical-enter', 'main-critical-exit', 'descendant-append-done'])
      const { records, rejected } = await store.read(repoRoot)
      expect(rejected).toEqual([])
      expect(records.map((r) => r.record_id)).toEqual([recA.record_id, recB.record_id])
    })

    test('失效令牌的后代必须重新走锁协议(表现为回收文件系统上的陈锁),不得无视锁直写', async () => {
      // 甄别原理:锁的真相在文件系统(lock.ts 顶注)。测试布置一个 owner mtime 超过
      // STALE_LOCK_MS 的「幽灵陈锁」——重新走锁协议者必先原子回收它再持锁(lock.ts 陈锁
      // 回收语义),幽灵 owner 必然消失/被替换;绕锁者根本不碰锁目录,幽灵原封不动。
      // 该观测双向确定(不依赖 IO 完成序),与上一测试的顺序断言互为犄角。
      const lockDir = join(ledgerDirPath(repoRoot), LOCK_DIR_NAME)
      const ownerPath = join(lockDir, LOCK_OWNER_FILE)
      let openGate!: () => void
      const gate = new Promise<void>((r) => { openGate = r })
      const recA = makeUsage()
      const recB = makeUsage()
      let descendant!: Promise<void>

      await store.withLedgerLock(repoRoot, async () => {
        await store.append(repoRoot, recA) // 锁内直通 append(真可重入路径,顺带铺出 ledger 目录)
        descendant = (async () => {
          await gate
          await store.append(repoRoot, recB)
        })()
      })

      // 外层锁已释放。布置幽灵陈锁:mtime 做旧到 STALE_LOCK_MS 之前
      await mkdir(lockDir)
      await writeFile(ownerPath, 'ghost.holder.token\n', 'utf8')
      const staleTime = new Date(Date.now() - STALE_LOCK_MS - 5_000)
      await utimes(ownerPath, staleTime, staleTime)

      openGate()
      await descendant // 两种实现下都必然完成:走锁协议者回收陈锁后正常持锁写入(毫秒级)

      const ownerAfter = await readFile(ownerPath, 'utf8').catch(() => null)
      expect(ownerAfter).not.toBe('ghost.holder.token\n') // 幽灵原样存活 = 后代绕锁的铁证
      const { records, rejected } = await store.read(repoRoot)
      expect(rejected).toEqual([])
      expect(records.map((r) => r.record_id)).toEqual([recA.record_id, recB.record_id])
    })

    // ── 结构化并发:「令牌存活⇒锁仍在」不足以推出「所有获准的临界区都在锁内完成」(codex R2 P1)。
    // 上面两个测试打的是「后代在外层释放后才发起 append」→ 见失效令牌重排队;此测试打的是另一
    // 种逃逸:后代在令牌仍 active 时就被直通获准(fast-path 通过),但其 body 在外层 callback 返回
    // 后才落地。修复要点:令牌属主的 finally 在放锁前 allSettled 等 pending 全部落地,故外层
    // withLedgerLock 的 promise 直到已获准子 scope 结算才 resolve(= 物理锁直到此刻才交接)。
    test('已直通(令牌 active 时获准)但 body 未落地的后代:外层 promise 必须等它结算才 resolve,不放锁', async () => {
      let openGate!: () => void
      const gate = new Promise<void>((r) => { openGate = r })
      let markCallbackReturned!: () => void
      const callbackReturned = new Promise<void>((r) => { markCallbackReturned = r })
      const order: string[] = []
      let outerResolved = false

      const outer = store.withLedgerLock(repoRoot, async () => {
        // 令牌仍 active 时直通获准一个后代(fast-path 登记进 pending),但不 await;其 body 被 gate
        // 挡住,只能在外层 callback 返回之后才落地。
        void store.withLedgerLock(repoRoot, async () => {
          await gate
          order.push('child-body')
        })
        order.push('outer-cb-return')
        markCallbackReturned()
      })
      void outer.then(() => { outerResolved = true })

      // 外层 callback 已返回,但(修复后)finally 正 allSettled 等被 gate 挡住的后代 → outer 未 resolve。
      // 旧实现:finally 只置 active=false 立即返回 → outer 已 resolve,此断言变红。
      // 先等外层真正拿到物理锁并返回:全量并行跑时取锁本身就可能超过固定等待,不能用它代替。
      await callbackReturned
      await sleep(30)
      expect(order).toEqual(['outer-cb-return']) // 后代 body 还没跑
      expect(outerResolved).toBe(false) // 物理锁还没交接:外层在等已获准的后代落地

      openGate()
      await outer
      expect(outerResolved).toBe(true)
      expect(order).toEqual(['outer-cb-return', 'child-body']) // 后代确在锁内(外层 resolve 前)落地
    })

    // ── drain 期间不得撤销令牌:被 gate 挡住的已获准后代,在 gate 后再做嵌套锁操作(append),
    // 若 drain 前撤销令牌 → 该 append 见 active=false 重新抢锁,而物理锁正被属主 finally 持着等
    // 这个后代 → 确定性死锁(codex R3 抓到)。上一测试的后代 body 只写内存数组,覆盖不到本环。
    test('已获准后代在 gate 后再做嵌套锁 append:不死锁,外层放锁前它落地(drain 全程保持令牌 active)', async () => {
      let openGate!: () => void
      const gate = new Promise<void>((r) => { openGate = r })
      const rec = makeUsage()
      let outerResolved = false

      const outer = store.withLedgerLock(repoRoot, async () => {
        // 令牌 active 时直通获准一个后代;其 body 在 gate 后调 append(嵌套锁操作),不 await
        void store.withLedgerLock(repoRoot, async () => {
          await gate
          await store.append(repoRoot, rec)
        })
      })
      void outer.then(() => { outerResolved = true })

      await sleep(30)
      expect(outerResolved).toBe(false) // 外层在等被 gate 挡住的后代
      openGate()
      await outer // 修复后正常 resolve;死锁实现会挂到本测试 10s 超时
      expect(outerResolved).toBe(true)

      const { records, rejected } = await store.read(repoRoot)
      expect(rejected).toEqual([])
      expect(records.map((r) => r.record_id)).toEqual([rec.record_id]) // 后代的 append 已落盘
    }, 10_000) // 死锁 → 挂到此超时变红;正常毫秒级

    // ── fire-and-forget 直通后代 reject 的处理(codex R4 P1):非 async 外壳 + 登记即挂 catch 观测。
    test('fire-and-forget 直通后代 reject:不产生 unhandledRejection,外层照常 resolve', async () => {
      const unhandled: unknown[] = []
      const onUnhandled = (r: unknown): void => { unhandled.push(r) }
      process.on('unhandledRejection', onUnhandled)
      try {
        // 真 fire-and-forget:外层锁内 void 一个 reject 的直通后代,无人 await
        await store.withLedgerLock(repoRoot, async () => {
          void store.withLedgerLock(repoRoot, async () => { throw new Error('child-boom') })
        }) // 外层照常 resolve:drain 等后代落地,后代 reject 不让外层 reject(属主不代传子错误)
        await sleep(20) // 给 unhandledRejection 若要触发有充分 tick
        expect(unhandled).toEqual([]) // 登记即 p.catch 观测 → 无 unhandled
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })

    test('直通后代 reject:自行 await 的调用方仍能看到错误(观测不吞 rejection 语义)', async () => {
      await store.withLedgerLock(repoRoot, async () => {
        const child = store.withLedgerLock(repoRoot, async () => { throw new Error('child-boom-2') })
        await expect(child).rejects.toThrow('child-boom-2') // 非 async 外壳:调用方拿到的就是原 p
      })
    })
  })

  describe('readRunWindow —— 每 loop 最近 N 条 terminal run + 未关闭 reservation 保活', () => {
    test('limit 生效：单 loop 5 条 run，limit 2 → 只回最近 2 条（保持文件序）', async () => {
      const runs = [makeRun(), makeRun(), makeRun(), makeRun(), makeRun()]
      for (const r of runs) await store.append(repoRoot, r)
      const w = await store.readRunWindow(repoRoot, { limit: 2 })
      expect(w.runs.map((r) => r.run_record_id)).toEqual([runs[3]!.run_record_id, runs[4]!.run_record_id])
    })

    test('多 loop 各自取窗：A/B 各 3 条，limit 2 → 各回最近 2 条，整体保持文件序', async () => {
      const a1 = makeRun({ loop_id: 'loop-a' })
      const b1 = makeRun({ loop_id: 'loop-b' })
      const a2 = makeRun({ loop_id: 'loop-a' })
      const b2 = makeRun({ loop_id: 'loop-b' })
      const a3 = makeRun({ loop_id: 'loop-a' })
      const b3 = makeRun({ loop_id: 'loop-b' })
      for (const r of [a1, b1, a2, b2, a3, b3]) await store.append(repoRoot, r)
      const w = await store.readRunWindow(repoRoot, { limit: 2 })
      expect(w.runs.map((r) => r.run_record_id)).toEqual(
        [a2, b2, a3, b3].map((r) => r.run_record_id),
      )
    })

    test('loopId 过滤：只回该 loop 的 run 与 reservation', async () => {
      await store.append(repoRoot, makeRun({ loop_id: 'loop-a' }))
      await store.append(repoRoot, makeRun({ loop_id: 'loop-b' }))
      const resB = makeReservation({ loop_id: 'loop-b' })
      await store.append(repoRoot, resB)
      const w = await store.readRunWindow(repoRoot, { loopId: 'loop-b', limit: 10 })
      expect(w.runs.map((r) => r.loop_id)).toEqual(['loop-b'])
      expect(w.openReservations.map((r) => r.reservation_id)).toEqual([resB.reservation_id])
    })

    test('limit 0 → 零 run（slice(-0)=全量 的回归防线）', async () => {
      await store.append(repoRoot, makeRun())
      const w = await store.readRunWindow(repoRoot, { limit: 0 })
      expect(w.runs).toEqual([])
    })

    test('未关闭 reservation 保活：1 条老 reservation + 20 条新 run 远超窗口 → 仍在 openReservations，激活记录一并关联', async () => {
      const oldRes = makeReservation({ recorded_at: '2026-07-01T00:00:00.000Z' })
      const act = makeActivated({ reservation_id: oldRes.reservation_id })
      await store.append(repoRoot, oldRes)
      await store.append(repoRoot, act)
      for (let i = 0; i < 20; i++) await store.append(repoRoot, makeRun()) // 全部不引用 oldRes
      const w = await store.readRunWindow(repoRoot, { limit: 3 })
      expect(w.runs).toHaveLength(3)
      expect(w.openReservations.map((r) => r.reservation_id)).toEqual([oldRes.reservation_id])
      expect(w.activated.map((r) => r.record_id)).toEqual([act.record_id])
    })

    test('被 RunRecord 关闭的 reservation 不再出现在 openReservations，其激活记录也不回传', async () => {
      const resClosed = makeReservation()
      const resOpen = makeReservation()
      const actClosed = makeActivated({ reservation_id: resClosed.reservation_id })
      const actOpen = makeActivated({ reservation_id: resOpen.reservation_id })
      await store.append(repoRoot, resClosed)
      await store.append(repoRoot, actClosed)
      await store.append(repoRoot, resOpen)
      await store.append(repoRoot, actOpen)
      await store.closeReservationIfOpen(repoRoot, resClosed.reservation_id, () => makeRun({ reservation_id: resClosed.reservation_id, attempt_id: resClosed.attempt_id, result: 'failed', reason: 'verify-fail' }))
      const w = await store.readRunWindow(repoRoot, { limit: 10 })
      expect(w.openReservations.map((r) => r.reservation_id)).toEqual([resOpen.reservation_id])
      expect(w.activated.map((r) => r.reservation_id)).toEqual([resOpen.reservation_id])
    })

    test('rejected 透传：文件里的坏行同样出现在 readRunWindow 结果', async () => {
      await store.append(repoRoot, makeRun())
      await appendFile(ledgerFilePath(repoRoot), 'half a line', 'utf8')
      const w = await store.readRunWindow(repoRoot, { limit: 5 })
      expect(w.runs).toHaveLength(1)
      expect(w.rejected).toHaveLength(1)
      expect(w.rejected[0]!.line).toBe(2)
    })
  })

  describe('skill-bundle-snapshot（H10 §3/§8任务3：绑 attempt/reservation 的中间事实，不参与 open-reservation/terminal 判定）', () => {
    test('走普通 append（非 closeReservationIfOpen）即可写入并读回', async () => {
      const res = makeReservation()
      const snap = makeSkillBundleSnapshot({ reservation_id: res.reservation_id, attempt_id: res.attempt_id })
      await store.append(repoRoot, res)
      await store.append(repoRoot, snap)
      const { records, rejected } = await store.read(repoRoot)
      expect(records).toEqual([res, snap])
      expect(rejected).toEqual([])
    })

    test('append 一条 skill-bundle-snapshot 不关闭其绑定的 reservation（openReservations 仍列出它）', async () => {
      const res = makeReservation()
      const snap = makeSkillBundleSnapshot({ reservation_id: res.reservation_id, attempt_id: res.attempt_id })
      await store.append(repoRoot, res)
      await store.append(repoRoot, snap)
      const w = await store.readRunWindow(repoRoot, { limit: 10 })
      expect(w.openReservations.map((r) => r.reservation_id)).toEqual([res.reservation_id])
      expect(w.runs).toEqual([]) // 未出现任何 terminal
    })

    test('readRunWindow 暴露 skillBundleSnapshots：仍开放的 reservation 关联到已产出的快照事实', async () => {
      const res = makeReservation()
      const snap = makeSkillBundleSnapshot({ reservation_id: res.reservation_id, attempt_id: res.attempt_id })
      await store.append(repoRoot, res)
      await store.append(repoRoot, snap)
      const w = await store.readRunWindow(repoRoot, { limit: 10 })
      expect(w.skillBundleSnapshots).toEqual([snap])
    })

    test('reservation 被 terminal 关闭后，其 skill-bundle-snapshot 不再出现在 readRunWindow.skillBundleSnapshots（镜像 activated 的口径）', async () => {
      const res = makeReservation()
      const snap = makeSkillBundleSnapshot({ reservation_id: res.reservation_id, attempt_id: res.attempt_id })
      await store.append(repoRoot, res)
      await store.append(repoRoot, snap)
      await store.closeReservationIfOpen(repoRoot, res.reservation_id, () =>
        makeRun({ reservation_id: res.reservation_id, attempt_id: res.attempt_id, loop_id: res.loop_id, change: res.change, skill_bundle_snapshot_sha256: snap.snapshot_sha256 }))
      const w = await store.readRunWindow(repoRoot, { limit: 10 })
      expect(w.openReservations).toEqual([])
      expect(w.skillBundleSnapshots).toEqual([])
      expect(w.runs[0]!.skill_bundle_snapshot_sha256).toBe(snap.snapshot_sha256)
    })

    test('多 loop 各自开放的 reservation：skillBundleSnapshots 随 loopId 过滤（经 openReservations 间接限定）', async () => {
      const resA = makeReservation({ loop_id: 'loop-a' })
      const resB = makeReservation({ loop_id: 'loop-b' })
      const snapA = makeSkillBundleSnapshot({ reservation_id: resA.reservation_id, attempt_id: resA.attempt_id, loop_id: resA.loop_id })
      const snapB = makeSkillBundleSnapshot({ reservation_id: resB.reservation_id, attempt_id: resB.attempt_id, loop_id: resB.loop_id })
      await store.append(repoRoot, resA)
      await store.append(repoRoot, resB)
      await store.append(repoRoot, snapA)
      await store.append(repoRoot, snapB)
      const w = await store.readRunWindow(repoRoot, { loopId: 'loop-b', limit: 10 })
      expect(w.skillBundleSnapshots).toEqual([snapB])
    })

    test('新事件不改变 open-reservation/terminal 判定：追加 skill-bundle-snapshot 前后，openReservations/runs/activated 计算结果不变', async () => {
      const resOpen = makeReservation()
      const actOpen = makeActivated({ reservation_id: resOpen.reservation_id, attempt_id: resOpen.attempt_id })
      const resClosed = makeReservation()
      await store.append(repoRoot, resOpen)
      await store.append(repoRoot, actOpen)
      await store.append(repoRoot, resClosed)
      await store.closeReservationIfOpen(repoRoot, resClosed.reservation_id, () =>
        makeRun({ reservation_id: resClosed.reservation_id, attempt_id: resClosed.attempt_id, loop_id: resClosed.loop_id, change: resClosed.change }))

      const before = await store.readRunWindow(repoRoot, { limit: 10 })
      await store.append(repoRoot, makeSkillBundleSnapshot({ reservation_id: resOpen.reservation_id, attempt_id: resOpen.attempt_id }))
      const after = await store.readRunWindow(repoRoot, { limit: 10 })

      expect(after.openReservations).toEqual(before.openReservations)
      expect(after.runs).toEqual(before.runs)
      expect(after.activated).toEqual(before.activated)
      expect(after.skillBundleSnapshots).toHaveLength(1) // 唯一变化：新增的「reservation 关联查询」字段拾到了它
    })

    test('旧账本（无 skill-bundle-snapshot kind、无 skill_bundle_snapshot_sha256 字段）原样 read，零 rejected', async () => {
      const legacyRun = makeRun()
      const legacyReservation = makeReservation()
      await mkdir(ledgerDirPath(repoRoot), { recursive: true })
      await writeFile(
        ledgerFilePath(repoRoot),
        `${encodeLedgerRecord(legacyReservation)}\n${encodeLedgerRecord(legacyRun)}\n`,
        'utf8',
      )
      const { records, rejected } = await store.read(repoRoot)
      expect(records).toEqual([legacyReservation, legacyRun])
      expect(rejected).toEqual([])
    })
  })

  describe('并发', () => {
    // 本测试面只验证**同进程** 20 路并发经由 state/lock.ts 的进程内 FIFO 锁 + O_APPEND 单次
    // 整行写聚合出的行级完整性。跨进程互斥的验收在 ledger-store.crossprocess.integration.test.ts
    // （真双子进程并发 append）；state/lock.test.ts 不起子进程，只覆盖进程内语义与锁协议细节。
    test('同进程 20 路并发 append → 零交错行、零丢失、record_id 全部唯一读回', async () => {
      const recs = Array.from({ length: 20 }, (_, i) =>
        makeUsage({ record_id: `rec-conc-${i}`, usage_id: `usage-conc-${i}` }))
      await Promise.all(recs.map((r) => store.append(repoRoot, r)))

      // 零交错：每一物理行都可独立解码
      const raw = await readFile(ledgerFilePath(repoRoot), 'utf8')
      const lines = raw.split('\n').filter((l) => l !== '')
      expect(lines).toHaveLength(20)
      for (const line of lines) expect(decodeLedgerLine(line).ok).toBe(true)

      // 零丢失 + 全唯一
      const { records, rejected } = await store.read(repoRoot)
      expect(rejected).toEqual([])
      expect(new Set(records.map((r) => r.record_id)).size).toBe(20)
      expect(new Set(records.map((r) => r.record_id))).toEqual(new Set(recs.map((r) => r.record_id)))
    }, 15_000)
  })

  describe('closeReservationIfOpen —— 幂等关闭（Stage B 返工 #1）', () => {
    const term = (res: BudgetReservationRecord, over: Partial<RunRecord> = {}): RunRecord =>
      makeRun({ reservation_id: res.reservation_id, attempt_id: res.attempt_id, loop_id: res.loop_id, change: res.change, ...over })

    test('committed：open reservation → 写一条 terminal 返回 committed', async () => {
      const res = makeReservation()
      await store.append(repoRoot, res)
      const out = await store.closeReservationIfOpen(repoRoot, res.reservation_id, () => term(res))
      expect(out.status).toBe('committed')
      const { records } = await store.read(repoRoot)
      expect(records.filter((r) => r.kind === 'run' && r.reservation_id === res.reservation_id)).toHaveLength(1)
    })

    test('already-closed：第二次幂等，不追加第二条 terminal（write+fsync 后调用方未收到返回即重试口径）', async () => {
      const res = makeReservation()
      await store.append(repoRoot, res)
      const first = await store.closeReservationIfOpen(repoRoot, res.reservation_id, () => term(res))
      const second = await store.closeReservationIfOpen(repoRoot, res.reservation_id, () => term(res))
      expect(first.status).toBe('committed')
      expect(second.status).toBe('already-closed')
      const { records } = await store.read(repoRoot)
      expect(records.filter((r) => r.kind === 'run' && r.reservation_id === res.reservation_id)).toHaveLength(1)
    })

    test('并发关同一 reservation（recovery vs settle）→ 只一条 terminal，一个 committed 一个 already-closed', async () => {
      const res = makeReservation()
      await store.append(repoRoot, res)
      const [a, b] = await Promise.all([
        store.closeReservationIfOpen(repoRoot, res.reservation_id, () => term(res, { reason: 'recovered' })),
        store.closeReservationIfOpen(repoRoot, res.reservation_id, () => term(res, { result: 'merged' })),
      ])
      expect([a.status, b.status].sort()).toEqual(['already-closed', 'committed'])
      const { records } = await store.read(repoRoot)
      expect(records.filter((r) => r.kind === 'run' && r.reservation_id === res.reservation_id)).toHaveLength(1)
    })

    test('unknown reservation → UnknownReservationError', async () => {
      await expect(store.closeReservationIfOpen(repoRoot, 'res-ghost', () => makeRun({ reservation_id: 'res-ghost' })))
        .rejects.toThrow(/不存在/)
    })

    test('create 产出关键字段不一致 → ReservationMismatchError（不落盘）', async () => {
      const res = makeReservation()
      await store.append(repoRoot, res)
      await expect(store.closeReservationIfOpen(repoRoot, res.reservation_id, () => term(res, { attempt_id: 'wrong-att' })))
        .rejects.toThrow(/不一致/)
      const { records } = await store.read(repoRoot)
      expect(records.filter((r) => r.kind === 'run')).toHaveLength(0)
    })

    test('坏尾行 → LedgerDegradedError（不猜是否已关闭，绝不追加第二 terminal）', async () => {
      const res = makeReservation()
      await store.append(repoRoot, res)
      await appendFile(ledgerFilePath(repoRoot), '{bad tail line\n', 'utf8')
      await expect(store.closeReservationIfOpen(repoRoot, res.reservation_id, () => term(res)))
        .rejects.toThrow(/坏行/)
    })

    test('普通 append 拒写带 reservation_id 的 RunRecord（须走 closeReservationIfOpen）', async () => {
      await expect(store.append(repoRoot, makeRun({ reservation_id: 'res-x' })))
        .rejects.toThrow(/closeReservationIfOpen/)
    })

    test('不带 reservation_id 的历史 RunRecord 仍可普通 append', async () => {
      await store.append(repoRoot, makeRun()) // 无 reservation_id
      const { records } = await store.read(repoRoot)
      expect(records).toHaveLength(1)
    })
  })
})
