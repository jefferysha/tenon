/**
 * Single-line scalar codec for the narrow workflow YAML (kernel keeps zero third-party deps).
 * Step tests carry free text — shell commands, paths, labels — which the existing `(\S+)` field
 * readers cannot round-trip. Values are written plain when that stays valid YAML and single-quoted
 * otherwise, so an exported workflow still loads in standard YAML tools.
 */

/** Leading characters that start a YAML indicator (flow, anchor, tag, block, quote, directive). */
const UNSAFE_LEAD = /^[-?:,[\]{}#&*!|>'"%@`]/

/** Plain style is unsafe when the value would re-parse as a mapping, a comment or a different scalar. */
function needsQuotes(value: string): boolean {
  return value === ''
    || value !== value.trim()
    || UNSAFE_LEAD.test(value)
    || value.includes(': ')
    || value.includes(' #')
    || value.endsWith(':')
    || value.includes('\n')
}

export function formatScalar(value: string): string {
  return needsQuotes(value) ? `'${value.replaceAll("'", "''")}'` : value
}

export function parseScalar(raw: string): string {
  const value = raw.trim()
  if (!value.startsWith("'")) return value
  if (value.length < 2 || !value.endsWith("'")) {
    throw new Error(`workflow 解析错误：单引号标量未闭合 '${raw.trim()}'`)
  }
  return value.slice(1, -1).replaceAll("''", "'")
}
