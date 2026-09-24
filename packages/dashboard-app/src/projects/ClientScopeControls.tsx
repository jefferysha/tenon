import { useT } from '../i18n'
import type { InstructionLevels } from '../api/instructionsDecoders'
import { clientName } from './clientModel'
import { SegmentTabs } from './SegmentTabs'
import type { Scope } from './useClientEditor'

const LEVELS_KEY: Record<InstructionLevels, string> = {
  joined: 'projects.levels_joined',
  'project-wins': 'projects.levels_project_wins',
  'user-wins': 'projects.levels_user_wins',
  'project-only': 'projects.levels_project_only',
  'needs-config': 'projects.levels_needs_config',
}

/**
 * 标题下一行：项目级 / 用户级 分段；用户级文件每个客户端各一份，所以共享项目级文件的一组在用户级下
 * 再给一排读者分段。没有用户级文件的组，「用户级」置灰并在 Tooltip 说明；两级怎么叠加放在「用户级」的 Tooltip。
 */
export function ClientScopeControls({ scope, onScope, userReaders, reader, onReader, levels }: {
  scope: Scope
  onScope: (next: Scope) => void
  userReaders: readonly string[]
  /** 用户级下正在编辑的客户端；项目级为 null。 */
  reader: string | null
  onReader: (clientId: string) => void
  levels: InstructionLevels | null
}): JSX.Element {
  const { t } = useT()
  const noUser = userReaders.length === 0
  return (
    <>
      <SegmentTabs
        sheets={[
          { id: 'project', label: t('projects.project_level') },
          {
            id: 'user',
            label: t('projects.user_level'),
            disabled: noUser,
            hint: noUser ? t('projects.no_user_file') : levels === null ? undefined : t('projects.load_mode_hint', { mode: t(LEVELS_KEY[levels]) }),
          },
        ]}
        active={scope}
        onChange={onScope}
        ariaLabel={t('projects.scope')}
        idPrefix="proj-scope"
        controls="proj-panel"
      />
      {reader !== null && userReaders.length > 1 && (
        <SegmentTabs
          sheets={userReaders.map((id) => ({ id, label: clientName(id) }))}
          active={reader}
          onChange={onReader}
          ariaLabel={t('projects.clients')}
          idPrefix="proj-reader"
          controls="proj-panel"
        />
      )}
    </>
  )
}
