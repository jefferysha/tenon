/** 非 JavaScript 工程的测试工具识别：pytest、go、cargo（cargo 只给提示）。 */
import { join } from 'node:path'
import { idPrefix, makeSuite, readSmallText, type DiscoveredSuite, type ProjectDir } from './discover-support.js'
import { RUNNER_PRESETS } from './runner-presets.js'

export async function discoverOtherLanguages(dir: ProjectDir, notes: string[]): Promise<readonly DiscoveredSuite[]> {
  const found: DiscoveredSuite[] = []
  const prefix = idPrefix(dir.rel)
  const where = dir.rel === '.' ? '' : `${dir.rel}/`
  const pytest = RUNNER_PRESETS.pytest
  const go = RUNNER_PRESETS.go
  const pyproject = dir.names.has('pyproject.toml') ? await readSmallText(join(dir.abs, 'pyproject.toml')) : undefined
  const isPytest = dir.names.has('pytest.ini')
    || (pyproject !== undefined && /\[tool\.pytest/.test(pyproject))
    || (dir.names.has('setup.cfg') && /\[tool:pytest\]/.test(await readSmallText(join(dir.abs, 'setup.cfg')) ?? ''))
    || (dir.names.has('tox.ini') && /\[pytest\]/.test(await readSmallText(join(dir.abs, 'tox.ini')) ?? ''))
  if (isPytest && pytest !== undefined) {
    found.push({
      source: `${where}${dir.names.has('pytest.ini') ? 'pytest.ini' : 'pyproject.toml'}`,
      suite: makeSuite({
        id: `${prefix}pytest`, label: 'pytest', kind: 'unit', runner: 'pytest', cwd: dir.rel, command: pytest.command,
        files: ['tests/**/test_*.py', '**/*_test.py', '**/test_*.py'],
        ...(pytest.select === undefined ? {} : { select: pytest.select }), report: pytest.report, artifacts: pytest.artifacts,
      }),
    })
  }
  if (dir.names.has('go.mod') && go !== undefined) {
    found.push({
      source: `${where}go.mod`,
      suite: makeSuite({
        id: `${prefix}go-test`, label: 'go test', kind: 'unit', runner: 'go', cwd: dir.rel, command: go.command,
        files: ['**/*_test.go'],
        ...(go.select === undefined ? {} : { select: go.select }), report: go.report, artifacts: go.artifacts,
      }),
    })
  }
  if (dir.names.has('Cargo.toml')) {
    notes.push(`${where}Cargo.toml：cargo test 没有结构化报告；用 cargo-nextest 的 junit 输出后手工 tenon test catalog add --runner cargo --report-format junit`)
  }
  return found
}
