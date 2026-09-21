import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { BUILTIN_DIR, SOURCES_FILE, checkAgents, skillSourceIds } from './check-agents.mjs'

const kernel = await import(pathToFileURL(join(import.meta.dirname, '..', 'packages/kernel/dist/index.js')).href)

const SOURCES = `version: 1
skills:
  deep-research: { repo: a/b, path: skills/deep-research, ref: default-branch, license_expected: MIT }
  security-review: { repo: a/b, path: skills/security-review, ref: default-branch, license_expected: MIT }
`

const agent = (name, skills) => `---
name: ${name}
description: 测试用 agent
skills: [${skills.join(', ')}]
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

test('skillSourceIds 读出 sources.yaml 的键', () => {
  assert.deepEqual(skillSourceIds(SOURCES), ['deep-research', 'security-review'])
})

test('清单齐全且技能都有来源时通过', () => {
  const root = fixture({ 'one.md': agent('one', ['deep-research']) })
  try {
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

test('仓库里的内建 agent 全部合法', () => {
  const { failures, definitions } = checkAgents({ kernel })
  assert.deepEqual(failures, [])
  assert.equal(definitions.length, 9)
})
