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
      {/* 等分表：宿主 · 文件 · 加载方式；勾选列固定宽度，不可勾选的宿主放禁用的复选框占位，列不跳。 */}
      <table className="w-full table-fixed border-collapse text-caption" data-testid="proj-hosts">
        <colgroup>
          <col className="w-10" />
          <col />
          <col />
          <col />
        </colgroup>
        <thead>
          <tr className="border-b border-border text-text-3">
            <th scope="col" className="py-2"><span className="sr-only">{t('projects.select')}</span></th>
            <th scope="col" className="py-2 text-left font-semibold whitespace-nowrap">{t('projects.hosts')}</th>
            <th scope="col" className="py-2 text-left font-semibold whitespace-nowrap">{t('projects.file')}</th>
            <th scope="col" className="py-2 text-left font-semibold whitespace-nowrap">{t('projects.load_mode')}</th>
          </tr>
        </thead>
        <tbody>
          {hosts.map((host) => {
            const editable = host.target !== null
            const file = host.effective_file ?? host.target
            const checkId = `proj-host-check-input-${host.id}`
            return (
              <tr key={host.id} className="border-b border-border hover:bg-fill" data-testid={`proj-host-${host.id}`}>
                <td className="py-2 text-center">
                  <input
                    id={checkId}
                    type="checkbox"
                    className="size-4 align-middle accent-(--accent) disabled:cursor-not-allowed disabled:opacity-40"
                    checked={editable && selected.has(host.id)}
                    disabled={!editable}
                    data-testid={`proj-host-check-${host.id}`}
                    onChange={() => onToggle(host.id)}
                  />
                </td>
                <td className="truncate py-2 whitespace-nowrap">
                  <label htmlFor={checkId} className={`font-mono text-text ${editable ? 'cursor-pointer' : 'text-text-3'}`}>{host.id}</label>
                </td>
                <td
                  className={`truncate py-2 font-mono whitespace-nowrap ${host.effective_file !== undefined && host.effective_file !== 'AGENTS.md' ? 'text-red-d' : 'text-text-2'}`}
                  title={file ?? undefined}
                  data-testid={`proj-file-${host.id}`}
                >
                  {file ?? '—'}
                </td>
                <td className="truncate py-2 whitespace-nowrap text-text-2" data-testid={`proj-levels-${host.id}`}>
                  {t(LEVELS_KEY[host.levels])}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {targets !== undefined && (
        <table className="w-full table-fixed border-collapse text-base" data-testid="proj-files">
          <thead>
            <tr className="border-b border-border text-caption text-text-3">
              <th scope="col" className="py-2 text-left font-semibold">{t('projects.file')}</th>
              <th scope="col" className="py-2 text-left font-semibold">{t('projects.status')}</th>
              <th scope="col" className="py-2 text-left font-semibold">{t('projects.managed')}</th>
              <th scope="col" className="py-2 text-left font-semibold">{t('projects.load')}</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((target) => {
              const status = fileStatus(target, editorText ?? '')
              return (
                <tr key={target.id} className="border-b border-border" data-testid={`proj-file-row-${target.id}`}>
                  <td className="py-2 font-mono text-caption whitespace-nowrap text-text">
                    {target.id}
                    {target.bytes > CODEX_MAX_BYTES && (
                      <span className="ml-2 rounded-full bg-red-t px-2 py-0.5 text-micro font-bold text-red-d" data-testid={`proj-size-${target.id}`}>32KiB</span>
                    )}
                  </td>
                  <td className="py-2 text-caption whitespace-nowrap text-text-2" data-testid={`proj-status-${target.id}`}>
                    {t(STATUS_KEY[status])}
                  </td>
                  <td className="py-2 font-mono text-caption text-text-2">{target.managed.length}</td>
                  <td className="py-2">
                    {target.exists && target.error === null && onLoad !== undefined && (
                      <button
                        type="button"
                        className="cursor-pointer rounded-sm px-2 py-1 text-caption font-semibold text-accent-d hover:bg-accent-t"
                        data-testid={`proj-load-${target.id}`}
                        onClick={() => onLoad(target.id)}
                      >
                        {t('projects.load')}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
