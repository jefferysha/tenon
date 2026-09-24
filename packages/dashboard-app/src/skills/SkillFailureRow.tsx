import { useT } from '../i18n'
import { CommandLine } from '../shared/CommandLine'

/**
 * 上游技能在 `tenon update` 时抓取；失败后重跑对应客户端的更新即可重试。Dashboard 不知道本机装的是哪个客户端，
 * 两条都给出，复制哪条由用户决定。
 */
const FIX_COMMANDS = ['tenon update --codex', 'tenon update --claude'] as const

/** 失败行展开后的整行：原因（错误色）+ 可复制的修复命令。 */
export function SkillFailureRow({ id, reason, columns }: { id: string; reason: string; columns: number }): JSX.Element {
  const { t } = useT()
  return (
    <tr className="border-b border-border" data-testid={`skills-failure-${id}`}>
      <td colSpan={columns} className="px-3 pt-1 pb-3">
        <div className="grid gap-2">
          <p className="truncate whitespace-nowrap text-caption text-red-d" title={reason} role="alert" data-testid={`skills-failure-reason-${id}`}>{reason}</p>
          <div className="flex min-w-0 items-center gap-3" role="group" aria-label={t('skills.fix_command')}>
            {FIX_COMMANDS.map((command, index) => (
              <div key={command} className="min-w-0 max-w-[320px] flex-1">
                <CommandLine command={command} testId={`skills-fix-${id}-${index}`} />
              </div>
            ))}
          </div>
        </div>
      </td>
    </tr>
  )
}
