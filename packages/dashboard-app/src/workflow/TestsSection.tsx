import { useEffect, useState } from 'react'
import { Check, Plus } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useT } from '../i18n'
import { fetchTestDirections, type TestDirection } from '../api/testDirectionsClient'
import { testFromDirection } from '../workbench/workbenchDefinition'
import type { WbStepTest } from '../api/governanceTypes'

const HEAD_ACTION = 'inline-flex items-center gap-1.5 whitespace-nowrap text-body text-text-2 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)'
const MENU_ROW = 'min-h-10 whitespace-nowrap px-2.5 text-body'

/**
 * 工作流页的测试段：一行一项测试，`+` 从测试类型抄一份进本步骤，点行开编辑抽屉。菜单走 Radix Portal，
 * 不被下方画布或各段的动画层叠上下文盖住。
 */
export function TestsSection({
  tests,
  editable,
  onAdd,
  onOpen,
}: {
  tests: readonly WbStepTest[]
  editable: boolean
  onAdd: (test: WbStepTest) => void
  onOpen: (id: string) => void
}): JSX.Element {
  const { t } = useT()
  const [picker, setPicker] = useState(false)
  const [directions, setDirections] = useState<readonly TestDirection[]>([])

  useEffect(() => {
    if (!picker || directions.length > 0) return
    const controller = new AbortController()
    void fetchTestDirections(controller.signal).then(setDirections).catch(() => setDirections([]))
    return () => controller.abort()
  }, [picker, directions.length])

  return (
    <section className="grid gap-3.5 py-6" data-testid="stage-tests">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-title font-semibold text-text">
          {t('workflow.tests_title')}
          <span className="ml-2 font-mono text-caption font-normal text-text-3">{tests.length}</span>
        </h2>
        {editable && (
          <DropdownMenu modal={false} open={picker} onOpenChange={setPicker}>
            <DropdownMenuTrigger asChild>
              <button type="button" className={HEAD_ACTION} data-testid="wb-tests-add">
                <Plus className="size-3.5" aria-hidden="true" />
                {t('workflow.test_add')}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[260px]" aria-label={t('workflow.test_add')} data-testid="wb-tests-picker">
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
        )}
      </div>
      <table className="w-full border-collapse text-left" data-testid="wb-tests">
        <thead>
          <tr className="border-b border-border text-caption text-text-3">
            <th className="whitespace-nowrap py-2 font-normal">{t('workflow.test_label')}</th>
            <th className="whitespace-nowrap py-2 font-normal">{t('workflow.test_direction')}</th>
            <th className="whitespace-nowrap py-2 font-normal">{t('workflow.test_command')}</th>
            <th className="whitespace-nowrap py-2 font-normal">{t('workflow.test_required')}</th>
          </tr>
        </thead>
        <tbody>
          {tests.map((test) => (
            <tr
              key={test.id}
              className="cursor-pointer border-b border-border last:border-0 hover:bg-fill"
              data-testid={`wb-test-${test.id}`}
              onClick={() => onOpen(test.id)}
            >
              <td className="max-w-[12rem] truncate py-2.5 text-body text-text">{test.label ?? test.id}</td>
              <td className="whitespace-nowrap py-2.5 font-mono text-caption text-text-2">{test.direction}</td>
              <td className="max-w-[20rem] truncate py-2.5 font-mono text-caption text-text-2">{test.command}</td>
              <td className="py-2.5">
                {test.required !== false && <Check className="size-3.5 text-(--accent)" aria-label={t('workflow.test_required')} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
