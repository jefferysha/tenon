/**
 * 候选版本（工作区指纹）在一次扫描里只算一次：指纹要遍历整棵实现树，每个 change 各算一遍
 * 会让快照轮询变成常驻负载。TTL 之内复用，并发调用共享同一个 in-flight promise。
 * 算不出来时返回 undefined —— 上层据此把看起来新鲜的记录投影成 stale，而不是伪装成通过。
 */
export type CandidateReader = (root: string) => Promise<string | undefined>

export function createCandidateCache(
  fingerprint: (root: string) => Promise<string>,
  ttlMs = 5000,
  now: () => number = Date.now,
): CandidateReader {
  const entries = new Map<string, { readonly at: number; readonly value: Promise<string | undefined> }>()
  return (root) => {
    const cached = entries.get(root)
    if (cached !== undefined && now() - cached.at < ttlMs) return cached.value
    const value = fingerprint(root).catch(() => undefined)
    entries.set(root, { at: now(), value })
    return value
  }
}
