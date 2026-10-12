import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadManifest, type ExtendedManifestData } from '@tenon/kernel'
import { createManifestSkillActionAuthorityResolver } from './skill-action-authority-provider.js'

const query = {
  change: 'change-a',
  skillBundleId: 'backend',
  workflowRunId: 'run-a',
  workflowFingerprint: 'fingerprint-a',
}

function manifest(grants: { _all?: readonly ['enter-afk'] } | null) {
  return {
    skillActionAuthority: grants ? { version: 'v1', grants } : null,
  } as Pick<ExtendedManifestData, 'skillActionAuthority'>
}

describe('createManifestSkillActionAuthorityResolver', () => {
  it('emits the closed manifest grant bound to the exact query identity', async () => {
    const resolve = createManifestSkillActionAuthorityResolver(manifest({ _all: ['enter-afk'] }), () => true)
    await expect(resolve(query)).resolves.toEqual({
      version: 'v1',
      skill_bundle_id: 'backend',
      workflow_run_id: 'run-a',
      workflow_fingerprint: 'fingerprint-a',
      grants: ['enter-afk'],
    })
  })

  it('fails closed for missing authority and unknown profile', async () => {
    await expect(createManifestSkillActionAuthorityResolver(manifest(null), () => true)(query)).resolves.toBeUndefined()
    await expect(createManifestSkillActionAuthorityResolver(manifest({ _all: ['enter-afk'] }), () => false)(query)).resolves.toBeUndefined()
  })
})

describe('shipped templates/manifest.yaml skill_action_authority', () => {
  const shipped = loadManifest(join(process.cwd(), 'templates', 'manifest.yaml'))

  it('不分 profile：只有一条全局授权，不再按 pm / frontend / backend / free 逐个列', () => {
    expect(shipped.skillActionAuthority).toEqual({ version: 'v1', grants: { _all: ['enter-afk'] } })
  })

  it.each(['backend', 'pm', 'frontend', 'lite', 'ops-custom', '_all'])('任何已知 skill profile「%s」都拿到同一份 enter-afk 授权', async (profile) => {
    const resolve = createManifestSkillActionAuthorityResolver(shipped, () => true)
    await expect(resolve({ ...query, skillBundleId: profile })).resolves.toMatchObject({
      skill_bundle_id: profile,
      grants: ['enter-afk'],
    })
  })

  it('未知 profile 仍然失败关闭', async () => {
    const resolve = createManifestSkillActionAuthorityResolver(shipped, () => false)
    await expect(resolve({ ...query, skillBundleId: 'ghost' })).resolves.toBeUndefined()
  })
})
