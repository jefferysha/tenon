import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import process from 'node:process'

const root = new URL('../', import.meta.url)
const roots = [
  '.agent-rules',
  '.agents/plugins',
  '.claude-plugin',
  '.codex-plugin',
  '.github',
  'adapters',
  'agents',
  'commands',
  'docs/usage',
  'docs-site',
  'hooks',
  'packages',
  'product',
  'skills',
  'templates',
  'tools',
]
const files = [
  'AGENTS.md',
  'CONTRIBUTING.md',
  'GOAL.md',
  'README.md',
  'README.en.md',
  'README.zh-CN.md',
  'SECURITY.md',
  'SUPPORT.md',
  'install.sh',
  'package.json',
]
const skippedPrefixes = [
  'docs-site/.generated/',
  'docs-site/dist/',
  'migration/legacy-channel/',
  'packages/dashboard-app/.impeccable/',
  'packages/cli/src/migration/',
  'packages/kernel/src/state/fixtures/',
  'tools/fixtures/',
]
const skippedFiles = new Set([
  // Exact, fail-closed reader for an immutable pre-Tenon persistence fingerprint. It has no
  // command, package, Skill, hook, or documentation surface.
  'packages/kernel/src/workflow/migrations/pre-tenon-v1-document-policy.ts',
  'tools/build-legacy-bridge.mjs',
  'tools/build-legacy-bridge.node-test.mjs',
  'tools/check-legacy-identity.mjs',
])
const trackedReleaseAssets = new Set([
  'packages/cli/dist/tenon.mjs',
  'packages/server/dist/dashboard.mjs',
])
const forbidden = [
  { label: 'retired product name', pattern: /Pipeline Lite/ },
  { label: 'retired identity slug', pattern: /pipeline-lite/ },
  { label: 'misspelled retired repository', pattern: /pipeline-worklfow/ },
  { label: 'retired package scope', pattern: /@pipeline-lite\// },
  { label: 'retired CLI bundle', pattern: /(?:dist\/pipeline\.mjs|runtime\/pipeline-bootstrap\.mjs)/ },
  {
    label: 'retired CLI command',
    pattern: /\bpipeline (?=(?:init|list|status|state|upgrade|get|set|set-many|cas|check|transition|review|document|workflow|session|handoff|internal-skill-gate|inbox|import|setup|update|doctor|runtime|dashboard|uninstall|sync|task|spec|afk|loop|loops|mem|channel|artifact|advance|cancel|pass|reject|retry)\b|--help\b|<command>|<cmd>)/,
  },
  {
    label: 'retired public environment prefix',
    pattern: /\bPIPELINE_(?:RUNTIME|CHANGE|TRACK|PROJECT|STABLE|AUTO|ACTIVE|REQUIRE_REAL_CODEX)[A-Z0-9_]*/,
  },
]

function skipped(path) {
  return skippedFiles.has(path)
    || skippedPrefixes.some((prefix) => path.startsWith(prefix))
    || (path.includes('/dist/') && !path.startsWith('packages/dashboard-app/dist/') && !trackedReleaseAssets.has(path))
    || /\.(?:test|integration\.test)\.[cm]?[jt]sx?$/.test(path)
}

function likelyText(path) {
  return !['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2'].includes(extname(path).toLowerCase())
}

async function collect(path, output) {
  const url = new URL(path, root)
  let entries
  try {
    entries = await readdir(url, { withFileTypes: true })
  } catch {
    output.push(path)
    return
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) await collect(child, output)
    else if (entry.isFile()) output.push(child)
  }
}

const candidates = [...files]
for (const path of roots) await collect(path, candidates)
const violations = []
for (const path of [...new Set(candidates)].sort()) {
  if (skipped(path) || !likelyText(path)) continue
  let content
  try {
    content = await readFile(new URL(path, root), 'utf8')
  } catch {
    continue
  }
  for (const rule of forbidden) {
    const match = rule.pattern.exec(content)
    if (match === null) continue
    const line = content.slice(0, match.index).split('\n').length
    violations.push(`${path}:${line}: ${rule.label}: ${JSON.stringify(match[0])}`)
  }
}

if (violations.length > 0) {
  process.stderr.write(`current product contains retired identity residues:\n${violations.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('legacy identity classification: current Tenon surfaces are clean\n')
}
