import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { BUILTIN_DIR, MANIFEST_FILE, SOURCES_FILE, checkAgents, frontmatterKeys, skillSourceIds } from './check-agents.mjs'

const kernel = await import(pathToFileURL(join(import.meta.dirname, '..', 'packages/kernel/dist/index.js')).href)

const SOURCES = `version: 1
skills:
  deep-research: { repo: a/b, path: skills/deep-research, ref: default-branch, license_expected: MIT }
  security-review: { repo: a/b, path: skills/security-review, ref: default-branch, license_expected: MIT }
`

const agent = (name, skills, head = ['role: reviewer', 'version: 1.0.0']) => `---
name: ${name}
description: 测试用 agent
${head.map((line) => `${line}\n`).join('')}skills: [${skills.join(', ')}]
tools: [Read]
model: sonnet
---

正文
`

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'tenon-agents-'))
  mkdirSync(join(root, BUILTIN_DIR), { recursive: true })
  mkdirSync(join(root, 'skills'), { recursive: true })
  writeFileSync(join(root, SOURCES_FILE), SOURCES)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, BUILTIN_DIR, name), text)
  return root
}

/** 先按当前文件生成发行记录再检查：只剩要验的那类问题。 */
function withManifest(root, inventory) {
  writeFileSync(join(root, MANIFEST_FILE), checkAgents({ root, kernel, inventory }).manifest)
}

test('skillSourceIds 读出 sources.yaml 的键', () => {
  assert.deepEqual(skillSourceIds(SOURCES), ['deep-research', 'security-review'])
})

test('清单齐全、技能都有来源、发行记录一致时通过', () => {
  const root = fixture({ 'one.md': agent('one', ['deep-research']) })
  try {
    withManifest(root, ['one'])
    const { failures, definitions } = checkAgents({ root, kernel, inventory: ['one'] })
    assert.deepEqual(failures, [])
    assert.equal(definitions.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('缺文件、多文件、坏文件与无来源的技能都失败', () => {
  const root = fixture({
    'one.md': agent('one', ['nope']),
    'extra.md': agent('extra', []),
    'broken.md': 'no frontmatter\n',
  })
  try {
    const { failures } = checkAgents({ root, kernel, inventory: ['one', 'broken', 'missing'] })
    assert.ok(failures.some((line) => line.includes('extra.md: 不在清单中')))
    assert.ok(failures.some((line) => line.includes('missing.md: 缺失')))
    assert.ok(failures.some((line) => line.includes('broken.md: ')))
    assert.ok(failures.some((line) => line.includes("skill 'nope' 不在")))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('官方 agent 缺 role 或 version 都失败', () => {
  const root = fixture({ 'one.md': agent('one', [], []) })
  try {
    withManifest(root, ['one'])
    const { failures } = checkAgents({ root, kernel, inventory: ['one'] })
    assert.ok(failures.some((line) => line.includes('必须显式写 role')))
    assert.ok(failures.some((line) => line.includes('必须写 version')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('发行记录缺失或与文件不一致都失败', () => {
  const root = fixture({ 'one.md': agent('one', []) })
  try {
    assert.ok(checkAgents({ root, kernel, inventory: ['one'] }).failures.some((line) => line.includes('manifest.json: 缺失')))
    withManifest(root, ['one'])
    writeFileSync(join(root, BUILTIN_DIR, 'one.md'), agent('one', ['deep-research']))
    assert.ok(checkAgents({ root, kernel, inventory: ['one'] }).failures.some((line) => line.includes('不一致')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('发行记录逐条记 name / version / role / digest', () => {
  const root = fixture({ 'one.md': agent('one', []) })
  try {
    const parsed = JSON.parse(checkAgents({ root, kernel, inventory: ['one'] }).manifest)
    assert.deepEqual(Object.keys(parsed.agents[0]), ['name', 'version', 'role', 'digest'])
    assert.equal(parsed.agents[0].role, 'reviewer')
    assert.match(parsed.agents[0].digest, /^sha256:[0-9a-f]{64}$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('仓库里的官方 agent 全部合法', () => {
  const { failures, definitions } = checkAgents({ kernel })
  assert.deepEqual(failures, [])
  assert.equal(definitions.length, 10)
})

test('官方 agent 的 frontmatter 只能用上一个发行版读得了的键（attach_on / host 会让冻结副本在 N-1 里不可读）', () => {
  assert.deepEqual(frontmatterKeys('---\nname: a\nskills: [x]\n---\n\n正文: 不是键\n'), ['name', 'skills'])
  for (const extra of ['attach_on: [auth]', 'host: codex']) {
    const root = fixture({ 'one.md': agent('one', ['deep-research'], ['role: reviewer', 'version: 1.0.0', extra]) })
    try {
      withManifest(root, ['one'])
      const { failures } = checkAgents({ root, kernel, inventory: ['one'] })
      assert.equal(failures.length, 1, extra)
      assert.match(failures[0], new RegExp(`${extra.split(':')[0]}.*不在上一个发行版的闭集`), extra)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('仓库里的官方 agent 全部通过兼容检查', () => {
  const { failures } = checkAgents({ kernel })
  assert.deepEqual(failures.filter((failure) => failure.includes('闭集')), [])
})
