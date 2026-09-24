import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useT } from '../i18n'
import { cn } from '@/lib/utils'
import type { ClientOption } from './newProjectModel'

export interface ClientStepProps {
  primary: readonly ClientOption[]
  more: readonly ClientOption[]
  selected: ReadonlySet<string>
  onToggle: (id: string) => void
}

function ClientRow({ client, checked, onToggle }: { client: ClientOption; checked: boolean; onToggle: () => void }): JSX.Element {
  const id = `np-client-input-${client.id}`
  return (
    <li>
      <label htmlFor={id} className="flex min-h-10 cursor-pointer items-center gap-3 rounded-sm px-3 whitespace-nowrap transition-colors duration-(--dur-fast) hover:bg-fill">
        <input id={id} type="checkbox" className="size-4 flex-none accent-(--accent)" checked={checked} data-testid={`np-client-${client.id}`} onChange={onToggle} />
        <span className="min-w-0 flex-1 truncate text-body text-text">{client.name}</span>
        <span className="flex-none font-mono text-caption text-text-3">{client.file}</span>
      </label>
    </li>
  )
}

/** 客户端：为哪些 agent 客户端写入指令文件。本机检测到的在上面并默认勾选，其余收在「更多客户端」。 */
export function ClientStep({ primary, more, selected, onToggle }: ClientStepProps): JSX.Element {
  const { t } = useT()
  const [open, setOpen] = useState(() => more.some((client) => selected.has(client.id)))
  return (
    <div className="grid gap-2" data-testid="np-clients">
      <ul className="grid gap-0.5">
        {primary.map((client) => <ClientRow key={client.id} client={client} checked={selected.has(client.id)} onToggle={() => onToggle(client.id)} />)}
      </ul>
      {more.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls="np-clients-more"
            className="flex min-h-10 items-center gap-1.5 justify-self-start rounded-sm px-2 text-caption font-semibold whitespace-nowrap text-text-2 outline-none transition-colors duration-(--dur-fast) hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)"
            data-testid="np-clients-more-toggle"
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronRight className={cn('size-4 transition-transform duration-(--dur-fast)', open && 'rotate-90')} aria-hidden="true" />
            {t('projects.more_clients')}
          </button>
          {open && (
            <ul id="np-clients-more" className="grid gap-0.5 animate-in fade-in-0 duration-(--dur-base)" data-testid="np-clients-more">
              {more.map((client) => <ClientRow key={client.id} client={client} checked={selected.has(client.id)} onToggle={() => onToggle(client.id)} />)}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
