import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { upstreamSkillRunReportPath } from '@tenon/automation'
import { serializeUpstreamSkillRunReport, type UpstreamSkillRunReport } from '@tenon/kernel'

/** Summary line printed after the per-skill `[skills]` progress lines. */
export function renderUpstreamSkillReport(report: UpstreamSkillRunReport): readonly string[] {
  if (report.results.length === 0) return []
  const count = (outcome: string): number => report.results.filter((result) => result.outcome === outcome).length
  return [
    `[skills] ${report.results.length} 个上游技能：更新 ${count('updated')}，无变化 ${count('unchanged')}，保留 ${count('kept')}，缺失 ${count('missing')}`,
  ]
}

/** `<stateRoot>/skills/last-update.json`, written atomically after every install run. */
export async function writeUpstreamSkillRunReport(stateRoot: string, report: UpstreamSkillRunReport): Promise<void> {
  const path = upstreamSkillRunReportPath(stateRoot)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomUUID()}`
  await writeFile(tmp, serializeUpstreamSkillRunReport(report), { encoding: 'utf8', mode: 0o644 })
  await rename(tmp, path)
}
