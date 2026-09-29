import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, Info } from 'lucide-react'
import { TEST_KINDS } from '@tenon/kernel/test-system/vocabulary'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useT } from '../i18n'
import { handleRadioKey } from '../shared/radioKeyboard'
import { INPUT } from '../shared/uiRecipes'
import { KindIcon } from '../tests/KindIcon'
import { cn } from '@/lib/utils'
import { Hint } from './Hint'
import type { Parsed } from './testPolicyEdits'

/** 一行字段：固定宽标签列（标签 + 说明图标，说明只在 Tooltip） + 控件列；永不折行。 */
export function FieldRow({ label, hint, testId, controlId, children }: {
  label: string
  hint: string
  testId: string
  controlId?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="grid min-h-12 grid-cols-[9rem_minmax(0,1fr)] items-center gap-3 border-b border-border py-1.5 last:border-0" role="group" aria-label={label} data-testid={testId}>
      <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-body text-text-2">
        {controlId === undefined ? <span className="truncate">{label}</span> : <label className="truncate" htmlFor={controlId}>{label}</label>}
        <Hint label={hint}>
          <button type="button" className="grid size-6 flex-none place-items-center rounded-sm text-text-3 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)" aria-label={`${label}: ${hint}`} data-testid={`${testId}-hint`}>
            <Info className="size-3.5" aria-hidden="true" />
          </button>
        </Hint>
      </span>
      <div className="flex min-w-0 flex-nowrap items-center gap-3">{children}</div>
    </div>
  )
}

/** 种类多选：触发钮显示已选种类（单行截断），菜单里逐项勾选；勾选不关菜单。 */
export function KindPicker({ label, value, disabled, onChange, testId }: {
  label: string
  value: readonly string[]
  disabled: boolean
  onChange: (next: string[]) => void
  testId: string
}): JSX.Element {
  const { t } = useT()
  const text = value.length === 0 ? '—' : value.join(' · ')
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex min-h-10 min-w-0 max-w-full items-center gap-2 rounded-sm border border-border-2 bg-card px-3 text-left font-mono text-body text-text outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed disabled:bg-fill disabled:text-text-3"
          aria-label={label}
          title={text}
          disabled={disabled}
          data-testid={testId}
        >
          <span className="min-w-0 truncate whitespace-nowrap">{text}</span>
          <ChevronDown className="size-4 flex-none text-text-3" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 min-w-[220px]" aria-label={t('tests.policy.hint.picker')} data-testid={`${testId}-menu`}>
        {TEST_KINDS.map((kind) => (
          <DropdownMenuCheckboxItem
            key={kind}
            checked={value.includes(kind)}
            className="min-h-9 whitespace-nowrap font-mono text-body"
            data-testid={`${testId}-option-${kind}`}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => onChange(checked ? [...value, kind] : value.filter((item) => item !== kind))}
          >
            <KindIcon kind={kind} />
            {kind}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 数字输入（百分比 / 整数上限）：文本在本地编辑，合法或清空才上报，非法只标红不上报。 */
export function NumberField({ id, label, suffix, value, parse, disabled, onCommit, testId }: {
  id: string
  label: string
  suffix?: string
  value: number | undefined
  parse: (text: string) => Parsed
  disabled: boolean
  onCommit: (value: number | undefined) => void
  testId: string
}): JSX.Element {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    const parsed = parse(text)
    const current = parsed.kind === 'value' ? parsed.value : parsed.kind === 'empty' ? undefined : null
    if (current !== value) {
      setText(value === undefined ? '' : String(value))
      setInvalid(false)
    }
    // 只在外部值变化时回填；输入过程中的中间态（非法文本）不被覆盖。
  }, [value])
  function change(next: string): void {
    setText(next)
    const parsed = parse(next)
    setInvalid(parsed.kind === 'invalid')
    if (parsed.kind === 'empty') onCommit(undefined)
    if (parsed.kind === 'value') onCommit(parsed.value)
  }
  return (
    <span className="flex flex-none items-center gap-1.5 whitespace-nowrap">
      {label !== '' && <label className="text-caption text-text-3" htmlFor={id}>{label}</label>}
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        className={cn(INPUT, 'w-20 text-right font-mono')}
        value={text}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        data-testid={testId}
        onChange={(event) => change(event.target.value)}
      />
      {suffix !== undefined && <span className="text-caption text-text-3">{suffix}</span>}
    </span>
  )
}

const SEGMENT = 'inline-flex min-h-9 items-center justify-center whitespace-nowrap rounded-sm px-3 text-caption font-semibold text-text-2 outline-none transition-colors duration-(--dur-fast) hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) aria-checked:bg-card aria-checked:text-text aria-checked:shadow-sm disabled:cursor-not-allowed disabled:hover:text-text-2'

/** 单选（范围 / 场景）：fill 轨道里的一组 radio，方向键与 Home / End 在选项间移动并即时选中。 */
export function Choice<Id extends string>({ label, options, value, disabled, onChange, testId }: {
  label: string
  options: ReadonlyArray<{ readonly id: Id; readonly label: string }>
  value: Id
  disabled: boolean
  onChange: (next: Id) => void
  testId: string
}): JSX.Element {
  return (
    <div className="inline-flex gap-0.5 rounded-md bg-fill p-0.5" role="radiogroup" aria-label={label} data-testid={testId}>
      {options.map((option, index) => {
        const checked = option.id === value
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            className={SEGMENT}
            data-testid={`${testId}-${option.id}`}
            onClick={() => { if (!checked) onChange(option.id) }}
            onKeyDown={(event) => handleRadioKey(event, index, options.length, (next) => {
              const target = options[next]
              if (target !== undefined && target.id !== value) onChange(target.id)
            })}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
