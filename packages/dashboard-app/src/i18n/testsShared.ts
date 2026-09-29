/**
 * 测试体系视图的共享词表（`tests.*`）。一词一概念：测试 / 套件 / 用例 / 基线 / 已知失败 / 豁免；
 * 场景与任务条目合称「场景/任务」。状态 = 圆点 + 一个词，词只在这里定义一次。
 * 各视图自己的词在各自的文件里（tests.project / task / run / policy / library），由 testsTranslations.ts 合并。
 */
import type { Dict } from './translations'

export const zh: Dict = {
  word: {
    test: '测试',
    suite: '套件',
    case: '用例',
    baseline: '基线',
    known: '已知失败',
    waiver: '豁免',
    coverage: '覆盖率',
    flaky: 'flaky',
    kind: '种类',
    runner: 'runner',
    command: '命令',
    result: '结果',
    file: '文件',
    scenario: '场景/任务',
    duration: '耗时',
    step: '阶段',
  },
  state: {
    passed: '通过',
    failed: '失败',
    stale: '过期',
    missing: '未运行',
    running: '运行中',
  },
  case: {
    pass: '通过',
    fail: '失败',
    skip: '跳过',
    flaky: 'flaky',
    'known-fail': '已知失败',
    'not-run': '未运行',
  },
  copy: '复制命令',
  copied: '已复制',
}

export const en: Dict = {
  word: {
    test: 'Tests',
    suite: 'Suite',
    case: 'Case',
    baseline: 'Baseline',
    known: 'Known failure',
    waiver: 'Waiver',
    coverage: 'Coverage',
    flaky: 'Flaky',
    kind: 'Kind',
    runner: 'Runner',
    command: 'Command',
    result: 'Result',
    file: 'File',
    scenario: 'Scenario/Task',
    duration: 'Duration',
    step: 'Stage',
  },
  state: {
    passed: 'Pass',
    failed: 'Fail',
    stale: 'Stale',
    missing: 'Not run',
    running: 'Running',
  },
  case: {
    pass: 'Pass',
    fail: 'Fail',
    skip: 'Skip',
    flaky: 'Flaky',
    'known-fail': 'Known failure',
    'not-run': 'Not run',
  },
  copy: 'Copy command',
  copied: 'Copied',
}
