import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useT } from '../i18n'
import { fetchTestDirections, type TestDirection } from '../api/testDirectionsClient'
import { testFromDirection } from '../workbench/workbenchDefinition'
import type { WbStepTest } from '../api/governanceTypes'

const MENU_ROW = 'min-h-10 whitespace-nowrap px-2.5 text-body'

/**
 * 测试泳道旁的「+」：从测试类型抄一份进本阶段（id 冲突加 `-2`…）。菜单走 Radix Portal，
 * 不被画布或各段的动画层叠上下文盖住；类型列表在第一次打开时才读。
 */
export function TestAddMenu({ tests, onAdd }: { tests: readonly WbStepTest[]; onAdd: (test: WbStepTest) => void }): JSX.Element {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [directions, setDirections] = useState<readonly TestDirection[]>([])

  useEffect(() => {
    if (!open || directions.length > 0) return
    const controller = new AbortController()
    void fetchTestDirections(controller.signal).then(setDirections).catch(() => setDirections([]))
    return () => controller.abort()
  }, [open, directions.length])

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="ml-auto grid size-8 flex-none place-items-center rounded-sm text-text-3 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)" aria-label={t('workflow.test_add')} title={t('workflow.test_add')} data-testid="wb-tests-add">
          <Plus className="size-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[260px]" aria-label={t('workflow.test_add')} data-testid="wb-tests-picker">
        {directions.length === 0
          ? <p className="whitespace-nowrap px-2.5 py-2 text-body text-text-3" role="status">{t('workflow.test_scope_none')}</p>
          : directions.map((direction) => (
            <DropdownMenuItem
              key={`${direction.source}/${direction.id}`}
              className={MENU_ROW}
              data-testid={`wb-tests-direction-${direction.id}`}
              onSelect={() => onAdd(testFromDirection(direction.definition, new Set(tests.map((test) => test.id))))}
            >
              <span className="truncate text-text" title={direction.label}>{direction.label}</span>
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
