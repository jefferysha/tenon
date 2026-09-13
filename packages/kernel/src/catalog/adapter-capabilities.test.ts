import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ADAPTER_CAPABILITY_BY_HOST, ADAPTER_CAPABILITY_ROWS } from './adapter-capabilities.generated.js'

/**
 * 生成表与 adapters/registry.yaml 的对账。freshness 门禁（check:adapter-capabilities-freshness）
 * 保证生成物没被手改，本测试保证生成物的语义确实等于 registry 声明——两者缺一，
 * 「registry.yaml 是单一真源」就只是一句注释。
 *
 * 历史背景：server 曾手抄第二份 tier 表并「由 tier 推导能力」（inject 恒 true、
 * veto = tier==='A'、track = tier!=='C'）。当时全仓没有任何测试能抓住由此产生的
 * 6 处错报——两个 catalog 测试用的都是测试本地 stub，不触及真实推导。本文件补上这道守卫。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REGISTRY = join(HERE, '..', '..', '..', '..', 'adapters', 'registry.yaml')

interface RegistryPlatform {
  readonly registryId: string
  readonly cliFlag: string
  readonly tier: string
  readonly inject: string
  readonly veto: string
  readonly track: string
  readonly vetoFailClosed: boolean
}

function readRegistry(): RegistryPlatform[] {
  const text = readFileSync(REGISTRY, 'utf8')
  const platformsBody = text.slice(text.indexOf('\nplatforms:'))
  return platformsBody
    .split(/\n {2}- id: /)
    .slice(1)
    .map((block) => {
      const field = (key: string): string | undefined =>
        new RegExp(`^\\s*${key}:\\s*(\\S+)`, 'm').exec(block)?.[1]
      return {
        registryId: block.split('\n')[0]!.trim(),
        cliFlag: field('cliFlag')!,
        tier: field('tier')!,
        inject: field('inject_status')!,
        veto: field('veto_status')!,
        track: field('track_status')!,
        vetoFailClosed: field('veto_failclosed') === 'true',
      }
    })
}

describe('适配器能力矩阵 = adapters/registry.yaml', () => {
  const registry = readRegistry()

  it('registry 有内容，且平台数与生成表一致', () => {
    expect(registry.length).toBeGreaterThan(0)
    expect(ADAPTER_CAPABILITY_ROWS).toHaveLength(registry.length)
  })

  it('逐平台逐能力等于 registry 声明（连接键是 cliFlag，不是 registry id）', () => {
    for (const platform of registry) {
      const row = ADAPTER_CAPABILITY_BY_HOST.get(platform.cliFlag)
      expect(row, `registry 平台 ${platform.registryId} 在生成表中缺失`).toBeDefined()
      expect({
        registry_id: row!.registry_id,
        tier: row!.tier,
        inject: row!.capabilities.inject,
        veto: row!.capabilities.veto,
        track: row!.capabilities.track,
        veto_fail_closed: row!.veto_fail_closed,
      }).toEqual({
        registry_id: platform.registryId,
        tier: platform.tier,
        inject: platform.inject,
        veto: platform.veto,
        track: platform.track,
        veto_fail_closed: platform.vetoFailClosed,
      })
    }
  })

  it('档位字母不决定哪个能力降级——pi 是 tier B 却 inject native / veto degraded', () => {
    // 这条是「由 tier 推导能力」在原理上就错的反例；留作回归守卫。
    const pi = ADAPTER_CAPABILITY_BY_HOST.get('pi')
    expect(pi?.tier).toBe('B')
    expect(pi?.capabilities.inject).toBe('native')
    expect(pi?.capabilities.veto).toBe('degraded')
  })

  it('旧的 tier 推导会算错的那几个平台，现在与 registry 一致', () => {
    // veto = (tier === 'A') 曾把这两个的 native veto 少报成 false。
    for (const hostId of ['cursor', 'copilot']) {
      expect(ADAPTER_CAPABILITY_BY_HOST.get(hostId)?.capabilities.veto).toBe('native')
    }
    // inject 恒 true 曾把这四个降级 host 多报成 true。
    for (const hostId of ['cursor', 'copilot', 'devin', 'zed']) {
      expect(ADAPTER_CAPABILITY_BY_HOST.get(hostId)?.capabilities.inject).toBe('degraded')
    }
    // cursor 的硬拦承诺必须如实带出来。
    expect(ADAPTER_CAPABILITY_BY_HOST.get('cursor')?.veto_fail_closed).toBe(true)
  })

  it('registry id 与 TS 侧 host id 的差异被如实保留（claude-code ↔ claude）', () => {
    const claude = ADAPTER_CAPABILITY_BY_HOST.get('claude')
    expect(claude?.registry_id).toBe('claude-code')
  })
})
