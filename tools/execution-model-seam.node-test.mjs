#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  EXECUTION_MODEL_SEAM_DIRS,
  EXECUTION_MODEL_SEAM_FILES,
  executionModelComparisonLines,
  executionModelSeamFailures,
} from './execution-model-seam.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const KERNEL = 'packages/kernel/src/workflow/anything.ts'

test('comparisons against either model literal are found in every operand order', () => {
  const lines = executionModelComparisonLines([
    "if (plan.capabilities.execution.model === 'phase-manifest') return 1",
    "if (plan.capabilities.execution.model !== 'step-graph') return 2",
    "if (model == 'phase-manifest') return 3",
    "if (model != 'step-graph') return 4",
    "if ('step-graph' === model) return 5",
    'if ("phase-manifest" !== model) return 6',
  ].join('\n'))
  assert.deepEqual(lines, [1, 2, 3, 4, 5, 6])
})

test('switch case labels are comparisons', () => {
  assert.deepEqual(executionModelComparisonLines("switch (m) {\n  case 'step-graph':\n    return 1\n}"), [2])
})

// 技能策略是执行模型的投影（计划里 skills.source 与 execution.model 出自同一个入参）：
// 比较它的字面量等于换个写法判断执行模型。
test('comparisons against the skill-policy projection of the model are found too', () => {
  const lines = executionModelComparisonLines([
    "if (plan.capabilities.skills.source === 'manifest-overlay') run()",
    "if (skillCapability.source !== 'step-declared') run()",
    "if ('manifest-overlay' == plan.skillPolicy) run()",
    "switch (plan.skillPolicy) {",
    "  case 'step-declared':",
    '    break',
    '}',
  ].join('\n'))
  assert.deepEqual(lines, [1, 2, 3, 5])
})

test('type unions, property values, call arguments, defaults and arrays are not comparisons', () => {
  const code = [
    "export type Model = 'phase-manifest' | 'step-graph'",
    "const plan = compile(workflow, { executionModel: 'phase-manifest' })",
    "compileWith(def, POLICIES, 'step-graph')",
    "const model = opts.executionModel ?? 'step-graph'",
    "const both = ['step-graph', 'phase-manifest'] as const",
    "const label = ready ? 'step-graph' : 'phase-manifest'",
    "readonly skillPolicy: 'manifest-overlay' | 'step-declared'",
    "const policy = legacy ? 'manifest-overlay' : 'step-declared'",
    "return { source: 'step-declared', steps }",
  ].join('\n')
  assert.deepEqual(executionModelComparisonLines(code), [])
})

test('comparisons inside comments are ignored and block comments keep line numbers', () => {
  const code = [
    "// plan.model === 'phase-manifest'",
    '/**',
    " * x !== 'step-graph'",
    ' */',
    "const bad = model === 'step-graph'",
  ].join('\n')
  assert.deepEqual(executionModelComparisonLines(code), [5])
})

test('a file outside the seam fails once per comparison, naming the file and line', () => {
  const failures = executionModelSeamFailures(
    'packages/cli/src/commands/advance.ts',
    "const a = 1\nif (plan.capabilities.execution.model === 'step-graph') run()\n",
  )
  assert.equal(failures.length, 1)
  assert.match(failures[0], /^packages\/cli\/src\/commands\/advance\.ts:2: /u)
  assert.match(failures[0], /execution seam/u)
})

test('the seam files and the legacy directory may compare', () => {
  const code = "if (model === 'phase-manifest') run()"
  for (const file of EXECUTION_MODEL_SEAM_FILES.keys()) {
    assert.deepEqual(executionModelSeamFailures(file, code), [], file)
  }
  assert.deepEqual(
    executionModelSeamFailures('packages/kernel/src/workflow/legacy-phase-manifest/nested/anything.ts', code),
    [],
  )
})

test('a sibling that merely shares a prefix with an allowed directory is not allowed', () => {
  const code = "if (model === 'phase-manifest') run()"
  assert.equal(executionModelSeamFailures('packages/kernel/src/workflow/legacy-phase-manifest-extra.ts', code).length, 1)
  assert.equal(executionModelSeamFailures('packages/kernel/src/workflow/legacy-phase-manifests/a.ts', code).length, 1)
})

test('kernel, cli, server and automation sources are scanned', () => {
  const code = "if (model === 'step-graph') run()"
  for (const rel of [
    KERNEL,
    'packages/cli/src/commands/x.ts',
    'packages/server/src/x.ts',
    'packages/automation/src/x.ts',
  ]) {
    assert.equal(executionModelSeamFailures(rel, code).length, 1, rel)
  }
})

test('the browser package and non-package files are outside the scan', () => {
  const code = "if (model === 'step-graph') run()"
  assert.deepEqual(executionModelSeamFailures('packages/dashboard-app/src/model/evidence.ts', code), [])
  assert.deepEqual(executionModelSeamFailures('tools/something.mjs', code), [])
  assert.deepEqual(executionModelSeamFailures('hooks/router-gen.mjs', code), [])
})

test('every allowed site exists and states why it may compare', () => {
  assert.ok(EXECUTION_MODEL_SEAM_FILES.size > 0)
  for (const [file, reason] of EXECUTION_MODEL_SEAM_FILES) {
    assert.ok(existsSync(join(root, file)), `${file} does not exist`)
    assert.ok(statSync(join(root, file)).isFile(), `${file} is not a file`)
    assert.notEqual(reason.trim(), '', `${file} has no reason`)
  }
  for (const [dir, reason] of EXECUTION_MODEL_SEAM_DIRS) {
    assert.ok(dir.endsWith('/'), `${dir} must end with a slash`)
    assert.ok(existsSync(join(root, dir)) && statSync(join(root, dir)).isDirectory(), `${dir} does not exist`)
    assert.notEqual(reason.trim(), '', `${dir} has no reason`)
  }
})

test('both seams are on the allow list', () => {
  assert.ok(EXECUTION_MODEL_SEAM_FILES.has('packages/kernel/src/workflow/execution-seam.ts'))
  assert.ok(EXECUTION_MODEL_SEAM_FILES.has('packages/cli/src/commands/execution-cli-seam.ts'))
  assert.ok(EXECUTION_MODEL_SEAM_DIRS.has('packages/kernel/src/workflow/legacy-phase-manifest/'))
})
