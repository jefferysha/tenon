/** `next` 动作的形状与 `stop` 的构造——顺序表（statusStepNext.ts）与收尾（statusStepFinish.ts）共用。 */
export interface StepAction {
  readonly action: string
  readonly [key: string]: unknown
}

export function stop(code: string, message: string): readonly StepAction[] {
  return [{ action: 'stop', code, message }]
}
