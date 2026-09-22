/**
 * 真实 e2e —— 并发 transition 不再产生逆序 breadcrumb/history（W1 第二增量收口，
 * codex 2026-07-16 范围评估指定的送审停止线测试）。
 *
 * 复现的正是此前的真实缺陷：breadcrumb/history/marker 曾经在 store.withLock 锁外写，
 * 若第一次 transition 的尾部写入被拖慢，第二次 transition 可能在锁内抢先完成整个转换
 * （state 已提交到更新的相位），随后第一次转换姗姗来迟的尾部写入才落盘，用**旧相位**覆盖
 * 掉本该反映最新相位的 breadcrumb——hook 热路径因此读到过期相位。
 *
 * runRepo.transact 把锁的持有范围扩大到整个 callback（含 breadcrumb/history），
 * 这里直接验证：即使第一次 transition 的 breadcrumb 写入被人为阻塞，第二次 transition
 * 也必须等第一次完全结束（含它的 breadcrumb 写入）才能开始，因此不可能发生覆盖。
 */
import { join } from 'node:path'
import { appendFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { cmdTransition } from './commands/transition.js'
import { freshHarness, realDeps, recordWorkflowPhaseSkill, rm } from './integration-harness.js'

describe('真实 e2e —— 并发 transition 尾部写入严格串行（不逆序覆盖）', () => {
  test('第一次 transition 的 breadcrumb 写入被阻塞期间，第二次 transition 无法抢先完成；' +
    '释放后第二次先被 review receipt 拒绝，确认后重发才写入最新 breadcrumb/state', async () => {
    const h = await freshHarness()
    try {
      expect(await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])).toBe(0)
      await h.seedGovernedDocumentEvidence('demo')
      // explore-complete 的前置（design_doc 非空且文件存在）从一开始就满足，后续两次 transition
      // 之间不需要再插入任何 set 步骤。
      // Reuse the hash-bound OpenSpec design seeded above. Rewriting it would correctly make
      // explore->spec fail before this test reaches its serialization assertion.
      await h.seedArtifact('demo', 'design_doc', 'openspec/changes/demo/design.md')
      // The first transition exits the initial open visit; satisfy its frozen Workflow-owned
      // phase Skill through the production tracker hook before exercising breadcrumb locking.
      await recordWorkflowPhaseSkill(h.cwd, join(h.cwd, 'openspec', 'changes', 'demo'))
      const historyPath = join(h.cwd, 'openspec', 'changes', 'demo', '.pipeline-history.jsonl')
      const recordSkills = async (...skills: string[]): Promise<void> => {
        await appendFile(
          historyPath,
          `${skills.map((skill) => JSON.stringify({ kind: 'tool', raw: `Skill: ${skill}` })).join('\n')}\n`,
          'utf8',
        )
      }
      await recordSkills('openspec-propose')

      const out: string[] = []
      const err: string[] = []
      const deps = realDeps(h.cwd, out, err)
      const realWriteBreadcrumb = deps.writeBreadcrumb!

      let releaseFirst: () => void = () => {}
      const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
      let markFirstEntered: () => void = () => {}
      const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve })
      const order: string[] = []
      let firstBreadcrumbSeen = false
      deps.writeBreadcrumb = async (changeDir, content) => {
        if (!firstBreadcrumbSeen) {
          // 只阻塞第一次调用（open-complete 落 phase=explore 那次），第二次调用（explore-complete
          // 落 phase=spec）不阻塞——否则测试本身会死锁。
          firstBreadcrumbSeen = true
          order.push('first-breadcrumb-blocked')
          markFirstEntered()
          await firstBlocked
        }
        order.push(`breadcrumb:${content.trim()}`)
        await realWriteBreadcrumb(changeDir, content)
      }

      const p1 = cmdTransition(deps, 'demo', 'open-complete')
      // 等待真实观察点，不用固定 sleep 猜 canonical revision/hash 写入在当前机器上要多久。
      await firstEntered
      expect(order).toEqual(['first-breadcrumb-blocked']) // 确认真的卡住了，不是提前跑完

      // p1 has committed the explore visit while its breadcrumb tail is blocked.  Record the
      // phase Skill for that exact visit before p2 acquires the lock, so p2 reaches its intended
      // review-receipt assertion rather than failing earlier on the phase gate.
      await recordWorkflowPhaseSkill(h.cwd, join(h.cwd, 'openspec', 'changes', 'demo'))

      const p2 = cmdTransition(deps, 'demo', 'explore-complete')
      // 给 p2 一点时间——它应该被锁挡住，不该跑到它自己的 breadcrumb 写入
      await new Promise((r) => setTimeout(r, 30))
      expect(order).toEqual(['first-breadcrumb-blocked']) // p2 仍未进入（被锁挡住，不是碰巧慢）

      releaseFirst()
      const [code1, code2] = await Promise.all([p1, p2])
      expect(code1).toBe(0)
      expect(code2).toBe(2)
      // 严格按序：第二次只能在第一次 breadcrumb 收尾后读到 explore；未获确认时不写自己的 breadcrumb。
      expect(order).toEqual(['first-breadcrumb-blocked', 'breadcrumb:pipeline:demo phase=explore'])

      await recordSkills('openspec-explore', 'brainstorming', 'grilling', 'domain-modeling', 'codebase-design')
      expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
      expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
      expect(await cmdTransition(deps, 'demo', 'explore-complete')).toBe(0)
      expect(order).toEqual([
        'first-breadcrumb-blocked',
        'breadcrumb:pipeline:demo phase=explore',
        'breadcrumb:pipeline:demo phase=spec',
      ])

      // 最终真相：state/breadcrumb 一致反映最新相位 spec，没有被 stale 尾部覆盖。
      expect(await h.read('demo')).toMatch(/^phase: spec$/m)
      expect(await h.readIn('demo', '.breadcrumb')).toContain('phase=spec')
    } finally {
      await rm(h.cwd, { recursive: true, force: true })
    }
  })
})
