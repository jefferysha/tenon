/** Production check behind loop activation: the candidate registry's loop must have a ready skill/runner wiring. */
import { join } from 'node:path'
import type { EffectiveSkillResolver, ExtendedManifestData } from '@tenon/kernel'
import { createRunnerSkillContentLocator, evaluateLoopExecutionWiring } from '@tenon/automation'
import type { LoopActivationValidator } from './loops.js'
import { repoRootForSkills } from './serverSupport.js'

export interface LoopActivationWiringDeps {
  readonly manifest: ExtendedManifestData
  readonly hostHome: string
  /** Skill profiles the Track Registry may name besides `_all`. */
  readonly trackSkillProfiles: ReadonlySet<string>
  /** Resolved lazily per request: the workflow root anchor is only known once the server is wired. */
  readonly resolverForRoot: (root: string, manifest: ExtendedManifestData) => EffectiveSkillResolver
}

export function createLoopActivationValidator(deps: LoopActivationWiringDeps): LoopActivationValidator {
  return async ({ root, loopId, candidate }) => {
    const loop = candidate.loops.find((entry) => entry.id === loopId)
    if (loop === undefined) return { ok: false, error: `候选 registry 中找不到 loop "${loopId}"` }
    const resolver = deps.resolverForRoot(root, deps.manifest)
    const wiringForRunner = (runner: string) => ({
      resolver,
      locator: createRunnerSkillContentLocator({
        runner,
        home: deps.hostHome,
        bundledRoot: join(repoRootForSkills(), 'skills'),
      }),
      isSkillProfileKnown: (profileId: string) => profileId === '_all' || deps.trackSkillProfiles.has(profileId),
    })
    const wiring = await evaluateLoopExecutionWiring(loop, candidate.loops, {
      repoRoot: root,
      skillBundleWiring: wiringForRunner(loop.runner),
      skillBundleWiringForLoop: (entry) => wiringForRunner(entry.runner),
    })
    return wiring.status === 'ready'
      ? { ok: true }
      : { ok: false, error: `${wiring.dimension}: ${wiring.reason}` }
  }
}
