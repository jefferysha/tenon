import { readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readProductIdentity,
  renderCodexAgentsBlock,
  renderProductIdentity,
} from './generate-product-identity.mjs'

// This checker is used by install/CI gates. Keep filesystem failures concise and
// deterministic: missing or unreadable managed files must not dump platform-specific stacks.
const failures = []
function fail(message) {
  failures.push(message)
}

async function readRequired(url, label) {
  try {
    return await readFile(url, 'utf8')
  } catch {
    fail(`product identity check: ${label} is missing or unreadable`)
    return null
  }
}

async function main() {
  const targetUrl = new URL('../packages/kernel/src/product-identity.generated.ts', import.meta.url)
  const codexTemplateUrl = new URL('../templates/generated/codex-agents-block.md', import.meta.url)
  const agentsUrl = new URL('../AGENTS.md', import.meta.url)
  const adapterUrl = new URL('../adapters/codex/install.sh', import.meta.url)

  let identity
  try {
    identity = await readProductIdentity()
  } catch {
    fail('product identity check: product/identity.json is missing or unreadable')
  }
  if (!identity) {
    for (const message of failures) console.error(message)
    process.exitCode = 1
    return
  }

  const expected = renderProductIdentity(identity)
  const actual = await readRequired(targetUrl, 'packages/kernel/src/product-identity.generated.ts')
  if (actual !== null && actual !== expected) {
    fail('product identity projection is stale; run npm run generate:identity')
  }

  const expectedCodexTemplate = renderCodexAgentsBlock(identity)
  const actualCodexTemplate = await readRequired(
    codexTemplateUrl,
    'templates/generated/codex-agents-block.md',
  )
  if (actualCodexTemplate !== null && actualCodexTemplate !== expectedCodexTemplate) {
    fail('Codex managed block projection is stale; run npm run generate:identity')
  }

  const agents = await readRequired(agentsUrl, 'AGENTS.md')
  if (agents !== null) {
    const startMarker = '<!-- PIPELINE:CODEX:START -->'
    const endMarker = '<!-- PIPELINE:CODEX:END -->'
    const starts = [...agents.matchAll(new RegExp(startMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))]
    const ends = [...agents.matchAll(new RegExp(endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))]
    const managedStart = starts[0]?.index ?? -1
    const managedEnd = (ends[0]?.index ?? -1) + endMarker.length
    const actualManagedBlock = managedStart >= 0 && managedEnd >= endMarker.length
      ? `${agents.slice(managedStart, managedEnd)}\n`
      : ''
    if (starts.length !== 1 || ends.length !== 1 || managedStart >= managedEnd
      || actualManagedBlock !== expectedCodexTemplate) {
      fail('AGENTS.md Codex managed block is stale; run npm run generate:identity and refresh the managed block')
    }
  }

  const adapter = await readRequired(adapterUrl, 'adapters/codex/install.sh')
  if (adapter !== null) {
    const templateReferences = adapter.match(/templates\/generated\/codex-agents-block\.md/g) ?? []
    if (templateReferences.length !== 1
      || !adapter.includes('cp "$template" "$block_tmp"')
      || !adapter.includes('cat "$template"')) {
      fail('Codex adapter does not consume the generated managed block')
    }
  }

  let skillsRoot
  try {
    skillsRoot = await realpath(fileURLToPath(new URL('../skills/', import.meta.url)))
  } catch {
    fail('product identity check: skills/ is missing or unreadable')
  }

  if (skillsRoot) {
    let entryPath
    try {
      entryPath = await realpath(fileURLToPath(
        new URL(`../skills/${identity.entrySkill}/SKILL.md`, import.meta.url),
      ))
    } catch {
      fail(`product identity check: entry Skill ${identity.entrySkill} is missing or unreadable`)
    }

    if (entryPath) {
      const entryRelative = relative(skillsRoot, entryPath)
      const escapedSkillsRoot = entryRelative === '..'
        || entryRelative.startsWith(`..${sep}`)
        || resolve(dirname(entryPath), '..') !== skillsRoot
      const entrySkill = escapedSkillsRoot ? '' : await readRequired(
        new URL(`../skills/${identity.entrySkill}/SKILL.md`, import.meta.url),
        `skills/${identity.entrySkill}/SKILL.md`,
      )
      const frontmatterEnd = entrySkill?.startsWith('---\n') ? entrySkill.indexOf('\n---\n', 4) : -1
      const frontmatter = frontmatterEnd === -1 ? '' : entrySkill.slice(4, frontmatterEnd)
      const nameLines = frontmatter.split('\n').filter((line) => line.startsWith('name:'))
      const matchingEntrySkills = []
      const unreadableEntrySkills = []
      let skillEntries
      try {
        skillEntries = await readdir(skillsRoot, { withFileTypes: true })
      } catch {
        fail('product identity check: skills/ directory is missing or unreadable')
        skillEntries = []
      }
      for (const entry of skillEntries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        try {
          const source = await readFile(resolve(skillsRoot, entry.name, 'SKILL.md'), 'utf8')
          const end = source.startsWith('---\n') ? source.indexOf('\n---\n', 4) : -1
          if (end === -1) continue
          const names = source.slice(4, end).split('\n').filter((line) => line.startsWith('name:'))
          if (names.length === 1 && names[0] === `name: ${identity.entrySkill}`) {
            matchingEntrySkills.push(entry.name)
          }
        } catch {
          unreadableEntrySkills.push(entry.name)
        }
      }
      if (escapedSkillsRoot
        || nameLines.length !== 1
        || nameLines[0] !== `name: ${identity.entrySkill}`
        || unreadableEntrySkills.length !== 0
        || matchingEntrySkills.length !== 1
        || matchingEntrySkills[0] !== identity.entrySkill) {
        fail('product entry Skill is missing or its frontmatter name does not match product identity')
      }
    }
  }

  if (failures.length > 0) {
    for (const message of failures) console.error(message)
    process.exitCode = 1
  }
}

main().catch(() => {
  console.error('product identity check failed unexpectedly')
  process.exitCode = 1
})
