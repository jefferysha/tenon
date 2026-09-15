import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { BUILTIN_DIR, checkInstructionTemplates, headingsOf } from './check-instruction-templates.mjs'

const kernel = await import(pathToFileURL(join(import.meta.dirname, '..', 'packages/kernel/dist/index.js')).href)

const GO = `---
id: go
category: backend
title: Go
directory: backend/
directory_label: 后端工程根目录
---
## 后端（Go）

### 技术栈

\`\`\`
### 围栏里的标题不算
\`\`\`

### 分层结构
### 编码规范
### 文件长度
### 测试要求
`

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'tenon-instruction-templates-'))
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, BUILTIN_DIR, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  return root
}

test('合法清单通过', () => {
  const root = fixture({ 'backend/go.md': GO })
  try {
    const { failures, blocks } = checkInstructionTemplates({ root, kernel, inventory: { backend: ['go'] } })
    assert.deepEqual(failures, [])
    assert.equal(blocks.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('缺文件、多文件、多余分类目录都报出', () => {
  const root = fixture({ 'backend/go.md': GO, 'backend/extra.md': GO, 'misc/x.md': GO })
  try {
    const { failures } = checkInstructionTemplates({ root, kernel, inventory: { backend: ['go', 'rust-axum'] } })
    assert.deepEqual(failures.sort(), [
      `${BUILTIN_DIR}/backend/extra.md: 不在清单中`,
      `${BUILTIN_DIR}/backend/rust-axum.md: 缺失`,
      `${BUILTIN_DIR}/misc: 不在清单中的分类目录`,
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('解析错误与小节顺序错误', () => {
  const root = fixture({
    'backend/go.md': GO.replace('### 编码规范\n### 文件长度', '### 文件长度\n### 编码规范'),
    'backend/rust-axum.md': GO.replace('id: go', 'id: rust'),
  })
  try {
    const { failures } = checkInstructionTemplates({ root, kernel, inventory: { backend: ['go', 'rust-axum'] } })
    assert.equal(failures.length, 2)
    assert.match(failures[0], /go\.md: 小节应为 ### 技术栈 · ### 分层结构 · ### 编码规范 · ### 文件长度 · ### 测试要求/)
    assert.match(failures[1], /rust-axum\.md:2 id-mismatch/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('headingsOf 跳过围栏代码', () => {
  assert.deepEqual(headingsOf('### a\n```\n### b\n```\n### c\n#### d\n', '### '), ['### a', '### c'])
})
