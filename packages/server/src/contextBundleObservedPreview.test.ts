/**
 * 观察模式预览的账本接线：交接输入与本访问的读取回执（真账本、真 git 仓库、真转换）经 `observedBundleRepository` 对齐成
 * 编译器要核对的事实，再交给 kernel 的真编译器。源文件读取用最朴素的 fs 端口——路径信任由 trusted reader 的测试钉住。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compileObservedContextBundleWithPorts, nodeLedgerContextBundlePrimitives, recordInputReads, stepOutputsContextFor,
} from '@tenon/kernel'
import { observedBundleRepository } from './contextBundleObservedPreview.js'
import { finishObservedExplore, observedExploreTask, OBSERVED_CHANGE, OBSERVED_DESIGN } from './test-support.js'

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

describe('observedBundleRepository', () => {
  it('交接输入带上游步骤与来源技能；读取回执的摘要逐个对齐，没读时为空，读过之后就是当前内容的摘要', async () => {
    const task = await observedExploreTask()
    expect(await finishObservedExplore(task)).toBe(200)
    const ctx = { root: task.root, changeDir: task.changeDir, change: OBSERVED_CHANGE }
    const digest = sha(await readFile(join(task.root, OBSERVED_DESIGN), 'utf8'))

    expect(await observedBundleRepository(ctx).read()).toEqual({
      step: 'spec',
      sources: [{ path: OBSERVED_DESIGN, fromStep: 'explore', skill: 'brainstorming', recordedSha256: digest, readSha256s: [] }],
    })

    await recordInputReads(stepOutputsContextFor(task.changeDir), 'all', '2026-10-12T00:00:00Z')
    expect((await observedBundleRepository(ctx).read()).sources.map((source) => source.readSha256s)).toEqual([[digest]])
  })

  it('接上真编译器：包的输入恰好是当前步骤的交接文档，原因点名上游步骤', async () => {
    const task = await observedExploreTask()
    await finishObservedExplore(task)
    const result = await compileObservedContextBundleWithPorts({
      root: task.root,
      change: OBSERVED_CHANGE,
      from: 'explore',
      target: 'spec',
      repository: observedBundleRepository({ root: task.root, changeDir: task.changeDir, change: OBSERVED_CHANGE }),
      sourceReader: {
        read: async (path) => {
          const text = await readFile(join(task.root, path), 'utf8')
          return { text, sourceBytes: Buffer.byteLength(text, 'utf8') }
        },
      },
      primitives: nodeLedgerContextBundlePrimitives,
    })

    expect(result.bundle.inputs.map((input) => [input.path, input.reason])).toEqual([[OBSERVED_DESIGN, 'explore 的产出']])
    expect(result.preview.inputs.map((input) => [input.fromStep, input.skill])).toEqual([['explore', 'brainstorming']])
  })

  it('任务停在第一步（没有上游访问）：没有输入', async () => {
    const task = await observedExploreTask({ git: false })
    expect(await observedBundleRepository({ root: task.root, changeDir: task.changeDir, change: OBSERVED_CHANGE }).read())
      .toEqual({ step: 'explore', sources: [] })
  })
})
