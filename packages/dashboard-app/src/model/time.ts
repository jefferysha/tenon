/**
 * 时间显示工具：ISO8601 → 中文绝对时间（YYYY年MM月DD日 HH:mm:ss）。
 * 刻意不做"N 分钟前"相对时间——那需要注入 now（业务码禁散落 new Date()，同仓库纪律），
 * 且收件箱/看板由 SSE 驱动刷新，相对时间不刷新会说谎；短绝对时间确定、可测、够扫读。
 */
export function shortTime(iso: string, lang: 'zh' | 'en' = 'zh'): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(iso)
  if (!m) return iso
  if (lang === 'en') return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] ?? '00'}`
  return `${m[1]}年${m[2]}月${m[3]}日 ${m[4]}:${m[5]}:${m[6] ?? '00'}`
}

/** ISO8601 → 按界面语言、本机时区显示到分钟；解析不了就原样返回，不编造时间。 */
export function localTime(iso: string, lang: 'zh' | 'en' = 'zh'): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(ms)
}
