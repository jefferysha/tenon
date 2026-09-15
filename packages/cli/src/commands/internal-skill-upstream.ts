import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { UpstreamSkillError } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import { installUpstreamSkills } from '../upstream-skills/install.js'
import { renderUpstreamSkillReport, writeUpstreamSkillRunReport } from '../upstream-skills/report.js'
import type { SetupEnv } from './setup.js'
import { REAL_SETUP_ENV } from './setupEnvironment.js'

export interface InternalSkillUpstreamOptions {
  readonly root?: string
  readonly json?: boolean
}

export interface InternalSkillUpstreamRuntime {
  readonly env: Pick<SetupEnv, 'runCommand'>
  readonly stateRoot: string
  readonly workRoot: string
  readonly now: () => string
}

function productionRuntime(): InternalSkillUpstreamRuntime {
  const paths = resolveRuntimePaths({ homeDir: homedir(), env: { ...process.env } })
  return { env: REAL_SETUP_ENV, stateRoot: paths.stateRoot, workRoot: paths.stagingRoot, now: () => new Date().toISOString() }
}

/**
 * Hidden command behind `npm run skills:fetch`: installs upstream skills into a development checkout,
 * using the checkout itself as the previous state. Exit 0 = nothing missing, 1 = some skill missing,
 * 2 = bad invocation or invalid skills/sources.yaml.
 */
export async function cmdInternalSkillUpstream(
  deps: Pick<CliDeps, 'io'>,
  mode: string,
  options: InternalSkillUpstreamOptions,
  runtime: InternalSkillUpstreamRuntime = productionRuntime(),
): Promise<number> {
  if (mode !== 'fetch') {
    deps.io.err(`internal-skill-upstream: unsupported mode '${mode}'（支持 fetch）`)
    return 2
  }
  if (options.root === undefined || options.root.trim() === '') {
    deps.io.err('internal-skill-upstream: --root <path> 是必需参数')
    return 2
  }
  const root = resolve(options.root)
  try {
    const { report } = await installUpstreamSkills({
      env: runtime.env,
      pluginRoot: root,
      previousRoot: root,
      host: 'dev',
      workRoot: runtime.workRoot,
      now: runtime.now,
      log: options.json === true ? () => undefined : (line) => deps.io.out(line),
    })
    await writeUpstreamSkillRunReport(runtime.stateRoot, report)
    if (options.json === true) deps.io.out(JSON.stringify(report))
    else for (const line of renderUpstreamSkillReport(report)) deps.io.out(line)
    return report.results.some((result) => result.outcome === 'missing') ? 1 : 0
  } catch (error) {
    deps.io.err(`internal-skill-upstream: ${error instanceof Error ? error.message : String(error)}`)
    return error instanceof UpstreamSkillError && error.category === 'invalid-skill-sources' ? 2 : 1
  }
}
