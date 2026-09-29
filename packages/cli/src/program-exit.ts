export class CliExit extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`)
  }
}

export function bail(code: number): void {
  if (code !== 0) throw new CliExit(code)
}

export const stripNl = (value: string): string => value.replace(/\n$/, '')

/** commander 可重复选项的收集器：`--suite a --suite b` → ['a', 'b']。 */
export function collect(value: string, previous: readonly string[] = []): string[] {
  return [...previous, value]
}
