#!/usr/bin/env node
/**
 * generate-adapter-capabilities.mjs —— 从 adapters/registry.yaml 生成只读 TS 数据表
 * packages/kernel/src/catalog/adapter-capabilities.generated.ts。
 *
 * 背景：registry.yaml 自称「单一真源」，但此前全仓 TypeScript 从未读过它——
 * packages/server/src/definitionCatalog.ts 手抄了第二份 tier 表，并用「由 tier 推导能力」
 * （inject 恒 true、veto = tier==='A'、track = tier!=='C'）伪造能力矩阵。这既少报了
 * cursor/copilot 的 native veto，又把 4 个降级 host 的 inject 多报成 true；而 pi（tier B
 * 却 inject native / veto degraded）证明档位字母根本不决定哪个能力降级，该推导在原理上就是错的。
 *
 * 本脚本把 registry.yaml 变成 TS 侧唯一事实来源。生成物只含规范化、稳定排序的纯数据，
 * 判定与展示逻辑留在手写层，不进生成物。零第三方依赖（只用 node: 内建），自带窄 YAML 扫描器。
 *
 * 交叉校验（fail-loud，任一违例即非零退出，不产出残缺表）：
 *   · registry 的 cliFlag 集合必须与 packages/cli/src/commands/plugin-host.ts 的 TENON_HOSTS
 *     逐一相等——这正是此前缺失的那道交叉校验（TS 侧硬编码了第二份平台清单）。
 *   · tier / <cap>_status 必须落在闭集内。
 *   · inject_status=degraded 时 inject_fallback 必填（contract.md §1 的降级声明格式）。
 *
 * 注意 id 与 cliFlag 的区别：registry 的 id 是 `claude-code`，而 TS 侧 host id 是 `claude`
 * （= registry 的 cliFlag）。连接键是 cliFlag，不是 id；两者都写进生成物以便回溯。
 *
 * 用法：node tools/generate-adapter-capabilities.mjs   # 生成/覆盖 generated 文件
 * 幂等：同一 registry.yaml 重跑产出逐字节一致（按 cliFlag 字典序稳定排序）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')
// 路径可被环境变量覆盖，便于对交叉校验做阳性对照测试（与 adapters/install.sh 认 $TENON_REGISTRY 同风格）。
const REGISTRY = process.env.TENON_REGISTRY ?? join(REPO_ROOT, 'adapters', 'registry.yaml')
const PLUGIN_HOST_TS = process.env.TENON_PLUGIN_HOST_TS ?? join(REPO_ROOT, 'packages', 'cli', 'src', 'commands', 'plugin-host.ts')
const OUT_FILE = process.env.TENON_CAPABILITIES_OUT ?? join(REPO_ROOT, 'packages', 'kernel', 'src', 'catalog', 'adapter-capabilities.generated.ts')
const SOURCE_REL = 'adapters/registry.yaml'

const TIERS = new Set(['A', 'B', 'C'])
const CAP_STATUS = new Set(['native', 'degraded', 'none'])
const CAPS = ['inject', 'veto', 'track']
/** 生成物里的 id 闭集校验——挡住会破坏 generated TS 字符串字面量的字符。 */
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/

function fail(msg) {
  throw new Error(`generate-adapter-capabilities: ${msg}`)
}

/**
 * 窄 YAML 扫描器：只认 registry.yaml 实际用到的形状——`platforms:` 下的 `- id: <v>` 列表项，
 * 每项内为两空格缩进的 `key: value` 扁平标量。不支持嵌套/锚点/多行标量（用到即 fail-loud）。
 */
function parsePlatforms(text) {
  const lines = text.split('\n')
  let inPlatforms = false
  const platforms = []
  let current = null

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '')
    if (line.trim() === '') continue

    if (/^platforms:\s*$/.test(line)) {
      inPlatforms = true
      continue
    }
    if (!inPlatforms) continue
    // 顶层新键（零缩进且非列表项）→ platforms 段结束
    if (/^\S/.test(line)) break

    const itemMatch = line.match(/^ {2}- ([A-Za-z_][A-Za-z0-9_]*): (.+)$/)
    if (itemMatch) {
      if (current) platforms.push(current)
      current = {}
      current[itemMatch[1]] = itemMatch[2].trim()
      continue
    }
    const fieldMatch = line.match(/^ {4}([A-Za-z_][A-Za-z0-9_]*): (.+)$/)
    if (fieldMatch) {
      if (!current) fail(`第 ${index + 1} 行字段不属于任何平台项`)
      current[fieldMatch[1]] = fieldMatch[2].trim()
      continue
    }
    fail(`第 ${index + 1} 行不是本扫描器支持的形状：${JSON.stringify(raw)}`)
  }
  if (current) platforms.push(current)
  if (platforms.length === 0) fail('registry.yaml 未解析到任何平台')
  return platforms
}

