import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildUpstreamSkillView,
  parseSkillProvenanceRegistry,
  parseUpstreamSkillLock,
  parseUpstreamSkillRunReport,
  parseUpstreamSkillSources,
  UpstreamSkillError,
  type UpstreamSkillRunReport,
  type UpstreamSkillView,
} from '@tenon/kernel'

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function upstreamSkillRunReportPath(stateRoot: string): string {
  return join(stateRoot, 'skills', 'last-update.json')
}

/** Missing or invalid state counts as "no last run". */
export function readUpstreamSkillRunReport(stateRoot: string): UpstreamSkillRunReport | null {
  try {
    const text = readOptional(upstreamSkillRunReportPath(stateRoot))
    return text === null ? null : parseUpstreamSkillRunReport(text)
  } catch {
    return null
  }
}

/**
 * The one reader behind `tenon doctor` and `GET /api/skills/sources`: bundled registry ids, source list,
 * lock and last run of a plugin root. Throws when a present source list, lock or registry is invalid,
 * and when a lock exists without its source list. No network access.
 */
export function readUpstreamSkillView(pluginRoot: string, stateRoot: string): UpstreamSkillView {
  const registryText = readOptional(join(pluginRoot, 'templates', 'skill-sources.yaml'))
  const bundledIds = registryText === null ? [] : parseSkillProvenanceRegistry(registryText).skills.map((entry) => entry.token)
  const sourcesText = readOptional(join(pluginRoot, 'skills', 'sources.yaml'))
  const lockText = readOptional(join(pluginRoot, 'skills', 'skills.lock.json'))
  if (sourcesText === null && lockText !== null) {
    throw new UpstreamSkillError('invalid-skill-lock', 'skills/skills.lock.json 存在但缺少 skills/sources.yaml')
  }
  const sources = sourcesText === null ? null : parseUpstreamSkillSources(sourcesText)
  const lock = lockText === null || sources === null ? null : parseUpstreamSkillLock(lockText, sources)
  return buildUpstreamSkillView({ bundledIds, sources, lock, lastRun: readUpstreamSkillRunReport(stateRoot) })
}
