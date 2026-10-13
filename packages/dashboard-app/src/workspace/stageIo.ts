import type { WbStepIoEntry, WbStepIoFile } from '../api/governanceTypes'

/**
 * 工作台一步的输入与输出，直接取任务编排里的 `stepIo`（服务端按真实产出投影）。没有这一步的条目（聚合视图不发
 * 请求、旧服务端不带）就是空：空列表恒是同一个引用，依赖它的 memo 不会因此重算。
 */
const NO_FILES: readonly WbStepIoFile[] = []
const NO_REQUIRED: WbStepIoEntry['required'] = []

export function stageInputs(entry: WbStepIoEntry | undefined): readonly WbStepIoFile[] {
  return entry?.inputs ?? NO_FILES
}

export function stageOutputs(entry: WbStepIoEntry | undefined): readonly WbStepIoFile[] {
  return entry?.outputs ?? NO_FILES
}

export function stageRequired(entry: WbStepIoEntry | undefined): WbStepIoEntry['required'] {
  return entry?.required ?? NO_REQUIRED
}

/**
 * 门禁行的条件计数：必须产出已齐的条数；review 在此之上多一条人工确认。
 * 没有门禁或一个条件都没有 → null（不显示这一行）。
 */
export function gateProgress(
  gate: 'review' | 'auto' | null,
  required: WbStepIoEntry['required'],
  reviewSatisfied: boolean,
): { gate: 'review' | 'auto'; done: number; total: number } | null {
  if (gate === null) return null
  const total = required.length + (gate === 'review' ? 1 : 0)
  if (total === 0) return null
  const done = required.filter((item) => item.produced).length + (gate === 'review' && reviewSatisfied ? 1 : 0)
  return { gate, done, total }
}

/** 删除的文件已不在盘上，没有内容可读；其余（含契约模式没有变化类型的）都可读。 */
export function isReadableFile(file: WbStepIoFile): boolean {
  return file.change !== 'deleted'
}

export function fileName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/** 可阅读文件的有序列表（先输出后输入，按路径去重），供抽屉上一份 / 下一份。 */
export function readableFiles(files: readonly WbStepIoFile[]): Array<{ path: string; label: string }> {
  const seen = new Set<string>()
  const out: Array<{ path: string; label: string }> = []
  for (const file of files) {
    if (!isReadableFile(file) || seen.has(file.path)) continue
    seen.add(file.path)
    out.push({ path: file.path, label: fileName(file.path) })
  }
  return out
}
