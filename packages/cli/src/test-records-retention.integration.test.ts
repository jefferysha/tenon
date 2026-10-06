/**
 * 运行记录的保留上限（真机验收 F14）：记录入版本库，不设上限就随每次 `tenon test run` 增长，一次交付提交带上 27 份
 * （约 6300 行）。v1（内联步骤测试）按测试项固定留最新的 RECORD_RETENTION 条；v2（目录套件）按哈希链，清理默认关闭，
 * 用户设了 `TENON_RECORD_RETENTION=<n>` 才只留最新的 n 条。清理后的链上一个发行版（v0.2.1）读不了（它不认识
 * `chain-base` 标记，判「找不到链首记录」），所以默认不清理；清理过的链当前版本照常读写，`tenon test` 的判定不变。
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RECORD_RETENTION, RECORD_RETENTION_ENV, readRecordChain } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A' }
const SLUG = 'a-at-x.io'
const EXTRA = 3

const WORKFLOW = `name: retain
tracks:
  backend:
    steps:
      - id: build
        label: 实现
        gate: null
        skills: []
        inputs: []
        outputs: []
        tests:
          - id: probe
            direction: unit
            command: "true"
            label: 探针
            timeout_s: 60
        guards: []
        transitions:
          - event: build-done
            to: done
      - id: done
        label: 完成
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
`

describe('运行记录的保留上限', () => {
  let h: Harness
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }) })

  async function seed(): Promise<string> {
    h = await freshHarness()
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'retain.yaml'), WORKFLOW, 'utf8')
    expect(await h.run(['init', 'demo', '--track', 'backend', '--workflow', 'retain', '--preset', 'full'], { env: USER }), h.err.join('\n')).toBe(0)
    return join(h.cwd, '.tenon', 'users', SLUG, 'tests', 'demo')
  }

  async function addSmokeSuite(): Promise<void> {
    expect(await h.run([
      'test', 'catalog', 'add', 'smoke', '--kind', 'custom', '--runner', 'custom', '--command', 'true', '--report-format', 'exit-code',
    ], { env: USER }), h.err.join('\n')).toBe(0)
  }

  async function runSmoke(times: number, env: Readonly<Record<string, string>>): Promise<void> {
    for (let run = 0; run < times; run++) {
      expect(await h.run(['test', 'run', 'demo', '--suite', 'smoke'], { env }), `${h.out.join('\n')}\n${h.err.join('\n')}`).toBe(0)
    }
  }

  test('v2 目录套件：默认不清理，超过 20 次运行后记录全在、没有 chain-base 标记（上一个发行版读得了这样的链）', async () => {
    const dir = await seed()
    await addSmokeSuite()
    await runSmoke(RECORD_RETENTION + EXTRA, USER)
    const names = await readdir(dir)
    expect(names.filter((name) => name.endsWith('.json'))).toHaveLength(RECORD_RETENTION + EXTRA)
    expect(names).not.toContain('chain-base')
    const chain = await readRecordChain(h.cwd, SLUG, 'demo')
    expect(chain.state === 'intact' ? chain.active : []).toHaveLength(RECORD_RETENTION + EXTRA)
  }, 180_000)

  test('v2 目录套件：设了 TENON_RECORD_RETENTION 才清理，超过上限后只剩最新的 N 条，链完好，测试判定不受影响', async () => {
    const dir = await seed()
    await addSmokeSuite()
    const keep = { ...USER, [RECORD_RETENTION_ENV]: String(RECORD_RETENTION) }
    await runSmoke(RECORD_RETENTION + EXTRA, keep)
    const files = (await readdir(dir)).filter((name) => name.endsWith('.json'))
    expect(files).toHaveLength(RECORD_RETENTION)
    const chain = await readRecordChain(h.cwd, SLUG, 'demo')
    expect(chain.state).toBe('intact')
    expect(chain.state === 'intact' ? chain.active : []).toHaveLength(RECORD_RETENTION)
    expect(files.sort()).toEqual((chain.state === 'intact' ? chain.active : []).map((record) => `${record.run_id}.json`).sort())
    await runSmoke(1, keep)
    expect((await readRecordChain(h.cwd, SLUG, 'demo')).state).toBe('intact')
  }, 180_000)

  test('v2 目录套件：取值写错（不是正整数）时提示并按不清理处理', async () => {
    const dir = await seed()
    await addSmokeSuite()
    for (const bad of ['abc', '0', '-3', '1.5']) {
      await runSmoke(1, { ...USER, [RECORD_RETENTION_ENV]: bad })
      expect(h.err.join('\n'), bad).toContain(`${RECORD_RETENTION_ENV}=${bad} 不是正整数`)
    }
    expect((await readdir(dir)).filter((name) => name.endsWith('.json'))).toHaveLength(4)
  }, 180_000)

  test('v1 内联步骤测试：同一测试项只留最新的 N 条', async () => {
    const dir = await seed()
    for (let run = 0; run < RECORD_RETENTION + EXTRA; run++) {
      expect(await h.run(['test', 'run', 'demo', 'probe'], { env: USER }), `${h.out.join('\n')}\n${h.err.join('\n')}`).toBe(0)
    }
    expect((await readdir(dir)).filter((name) => name.endsWith('.json'))).toHaveLength(RECORD_RETENTION)
  }, 180_000)
})
