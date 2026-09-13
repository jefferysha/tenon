import { describe, expect, it } from 'vitest'
import {
  DEFINITION_CATALOG_EVENT_SCHEMA,
  DEFINITION_CATALOG_SCHEMA,
  PIPELINE_SELECTION_SCHEMA,
  validateDefinitionCatalogEventV1,
  validateDefinitionCatalogV1,
  validatePipelineSelectionV1,
} from './index.js'

const catalog = {
  schema_version: DEFINITION_CATALOG_SCHEMA,
  revision: '0123456789abcdef',
  fingerprint: '0123456789abcdef0123456789abcdef',
  generated_at: '2026-09-02T00:00:00.000Z',
  project: { root: '/tmp/project', identity: 'abc' },
  adapters: [{
    id: 'codex', label: 'Codex', kind: 'native', tier: 'A', cli_flag: '--codex', target_scope: 'user',
    capabilities: { inject: 'native', veto: 'native', track: 'native' }, veto_fail_closed: false,
    supported_operations: ['setup', 'update'], state: 'detected',
  }],
  workflows: [{
    id: 'default', version: 'v1', fingerprint: 'wf', source: 'builtin', readonly: true,
    steps: [{ id: 'open', label: 'Open', order: 0, gate: null, skill_ids: ['tenon-open'], skill_dependencies: { 'tenon-open': [] }, transition_events: ['open-complete'] }],
  }],
  tracks: [{ id: 'simple', label: 'Simple', builtin: true, revision: 'rev', source: 'builtin', default_workflow: 'default', allowed_workflows: '*' }],
  pipelines: [{
    id: 'default:simple', version: 'v1', fingerprint: 'pipe', source: 'builtin', workflow_id: 'default', track_id: 'simple',
    stage_order: ['open'], stages: [{ id: 'open', label: 'Open', order: 0, mode: 'serial', skill_ids: ['tenon-open'], skill_dependencies: { 'tenon-open': [] }, depends_on: [], gate: null }],
  }],
} as const

describe('definition catalog codec', () => {
  it('accepts the complete v1 projection and event envelope', () => {
    expect(validateDefinitionCatalogV1(catalog)).toBe(true)
    expect(validateDefinitionCatalogEventV1({
      schema_version: DEFINITION_CATALOG_EVENT_SCHEMA,
      kind: 'snapshot',
      revision: catalog.revision,
      fingerprint: catalog.fingerprint,
      catalog,
    })).toBe(true)
  })

  it('carries the three-state capability grades and the veto failure mode', () => {
    // degraded 必须与 none 分开：布尔协议会把两者一起报成 false，UI 因此答不出
    // 「我这个终端的 veto 是不是降级的」。
    expect(validateDefinitionCatalogV1({
      ...catalog,
      adapters: [{
        ...catalog.adapters[0],
        capabilities: { inject: 'native', veto: 'degraded', track: 'none' },
        veto_fail_closed: true,
      }],
    })).toBe(true)
  })

  it('rejects the retired boolean capability shape and an unknown grade', () => {
    // 阳性对照：旧布尔载荷必须被拒，否则「前后端同一次改完」的约束就是空话。
    expect(validateDefinitionCatalogV1({
      ...catalog,
      adapters: [{ ...catalog.adapters[0], capabilities: { inject: true, veto: true, track: true } }],
    })).toBe(false)
    expect(validateDefinitionCatalogV1({
      ...catalog,
      adapters: [{ ...catalog.adapters[0], capabilities: { ...catalog.adapters[0].capabilities, veto: 'partial' } }],
    })).toBe(false)
    expect(validateDefinitionCatalogV1({
      ...catalog,
      adapters: [{ ...catalog.adapters[0], veto_fail_closed: 'yes' }],
    })).toBe(false)
  })

  it('rejects missing nested stage dependency and unknown adapter state', () => {
    expect(validateDefinitionCatalogV1({
      ...catalog,
      adapters: [{ ...catalog.adapters[0], state: 'bogus' }],
    })).toBe(false)
    expect(validateDefinitionCatalogV1({
      ...catalog,
      pipelines: [{ ...catalog.pipelines[0], stages: [{ ...catalog.pipelines[0].stages[0], depends_on: [1] }] }],
    })).toBe(false)
  })

  it('accepts and rejects the immutable Change pipeline selection receipt', () => {
    const receipt = {
      schema_version: PIPELINE_SELECTION_SCHEMA,
      pipeline_id: 'default:simple:main', pipeline_version: '1', workflow_id: 'default',
      workflow_fingerprint: 'a'.repeat(64), track_id: 'simple', track_revision: 'r1',
      source: 'automatic', selected_at: '2026-09-02T00:00:00.000Z',
    }
    expect(validatePipelineSelectionV1(receipt)).toBe(true)
    expect(validatePipelineSelectionV1({ ...receipt, workflow_fingerprint: 'tampered' })).toBe(false)
  })
})
