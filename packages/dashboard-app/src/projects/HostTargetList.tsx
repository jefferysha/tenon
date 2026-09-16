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
 * 宿主行（勾选要写入的宿主）+ 目标文件表（状态与受管块数）。项目页与新建项目对话框共用；
 * 对话框里不传 targets，只挑宿主。
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
      <ul className="grid gap-1" data-testid="proj-hosts">
        {hosts.map((host) => {
          const editable = host.target !== null
          const file = host.effective_file ?? host.target
          return (
            <li key={host.id}>
              <label
                className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-md px-3 py-2 whitespace-nowrap hover:bg-fill"
                data-testid={`proj-host-${host.id}`}
              >
                <input
                  type="checkbox"
                  className="size-4 accent-(--accent)"
                  checked={selected.has(host.id)}
                  disabled={!editable}
                  aria-checked={selected.has(host.id)}
                  data-testid={`proj-host-check-${host.id}`}
                  onChange={() => onToggle(host.id)}
                  hidden={!editable}
                />
                <span className="min-w-0 truncate font-mono text-caption text-text">{host.id}</span>
                <span
                  className={`font-mono text-caption ${host.effective_file !== undefined && host.effective_file !== 'AGENTS.md' ? 'text-red-d' : 'text-text-2'}`}
                  data-testid={`proj-file-${host.id}`}
                >
                  {file ?? '—'}
                </span>
                <span className="rounded-full bg-fill px-2 py-0.5 text-micro font-bold text-text-2" data-testid={`proj-levels-${host.id}`}>
                  {t(LEVELS_KEY[host.levels])}
                </span>
              </label>
            </li>
          )
        })}
      </ul>
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
