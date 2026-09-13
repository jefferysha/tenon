import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)

async function makeFixture() {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-identity-'))
  await mkdir(join(fixture, 'packages/kernel/src'), { recursive: true })
  await cp(new URL('tools/check-product-identity.mjs', root), join(fixture, 'tools/check-product-identity.mjs'))
  await cp(new URL('tools/generate-product-identity.mjs', root), join(fixture, 'tools/generate-product-identity.mjs'))
  await cp(new URL('product', root), join(fixture, 'product'), { recursive: true })
  await cp(new URL('packages/kernel/src/product-identity.generated.ts', root), join(fixture, 'packages/kernel/src/product-identity.generated.ts'))
  await cp(new URL('templates/generated', root), join(fixture, 'templates/generated'), { recursive: true })
  await cp(new URL('adapters/codex', root), join(fixture, 'adapters/codex'), { recursive: true })
  await cp(new URL('skills/tenon', root), join(fixture, 'skills/tenon'), { recursive: true })
  await cp(new URL('AGENTS.md', root), join(fixture, 'AGENTS.md'))
  return fixture
}

function runChecker(fixture) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(fixture, 'tools/check-product-identity.mjs')], {
      cwd: fixture,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('身份门禁对缺失 AGENTS.md 输出稳定可读错误而不泄漏堆栈', async () => {
  const fixture = await makeFixture()
  try {
    await rm(join(fixture, 'AGENTS.md'))
    const result = await runChecker(fixture)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /AGENTS\.md is missing or unreadable/)
    assert.doesNotMatch(result.stderr, /ENOENT|Error:|at .*check-product-identity/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('身份门禁对缺失 managed block 保持稳定 stale 结果', async () => {
  const fixture = await makeFixture()
  try {
    const agentsPath = join(fixture, 'AGENTS.md')
    const agents = await readFile(agentsPath, 'utf8')
    await writeFile(agentsPath, agents.replace(/<!-- PIPELINE:CODEX:START -->[\s\S]*<!-- PIPELINE:CODEX:END -->\n?/, ''), 'utf8')
    const result = await runChecker(fixture)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /AGENTS\.md Codex managed block is stale/)
    assert.doesNotMatch(result.stderr, /ENOENT|Error:|at .*check-product-identity/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
