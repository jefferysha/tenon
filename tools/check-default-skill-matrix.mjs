#!/usr/bin/env node
/**
 * check-default-skill-matrix.mjs —— 技能合一（2026-09）后的漂移门禁。
 *
 * 技能真相在 templates/workflows/default.yaml（每个技能可带 `when: track_in: [...]` 轨道条件）；
 * templates/manifest.yaml 的 `mandatory_skills` 退化为路由提示投影。两者必须逐格一致：
 *   对每个 phase × track（pm / frontend / backend / free，即 matrix=true 的内建轨道）：
 *     manifest 展开后的技能集合 == default.yaml 里对该 track 生效的「非驱动」技能集合
 *   其中驱动技能 = 无 when 且 id 以 tenon- 开头（工作流自身的相位驱动，不进矣阵）；
 *   manifest 的 `<phase>._all` 行对应 default.yaml 里无 when 的非驱动技能。
 * 任一格不一致即非零退出并逐格打印差异。零依赖、窄 YAML 扫描（同 generate-default-workflow.mjs 的口径）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')
const DEFAULT_YAML = join(REPO_ROOT, 'templates', 'workflows', 'default.yaml')
const MANIFEST_YAML = join(REPO_ROOT, 'templates', 'manifest.yaml')
const MATRIX_TRACKS = ['pm', 'frontend', 'backend', 'free']

const indentOf = (line) => line.length - line.trimStart().length
const inlineList = (raw) => {
  const t = raw.trim()
  if (t === '[]') return []
  return t.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
}

/** default.yaml → { _base: { phase: [skill ids] }, <track>: { phase: [skill ids] } }（按分支）。 */
export function readDefaultSkills(text) {
  const lines = text.split('\n')
  const out = { _base: {} }
  let branch = '_base'
  let phase = null
  let inSkills = false
  let skillsIndent = -1
  let inTracks = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (line === 'tracks:') { inTracks = true; inSkills = false; continue }
    const trackMatch = /^  ([a-z][a-z0-9_-]{0,31}):\s*$/.exec(line)
    if (inTracks && trackMatch) {
      branch = trackMatch[1]
      out[branch] = {}
      inSkills = false
      continue
    }
    const idMatch = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line)
    const stepIndent = inTracks ? 6 : 2
    if (idMatch && indentOf(line) === stepIndent) {
      phase = idMatch[1]
      out[branch][phase] = []
      inSkills = false
      continue
    }
    if (/^\s*skills:\s*$/.test(line) && phase !== null) {
      inSkills = true
      skillsIndent = indentOf(line)
      continue
    }
    if (!inSkills) continue
    if (indentOf(line) <= skillsIndent) { inSkills = false; continue }
    if (idMatch) out[branch][phase].push(idMatch[1])
  }
  return out
}

/** manifest.yaml → { 'phase.track': [skills] } */
export function readManifestMatrix(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^mandatory_skills:\s*$/.test(line))
  if (start < 0) throw new Error('templates/manifest.yaml 缺 mandatory_skills 块')
  const out = {}
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (indentOf(line) === 0) break
    const cell = /^\s*([a-z_]+\.[a-z_]+):\s*(\[.*\])\s*$/.exec(line)
    if (cell) out[cell[1]] = inlineList(cell[2])
  }
  return out
}

export function compare(defaultSkills, matrix) {
  const problems = []
  for (const track of MATRIX_TRACKS) {
    const branch = defaultSkills[track]
    if (branch === undefined) { problems.push(`default.yaml 缺 tracks.${track} 分支`); continue }
    for (const [phase, skills] of Object.entries(branch)) {
      const fromYaml = skills.filter((skill) => !skill.startsWith('tenon-'))
      const fromManifest = matrix[`${phase}.${track}`] ?? matrix[`${phase}._all`] ?? []
      const a = [...fromYaml].sort().join(',')
      const b = [...fromManifest].sort().join(',')
      if (a !== b) problems.push(`${phase}.${track}: default.yaml=[${fromYaml.join(', ')}] manifest=[${fromManifest.join(', ')}]`)
    }
  }
  return problems
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const problems = compare(readDefaultSkills(readFileSync(DEFAULT_YAML, 'utf8')), readManifestMatrix(readFileSync(MANIFEST_YAML, 'utf8')))
  if (problems.length > 0) {
    console.error('default skill matrix check failed:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log('default skill matrix check passed (templates/workflows/default.yaml ⇔ templates/manifest.yaml mandatory_skills)')
}
