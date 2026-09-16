import { join } from 'node:path'
import type { UpstreamSkillView, UpstreamSkillViewRow } from '@tenon/kernel'
import type { DoctorProbes } from '../deps.js'
import { green, red, yellow, type DoctorCheck } from './doctor-check.js'

const CHECK_ID = 'skills:upstream'
const COLUMNS: readonly (readonly [string, number])[] = [['技能', 30], ['来源', 39], ['提交', 10], ['许可证', 12], ['更新', 21], ['状态', 0]]
const STATUS_WORD: Record<UpstreamSkillViewRow['status'], string> = { changed: '变化', unchanged: '无变化', failed: '失败', bundled: '—' }

/** The probe's view, or `null` when the probe is not wired or the source list / lock is invalid. */
export function upstreamSkillViewOf(p: DoctorProbes): UpstreamSkillView | null {
  const probed = p.upstreamSkillView?.()
  return probed === undefined || 'error' in probed ? null : probed
}

/** Upstream ids whose content is present per `skills/skills.lock.json`. */
export function lockedUpstreamSkillIds(p: DoctorProbes): string[] {
  return (upstreamSkillViewOf(p)?.rows ?? [])
    .filter((row) => row.origin === 'upstream' && row.commit !== undefined)
    .map((row) => row.id)
}

function label(row: UpstreamSkillViewRow): string {
  return row.reason === undefined ? row.id : `${row.id}(${row.reason})`
}

async function refetchCommand(p: DoctorProbes): Promise<string> {
  try {
    const host = await p.nativeRuntimeHost()
    return host === null ? 'npm run skills:fetch' : `tenon update --${host}`
  } catch {
    return 'tenon update --<host>'
  }
}

export async function checkUpstreamSkills(p: DoctorProbes): Promise<DoctorCheck> {
  const probed = p.upstreamSkillView?.()
  if (probed === undefined) return red(CHECK_ID, '上游技能探针未装配', '排除探针环境问题后重跑 tenon doctor')
  const refetch = await refetchCommand(p)
  if ('error' in probed) {
    return red(
      CHECK_ID,
      `上游技能清单无效：${probed.error}`,
      `运行 ${refetch} 重新获取；bash ${join(p.pluginRoot, 'tools', 'verify-skills.sh')} 查看 category`,
    )
  }
  const upstream = probed.rows.filter((row) => row.origin === 'upstream')
  if (upstream.length === 0) return green(CHECK_ID, '无上游技能来源清单')
  const missing = upstream.filter((row) => row.commit === undefined)
  if (missing.length > 0) {
    return red(
      CHECK_ID,
      `缺 ${missing.length} 个上游技能：${missing.map(label).join('、')}`,
      `运行 ${refetch}；缺许可证或许可证不符的技能不会安装`,
    )
  }
  const kept = upstream.filter((row) => row.status === 'failed')
  if (kept.length > 0) {
    return yellow(CHECK_ID, `${kept.length} 个上游技能获取失败，保留旧版本：${kept.map(label).join('、')}`, `网络恢复后运行 ${refetch}`)
  }
  const changed = upstream.filter((row) => row.status === 'changed').length
  return green(CHECK_ID, `${upstream.length} 个上游技能已安装，自上次更新变化 ${changed} 个`)
}

function cell(value: string, width: number): string {
  if (width === 0) return value
  return (value.length >= width ? `${value.slice(0, width - 2)}…` : value).padEnd(width)
}

/** `tenon doctor --skills`: plain padded columns, one row per skill, long values truncated. */
export function renderUpstreamSkillTable(view: UpstreamSkillView): string[] {
  const line = (values: readonly string[]): string =>
    values.map((value, index) => cell(value, COLUMNS[index]?.[1] ?? 0)).join('').trimEnd()
  return [
    line(COLUMNS.map(([header]) => header)),
    ...view.rows.map((row) => line([
      row.id,
      row.origin === 'tenon' ? 'tenon' : `${row.repo ?? ''}:${row.path ?? ''}`,
      row.commit?.slice(0, 7) ?? '—',
      row.license ?? '—',
      row.fetchedAt === undefined ? '—' : row.fetchedAt.slice(0, 16).replace('T', ' '),
      row.status === 'failed' && row.reason !== undefined ? `失败 ${row.reason}` : STATUS_WORD[row.status],
    ])),
  ]
}
