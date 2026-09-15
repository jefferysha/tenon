import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { UpstreamSkillLicense } from '@tenon/kernel'
import { readSkillFrontmatter } from './content.js'

export interface LicenseEvidence {
  readonly license: UpstreamSkillLicense
  readonly source: 'skill-file' | 'frontmatter' | 'repo-file' | 'readme'
  readonly file?: string
}

export const LICENSE_FILE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING'] as const
const README = /^README(?:\.[A-Za-z0-9]+)?$/u
const LICENSE_HEADING = /^#{1,3}\s*Licen[cs]e\s*$/u

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function hasSkillLicenseFile(dir: string): boolean {
  return LICENSE_FILE_NAMES.some((name) => isFile(join(dir, name)))
}

function classify(text: string): UpstreamSkillLicense | 'unrecognized' {
  if (text.includes('Permission is hereby granted, free of charge')) return 'MIT'
  if (text.includes('Apache License') && text.includes('Version 2.0')) return 'Apache-2.0'
  return 'unrecognized'
}

function exactLicense(value: string | undefined): UpstreamSkillLicense | undefined {
  return value === 'MIT' || value === 'Apache-2.0' ? value : undefined
}

function licenseFile(
  dir: string,
  source: 'skill-file' | 'repo-file',
): LicenseEvidence | { readonly license: 'unrecognized'; readonly file: string } | undefined {
  for (const name of LICENSE_FILE_NAMES) {
    const file = join(dir, name)
    if (!isFile(file)) continue
    const license = classify(readFileSync(file, 'utf8'))
    return license === 'unrecognized' ? { license, file } : { license, source, file }
  }
  return undefined
}

function readmeLicense(checkoutDir: string): LicenseEvidence | undefined {
  let names: string[]
  try {
    names = readdirSync(checkoutDir).filter((name) => README.test(name)).sort()
  } catch {
    return undefined
  }
  for (const name of names) {
    const file = join(checkoutDir, name)
    if (!isFile(file)) continue
    const lines = readFileSync(file, 'utf8').split(/\r?\n/u)
    const heading = lines.findIndex((line) => LICENSE_HEADING.test(line.trim()))
    if (heading < 0) continue
    const value = lines.slice(heading + 1).find((line) => line.trim() !== '')?.trim()
    const license = exactLicense(value)
    if (license !== undefined) return { license, source: 'readme', file }
  }
  return undefined
}

/** First match wins: skill license file → SKILL.md `license:` SPDX → repository-root license file → root README section. */
export function detectUpstreamLicense(
  checkoutDir: string,
  skillPath: string,
): LicenseEvidence | { readonly license: 'unrecognized'; readonly file: string } | null {
  const skillDir = skillPath === '.' ? checkoutDir : join(checkoutDir, skillPath)
  const skillFile = licenseFile(skillDir, 'skill-file')
  if (skillFile !== undefined) return skillFile
  const frontmatter = readSkillFrontmatter(join(skillDir, 'SKILL.md'))
  const declared = exactLicense(frontmatter?.get('license'))
  if (declared !== undefined) return { license: declared, source: 'frontmatter' }
  if (skillPath !== '.') {
    const repoFile = licenseFile(checkoutDir, 'repo-file')
    if (repoFile !== undefined) return repoFile
  }
  return readmeLicense(checkoutDir) ?? null
}
