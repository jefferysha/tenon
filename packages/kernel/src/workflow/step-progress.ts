/**
 * 终端步骤清单：把冻结计划的步骤顺序推算成一行 `标签 ✓ → 标签 ● → 标签 ○`。
 *
 * 纯函数：只按数组顺序判定，当前步之前 ✓、当前步 ●、之后 ○；任务已归档则全部 ✓；
 * current 不在步骤里（或为空）则全部 ○。回退到更早的步骤时，后续步显示为 ○，这是预期行为。
 */
export function stepProgressLine(
  steps: readonly { readonly id: string; readonly label: string }[],
  current: string,
  archived: boolean,
): string {
  const currentIndex = steps.findIndex((step) => step.id === current)
  return steps
    .map((step, index) => {
      const mark = archived || (currentIndex !== -1 && index < currentIndex)
        ? '✓'
        : index === currentIndex
          ? '●'
          : '○'
      return `${step.label} ${mark}`
    })
    .join(' → ')
}
