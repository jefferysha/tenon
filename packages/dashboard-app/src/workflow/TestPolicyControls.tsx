import { handleRadioKey } from '../shared/radioKeyboard'

/** 与门禁分段控件（GateSegment）同一外形：fill 轨道里等宽的一排 radio，选中项是白色卡片。 */
const SEGMENT = 'inline-flex min-h-10 min-w-0 flex-1 items-center justify-center whitespace-nowrap rounded-sm px-3 text-caption font-semibold text-text-2 outline-none transition-colors duration-(--dur-fast) hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) aria-checked:bg-card aria-checked:text-text aria-checked:shadow-sm disabled:cursor-not-allowed disabled:hover:text-text-2 motion-reduce:transition-none'

/**
 * 单选：fill 轨道里的一组 radio，方向键与 Home / End 在选项间移动并即时选中。
 * `value` 为 null（没有任何选项被选中，如步骤还挂着旧策略）时第一项可 Tab 进入，其余照常。
 */
export function Choice<Id extends string>({ label, options, value, disabled, onChange, testId }: {
  label: string
  options: ReadonlyArray<{ readonly id: Id; readonly label: string }>
  value: Id | null
  disabled: boolean
  onChange: (next: Id) => void
  testId: string
}): JSX.Element {
  return (
    <div className="flex max-w-[24rem] gap-0.5 rounded-md bg-fill p-0.5" role="radiogroup" aria-label={label} data-testid={testId}>
      {options.map((option, index) => {
        const checked = option.id === value
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (value === null && index === 0) ? 0 : -1}
            disabled={disabled}
            className={SEGMENT}
            data-testid={`${testId}-${option.id}`}
            onClick={() => { if (!checked) onChange(option.id) }}
            onKeyDown={(event) => handleRadioKey(event, index, options.length, (next) => {
              const target = options[next]
              if (target !== undefined && target.id !== value) onChange(target.id)
            })}
          >
            <span className="min-w-0 truncate">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
