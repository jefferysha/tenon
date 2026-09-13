/**
 * DO NOT EDIT —— 生成文件。
 * 由 tools/generate-adapter-capabilities.mjs 从 adapters/registry.yaml 生成。
 * 重新生成：npm run generate:adapter-capabilities
 * 来源：adapters/registry.yaml
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
  {
    host_id: 'aider',
    registry_id: 'aider',
    tier: 'B',
    capabilities: {
      inject: 'native',
      veto: 'degraded',
      track: 'native',
    },
    veto_fail_closed: false,
  },
  {
    host_id: 'amp',
    registry_id: 'amp',
    tier: 'A',
    capabilities: {
      inject: 'native',
      veto: 'native',
      track: 'native',
    },
    veto_fail_closed: false,
  },
  {
    host_id: 'claude',
    registry_id: 'claude-code',
    tier: 'A',
    capabilities: {
      inject: 'native',
      veto: 'native',
      track: 'native',
    },
    veto_fail_closed: false,
  },
  {
    host_id: 'cline',
    registry_id: 'cline',
    tier: 'A',
    capabilities: {
      inject: 'native',
      veto: 'native',
      track: 'native',
    },
    veto_fail_closed: false,
  },
  {
    host_id: 'codex',
    registry_id: 'codex',
    tier: 'A',
    capabilities: {
      inject: 'native',
      veto: 'native',
      track: 'native',
    },
    veto_fail_closed: false,
  },
  {
    host_id: 'continue',
    registry_id: 'continue',
    tier: 'A',
    capabilities: {
      inject: 'native',
      veto: 'native',
      track: 'native',
    },
    veto_fail_closed: false,
  },
  {
    host_id: 'copilot',
    registry_id: 'copilot',
    tier: 'B',
    capabilities: {
      inject: 'degraded',
      veto: 'native',
      track: 'native',
    },
    veto_fail_closed: false,
  },
  {
    host_id: 'cursor',
    registry_id: 'cursor',
    tier: 'B',
    capabilities: {
      inject: 'degraded',
      veto: 'native',
      track: 'native',
    },
    veto_fail_closed: true,
  },
  {
    host_id: 'devin',
    registry_id: 'devin',
    tier: 'C',
    capabilities: {
      inject: 'degraded',
      veto: 'degraded',
      track: 'degraded',
    },
    veto_fail_closed: false,
  },
  {
    host_id: 'gemini',
    registry_id: 'gemini',
    tier: 'A',
    capabilities: {
      inject: 'native',
      veto: 'native',
      track: 'native',
    },
    veto_fail_closed: false,
  },
  {
    host_id: 'pi',
    registry_id: 'pi',
    tier: 'B',
    capabilities: {
      inject: 'native',
      veto: 'degraded',
      track: 'native',
    },
    veto_fail_closed: false,
  },
  {
    host_id: 'zed',
    registry_id: 'zed',
    tier: 'C',
    capabilities: {
      inject: 'degraded',
      veto: 'degraded',
      track: 'degraded',
    },
    veto_fail_closed: false,
  },
]

export const ADAPTER_CAPABILITY_BY_HOST: ReadonlyMap<string, AdapterCapabilityRow> = new Map(
  ADAPTER_CAPABILITY_ROWS.map((row) => [row.host_id, row]),
)
