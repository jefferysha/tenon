import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectUpstreamLicense } from './license.js'

const MIT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n'
const APACHE = '                                 Apache License\n                           Version 2.0, January 2004\n'
const GPL = 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function checkout(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tenon-upstream-license-'))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text, 'utf8')
  }
  return root
}

const skill = (frontmatter = ''): string => `---\nname: demo\n${frontmatter}---\n# demo\n`

describe('detectUpstreamLicense', () => {
  it('prefers a license file inside the skill', () => {
    const dir = checkout({ 'skills/demo/SKILL.md': skill('license: MIT\n'), 'skills/demo/LICENSE.txt': APACHE, LICENSE: MIT })
    expect(detectUpstreamLicense(dir, 'skills/demo')).toEqual({ license: 'Apache-2.0', source: 'skill-file', file: join(dir, 'skills/demo/LICENSE.txt') })
  })

  it('accepts an exact SPDX frontmatter value', () => {
    const dir = checkout({ 'skills/demo/SKILL.md': skill('license: MIT\n'), LICENSE: GPL })
    expect(detectUpstreamLicense(dir, 'skills/demo')).toEqual({ license: 'MIT', source: 'frontmatter' })
  })

  it('falls back to the repository root license file', () => {
    const dir = checkout({ 'skills/demo/SKILL.md': skill(), 'LICENSE.md': MIT })
    expect(detectUpstreamLicense(dir, 'skills/demo')).toEqual({ license: 'MIT', source: 'repo-file', file: join(dir, 'LICENSE.md') })
  })

  it('reads the first line under a README license heading', () => {
    const dir = checkout({ 'skills/demo/SKILL.md': skill(), 'README.md': '# Skills\n\n## License\n\nMIT\n' })
    expect(detectUpstreamLicense(dir, 'skills/demo')).toEqual({ license: 'MIT', source: 'readme', file: join(dir, 'README.md') })
  })

  it('returns null for a frontmatter pointer without a license file', () => {
    const dir = checkout({ 'skills/demo/SKILL.md': skill('license: Complete terms in LICENSE.txt\n') })
    expect(detectUpstreamLicense(dir, 'skills/demo')).toBeNull()
  })

  it('reports an unrecognized root license file', () => {
    const dir = checkout({ 'skills/demo/SKILL.md': skill(), LICENSE: GPL })
    expect(detectUpstreamLicense(dir, 'skills/demo')).toEqual({ license: 'unrecognized', file: join(dir, 'LICENSE') })
  })

  it('treats the repository root as the skill directory for root skills', () => {
    const dir = checkout({ 'SKILL.md': skill(), LICENSE: MIT })
    expect(detectUpstreamLicense(dir, '.')).toMatchObject({ license: 'MIT', source: 'skill-file' })
  })
})
