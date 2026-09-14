export interface ReviewStepEvents {
  readonly phase: string
  readonly events: readonly string[]
}

export function resolveReviewEvent(step: ReviewStepEvents, requestedEvent: string | undefined): string {
  if (requestedEvent !== undefined) {
    if (!step.events.includes(requestedEvent)) {
      throw new Error(
        `phase '${step.phase}' 不支持 review event '${requestedEvent}'；可选：${step.events.join(', ') || '(无)'}`,
      )
    }
    return requestedEvent
  }
  if (step.events.length !== 1) {
    throw new Error(
      `phase '${step.phase}' 有多个 review 出口；必须指定 --event ${step.events.join('|')}`,
    )
  }
  const event = step.events[0]
  if (event === undefined) throw new Error(`phase '${step.phase}' 没有 review 出口`)
  return event
}
