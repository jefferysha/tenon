/**
 * 真实 e2e —— PM 默认流程在正常 `tenon transition` 完成 spec 后自动交给 AFK 队列。
 *
 * 这不是 scheduler 测试：断言的是 CLI adapter 真调用 post-commit 编排、真实 canonical state
 * 写入 queued，且默认 L1 只挂队不自行启动 Docker/runner。
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { freshHarness, rm, type Harness } from './integration-harness.js'

describe('真实 e2e —— PM spec-complete 自动 AFK 挂队', () => {
  let h: Harness

  beforeEach(async () => {
    h = await freshHarness()
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('正常 CLI 转换提交 spec -> build 后，PM 的独立 policy 真写 automation=queued', async () => {
    await mkdir(join(h.cwd, '.pipeline'), { recursive: true })
    await writeFile(
      join(h.cwd, '.pipeline', 'automation.json'),
      `${JSON.stringify({ version: 1, enabled: true, default_opt_in: true })}\n`,
      'utf8',
    )
    expect(await h.run(['init', 'pm-afk', '--track', 'pm', '--preset', 'full'])).toBe(0)
    await h.seedGovernedDocumentEvidence('pm-afk')
    // 此用例聚焦 post-commit AFK；复核门必须走真实 request/acknowledge receipt 路径，
    // 这样 transition 仍然只消费 canonical review gate，而不是测试手工拼装的受保护字段。
    await h.seedArtifact('pm-afk', 'design_doc', 'openspec/changes/pm-afk/design.md')
    await h.seedArtifact('pm-afk', 'phase', 'spec')
    await h.seedArtifact('pm-afk', 'plan', 'docs/superpowers/plans/pm-afk.md')
    const pmRequest = await h.run(['review', 'request', 'pm-afk', '--event', 'spec-complete'])
    expect(pmRequest, [...h.err, ...h.out].join('\n')).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'pm-afk'])).toBe(0)

    expect(await h.run(['transition', 'pm-afk', 'spec-complete'])).toBe(0)
    const state = await h.read('pm-afk')
    expect(state).toMatch(/^phase: build$/m)
    expect(state).toMatch(/^automation: queued$/m)
    expect(state).toMatch(/^automation_queued_at: 2026-07-07T00:00:00Z$/m)
    expect(h.err.join('\n')).toContain('已由 spec-complete 自动挂队')
  })

  // 自动入队只读分支的 automation.enqueue_after_spec：frontend / backend 都 eligible 但没写它，
  // 所以只能手动进 AFK，spec-complete 不会把它们挂队（产品轨才是）。
  test.each(['frontend', 'backend'])('普通 %s 默认流程仍完成 spec -> build，绝不被 PM 的自动 AFK 策略劫持', async (track) => {
    const name = `${track}-normal`
    await mkdir(join(h.cwd, '.pipeline'), { recursive: true })
    await writeFile(
      join(h.cwd, '.pipeline', 'automation.json'),
      `${JSON.stringify({ version: 1, enabled: true, default_opt_in: true })}\n`,
      'utf8',
    )
    expect(await h.run(['init', name, '--track', track, '--preset', 'full'])).toBe(0)
    await h.seedGovernedDocumentEvidence(name)
    await h.seedArtifact(name, 'design_doc', `openspec/changes/${name}/design.md`)
    await h.seedArtifact(name, 'phase', 'spec')
    await h.seedArtifact(name, 'plan', `docs/superpowers/plans/${name}.md`)
    const request = await h.run(['review', 'request', name, '--event', 'spec-complete'])
    expect(request, [...h.err, ...h.out].join('\n')).toBe(0)
    expect(await h.run(['review', 'acknowledge', name])).toBe(0)

    expect(await h.run(['transition', name, 'spec-complete'])).toBe(0)
    const state = await h.read(name)
    expect(state).toMatch(/^phase: build$/m)
    expect(state).toMatch(/^automation: off$/m)
    expect(h.err.join('\n')).not.toContain('自动挂队')
  })
})
