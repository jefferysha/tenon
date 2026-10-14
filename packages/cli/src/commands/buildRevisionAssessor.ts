import {
  assessBuildRevisionTrust,
  expectedBuildRevisionKind,
  probeBuildRevisionIdentity,
  readValidatedTransitionHead,
  safeRevisionHash,
} from '@tenon/kernel'
import type { TransitionContext } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'

/**
 * Resolve the production revision assessor once for all CLI read/write paths.
 *
 * The injected assessor remains authoritative in tests and in server adapters.  The fallback only
 * binds the CLI's physical identity, current HEAD/workspace observation, and canonical transition
 * provenance; it deliberately does not decode a build token into a raw revision.
 */
export function resolveBuildRevisionAssessor(
  deps: CliDeps,
  changeName: string,
  changeDir: string,
): NonNullable<TransitionContext['assessBuildRevision']> {
  if (deps.assessBuildRevision !== undefined) return deps.assessBuildRevision
  return async (request) => {
    const identity = deps.buildRevisionIdentity === undefined
      ? await probeBuildRevisionIdentity(deps.cwd)
      : await deps.buildRevisionIdentity()
    const observe = async () => {
      const kind = expectedBuildRevisionKind(request.isolation)
      const revision = kind === 'workspace'
        ? await deps.workspaceFingerprint?.(changeName) ?? ''
        : await deps.gitHeadSha?.() ?? ''
      if (!identity) throw new Error('build revision identity unavailable')
      return { kind, revision, identity }
    }
    const provenance = async () => {
      const validated = await readValidatedTransitionHead(changeDir)
      if (!validated) return undefined
      const { current, record } = validated
      const stateBuildSha = current.state.fields.build_sha
      return {
        currentStep: String(current.state.fields.phase ?? ''),
        stateHash: safeRevisionHash(current.state.fields),
        stateBuildSha: Array.isArray(stateBuildSha) ? stateBuildSha.join(',') : stateBuildSha,
        recordTo: record.to,
        buildShaEffects: record.effects
          .filter((effect) => effect.field === 'build_sha')
          .map((effect) => typeof effect.to === 'string' ? effect.to : ''),
      }
    }
    return assessBuildRevisionTrust({ ...request, observe, provenance })
  }
}