/** 就地读 TENON_HOSTS 闭集（单一真相源，防与 TS 侧漂移）。 */
function readTenonHosts(text) {
  const block = text.match(/export const TENON_HOSTS = \[([\s\S]*?)\] as const/)
  if (!block) fail('plugin-host.ts 未找到 TENON_HOSTS 声明')
  const hosts = [...block[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
  if (hosts.length === 0) fail('TENON_HOSTS 解析为空')
  return hosts
}

function main() {
  const platforms = parsePlatforms(readFileSync(REGISTRY, 'utf8'))
  const tenonHosts = readTenonHosts(readFileSync(PLUGIN_HOST_TS, 'utf8'))

  const rows = platforms.map((platform) => {
    const registryId = platform.id
    if (!ID_RE.test(registryId ?? '')) fail(`平台 id 非法：${JSON.stringify(registryId)}`)
    const hostId = platform.cliFlag
    if (!ID_RE.test(hostId ?? '')) fail(`${registryId} 的 cliFlag 非法：${JSON.stringify(hostId)}`)
    const tier = platform.tier
    if (!TIERS.has(tier)) fail(`${registryId} 的 tier 非法：${JSON.stringify(tier)}`)

    const capabilities = {}
    for (const cap of CAPS) {
      const status = platform[`${cap}_status`]
      if (!CAP_STATUS.has(status)) fail(`${registryId} 的 ${cap}_status 非法：${JSON.stringify(status)}`)
      capabilities[cap] = status
    }
    // contract.md §1：声明 degraded 必须给出降级落点，否则「降级」不可核查。
    if (capabilities.inject === 'degraded' && !platform.inject_fallback) {
      fail(`${registryId} 声明 inject_status=degraded 但缺 inject_fallback`)
    }
    return {
      hostId,
      registryId,
      tier,
      capabilities,
      vetoFailClosed: platform.veto_failclosed === 'true',
    }
  })

  // 交叉校验：registry cliFlag 集合 ≡ TENON_HOSTS。此前 TS 侧硬编码第二份清单且无任何对账。
  const flags = new Set(rows.map((row) => row.hostId))
  const hosts = new Set(tenonHosts)
  const onlyRegistry = [...flags].filter((id) => !hosts.has(id)).sort()
  const onlyTs = [...hosts].filter((id) => !flags.has(id)).sort()
  if (onlyRegistry.length > 0 || onlyTs.length > 0) {
    fail(
      'registry.yaml 的 cliFlag 集合与 plugin-host.ts 的 TENON_HOSTS 不一致——' +
        `仅存在于 registry：[${onlyRegistry.join(', ')}]；仅存在于 TENON_HOSTS：[${onlyTs.join(', ')}]`,
    )
  }
  if (rows.length !== flags.size) fail('registry.yaml 存在重复 cliFlag')

  rows.sort((left, right) => (left.hostId < right.hostId ? -1 : left.hostId > right.hostId ? 1 : 0))

  const entries = rows
    .map((row) => {
      const caps = CAPS.map((cap) => `      ${cap}: '${row.capabilities[cap]}',`).join('\n')
      return [
        `  {`,
        `    host_id: '${row.hostId}',`,
        `    registry_id: '${row.registryId}',`,
        `    tier: '${row.tier}',`,
        `    capabilities: {`,
        caps,
        `    },`,
        `    veto_fail_closed: ${row.vetoFailClosed},`,
        `  },`,
      ].join('\n')
    })
    .join('\n')

  const out = `/**
 * DO NOT EDIT —— 生成文件。
 * 由 tools/generate-adapter-capabilities.mjs 从 ${SOURCE_REL} 生成。
 * 重新生成：npm run generate:adapter-capabilities
 * 来源：${SOURCE_REL}
 *
 * registry.yaml 是适配器能力矩阵的单一真源。TS 侧一律读本表，禁止再手抄 tier 表或
 * 「由 tier 推导能力」——pi（tier B / inject native / veto degraded）即反例：档位字母
 * 不决定哪个能力降级。改 registry.yaml 后须重跑生成（CI freshness 门禁逐字节校验）。
 *
 * host_id 是 TS 侧使用的 id（= registry 的 cliFlag，例如 'claude'）；
 * registry_id 是 registry.yaml 里的 id（例如 'claude-code'），仅供回溯。
 */

/** 单项能力的保真度档位（contract.md §1）。 */
export type AdapterCapabilityStatus = 'native' | 'degraded' | 'none'

export interface AdapterCapabilityRow {
  readonly host_id: string
  readonly registry_id: string
  readonly tier: 'A' | 'B' | 'C'
  readonly capabilities: {
    readonly inject: AdapterCapabilityStatus
    readonly veto: AdapterCapabilityStatus
    readonly track: AdapterCapabilityStatus
  }
  /** cursor 专用：veto hook 默认 fail-open，须显式 true 才与硬拦语义一致。 */
  readonly veto_fail_closed: boolean
}

export const ADAPTER_CAPABILITY_ROWS: readonly AdapterCapabilityRow[] = [
${entries}
]

export const ADAPTER_CAPABILITY_BY_HOST: ReadonlyMap<string, AdapterCapabilityRow> = new Map(
  ADAPTER_CAPABILITY_ROWS.map((row) => [row.host_id, row]),
)
`

  writeFileSync(OUT_FILE, out, 'utf8')
  process.stdout.write(`generate-adapter-capabilities: 已写入 ${rows.length} 个平台 → ${OUT_FILE}\n`)
}

main()
