import { join } from 'node:path'
import type { CliDeps } from '../deps.js'
import type { RuntimeInstaller, RuntimeInstallerScope } from '../runtime/installer-contract.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import { installUpstreamSkills, type UpstreamSkillInstallResult } from '../upstream-skills/install.js'
import { renderUpstreamSkillReport, writeUpstreamSkillRunReport } from '../upstream-skills/report.js'
import type { SetupEnv } from './setup-env-types.js'

/**
 * Setup / update step between the host writing its plugin root and candidate verification: upstream
 * skills are fetched into that root, so the managed payload copies the same bytes. Previous content comes
 * only from the digest-verified active release payload. `invalid-skill-sources` propagates and aborts
 * the managed transaction before activation.
 */
export async function runUpstreamSkillInstall(
  deps: Pick<CliDeps, 'io'>,
  env: SetupEnv,
  installer: Pick<RuntimeInstaller, 'inspect'>,
  scope: RuntimeInstallerScope,
  host: 'codex' | 'claude',
  pluginRoot: string,
): Promise<UpstreamSkillInstallResult> {
  const paths = resolveRuntimePaths({ homeDir: scope.homeDir, env: scope.env })
  const inspection = await installer.inspect(scope)
  const previousRoot = inspection.activeValid && inspection.active !== null
    ? join(paths.releasesRoot, inspection.active.releaseId, 'payload')
    : null
  const install = env.installUpstreamSkills ?? installUpstreamSkills
  const result = await install({
    env,
    pluginRoot,
    previousRoot,
    host,
    workRoot: paths.stagingRoot,
    now: () => new Date().toISOString(),
    log: (line) => deps.io.out(line),
  })
  if (result.report.results.length > 0) {
    await writeUpstreamSkillRunReport(paths.stateRoot, result.report)
    for (const line of renderUpstreamSkillReport(result.report)) deps.io.out(line)
  }
  return result
}
