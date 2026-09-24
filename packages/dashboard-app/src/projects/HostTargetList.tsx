import { FileInput } from 'lucide-react'
import { useT } from '../i18n'
import type { InstructionHostRow, InstructionTarget } from '../api/instructionsDecoders'
import { CODEX_MAX_BYTES, fileStatus } from './instructionModel'

const LEVELS_KEY: Record<InstructionHostRow['levels'], string> = {
  joined: 'projects.levels_joined',
  'project-wins': 'projects.levels_project_wins',
  'user-wins': 'projects.levels_user_wins',
  'project-only': 'projects.levels_project_only',
  'needs-config': 'projects.levels_needs_config',
}

const STATUS_KEY = {
  missing: 'projects.status_missing',
  same: 'projects.status_same',
  different: 'projects.status_different',
  error: 'projects.status_error',
} as const

const HEAD_ROW = 'h-10 border-b border-border'
const HEAD_CELL = 'truncate text-left font-semibold whitespace-nowrap'
const ROW = 'h-10 border-b border-border'
const CELL = 'truncate whitespace-nowrap'

/** 两表共用的列宽：40px 前导列 + 三等分。 */
function TableColumns(): JSX.Element {
  return (
    <colgroup>
      <col className="w-10" />
      <col />
      <col />
      <col />
    </colgroup>
  )
}

/**
 * 宿主表（勾选要写入的宿主；宿主 · 文件 · 加载方式）+ 目标文件表（状态与受管块数）。
 * 不传 targets 时只渲染宿主表。
 */
export function HostTargetList({
  hosts, targets, selected, onToggle, onLoad, editorText,
}: {
  hosts: readonly InstructionHostRow[]
  targets?: readonly InstructionTarget[]
  selected: ReadonlySet<string>
  onToggle: (hostId: string) => void
  onLoad?: (targetId: string) => void
  editorText?: string
}): JSX.Element {
  const { t } = useT()
  return (
    <div className="grid gap-4">
      {/* 两表同一套列：40px 前导列（勾选 / 载入）+ 三等分；行高 40。只有宿主 id 与文件名用等宽。 */}
      <table className="w-full table-fixed border-collapse text-caption" data-testid="proj-hosts">
        <TableColumns />
        <thead>
          <tr className={`${HEAD_ROW} text-text-3`}>
            <th scope="col"><span className="sr-only">{t('projects.select')}</span></th>
            <th scope="col" className={HEAD_CELL}>{t('projects.hosts')}</th>
            <th scope="col" className={HEAD_CELL}>{t('projects.file')}</th>
            <th scope="col" className={HEAD_CELL}>{t('projects.load_mode')}</th>
          </tr>
        </thead>
        <tbody>
          {hosts.map((host) => {
            const editable = host.target !== null
            const file = host.effective_file ?? host.target
            const checkId = `proj-host-check-input-${host.id}`
            return (
              <tr key={host.id} className={`${ROW} hover:bg-fill`} data-testid={`proj-host-${host.id}`} data-editable={editable}>
                <td className="text-center">
                  {/* 不可勾选的宿主：虚线框占位，列不跳、也不读作「未勾选」。 */}
                  <input
                    id={checkId}
                    type="checkbox"
                    className="size-4 align-middle accent-(--accent) disabled:cursor-not-allowed disabled:appearance-none disabled:rounded-xs disabled:border disabled:border-dashed disabled:border-border-2"
                    checked={editable && selected.has(host.id)}
                    disabled={!editable}
                    data-testid={`proj-host-check-${host.id}`}
                    onChange={() => onToggle(host.id)}
                  />
                </td>
                <td className={CELL}>
                  <label htmlFor={checkId} className={`font-mono ${editable ? 'cursor-pointer text-text' : 'text-text-3'}`}>{host.id}</label>
                </td>
                <td
                  className={`${CELL} font-mono ${host.effective_file !== undefined && host.effective_file !== 'AGENTS.md' ? 'text-red-d' : 'text-text-2'}`}
                  title={file ?? undefined}
                  data-testid={`proj-file-${host.id}`}
                >
                  {file ?? '—'}
                </td>
                <td className={`${CELL} text-text-2`} data-testid={`proj-levels-${host.id}`}>
                  {t(LEVELS_KEY[host.levels])}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {targets !== undefined && (
        <table className="w-full table-fixed border-collapse text-caption" data-testid="proj-files">
          <TableColumns />
          <thead>
            <tr className={`${HEAD_ROW} text-text-3`}>
              <th scope="col"><span className="sr-only">{t('projects.load')}</span></th>
              <th scope="col" className={HEAD_CELL}>{t('projects.file')}</th>
              <th scope="col" className={HEAD_CELL}>{t('projects.status')}</th>
              <th scope="col" className={HEAD_CELL}>{t('projects.managed')}</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((target) => {
              const status = fileStatus(target, editorText ?? '')
              return (
                <tr key={target.id} className={ROW} data-testid={`proj-file-row-${target.id}`}>
                  <td className="text-center">
                    {target.exists && target.error === null && onLoad !== undefined && (
                      <button
                        type="button"
                        className="inline-grid size-8 place-items-center rounded-sm align-middle text-text-3 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)"
                        aria-label={`${t('projects.load')} ${target.id}`}
                        title={t('projects.load')}
                        data-testid={`proj-load-${target.id}`}
                        onClick={() => onLoad(target.id)}
                      >
                        <FileInput className="size-4" aria-hidden="true" />
                      </button>
                    )}
                  </td>
                  <td className={`${CELL} font-mono text-text`} title={target.id}>
                    {target.id}
                    {target.bytes > CODEX_MAX_BYTES && (
                      <span className="ml-2 rounded-full bg-red-t px-2 py-0.5 font-sans text-micro font-bold text-red-d" data-testid={`proj-size-${target.id}`}>32KiB</span>
                    )}
                  </td>
                  <td className={`${CELL} text-text-2`} data-testid={`proj-status-${target.id}`}>
                    {t(STATUS_KEY[status])}
                  </td>
                  <td className={`${CELL} tabular-nums text-text-2`} data-testid={`proj-managed-${target.id}`}>{target.managed.length}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
