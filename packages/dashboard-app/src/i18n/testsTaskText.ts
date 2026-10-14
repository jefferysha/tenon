import type { Dict } from './translations'

/** 工作台任务「测试」页签（tests.task.*）。页面只出词；说明放 Tooltip。 */
export const zh: Dict = {
  section: {
    files: '测试文件',
    matrix: '策略',
    trace: '场景/任务',
    blockers: '阻塞',
    notices: '提示',
    integrity: '完整性',
  },
  integrity: {
    signal: '信号',
    detail: '明细',
    mode: '策略',
    notice: '提示',
    block: '阻塞',
    unavailable: '未检查',
    truncated: '截断',
  },
  matrix: {
    requirement: '要求',
    result: '最近结果',
    blocker: '缺项',
    fix_show: '展开修复命令',
    fix_hide: '收起修复命令',
  },
  requirement: {
    required: '必需',
    touched: '碰到才跑',
    register: '登记',
    run: '运行',
    if_registered: '有则跑',
  },
  requirement_hint: {
    required: '目录里必须有这一类套件，或已批准的豁免；运行的套件须通过',
    touched: '改动碰到这一类套件才运行',
    register: '计划里必须有这个种类的套件或已批准的豁免',
    run: '本阶段必须在当前代码上运行并通过',
    if_registered: '计划里登记了才需要运行',
  },
  waiver: {
    approved: '已批准',
    pending: '待批准',
  },
  trace: {
    passing: '通过',
    failing: '失败',
    uncovered: '未覆盖',
    optional: '可选',
    mapped: '未运行',
    unmapped: '未映射',
    unmapped_hint: '本步不要求映射',
  },
  blockers: {
    label: '阻塞',
    subject: '对象',
    fix: '修复',
    notice: '提示',
  },
  files: {
    status: '状态',
    claimed: '自动认领',
    orphan_hint: '没有任何目录套件认领这个文件',
  },
  summary: '概览',
  // 汇总数字旁的计数词：词典不带复数，按数量取 one / other 两条（中文两条相同）。
  stat: {
    suite: { one: '套件', other: '套件' },
    case: { one: '用例', other: '用例' },
    fail: { one: '失败', other: '失败' },
    flaky: { one: '不稳定', other: '不稳定' },
  },
}

export const en: Dict = {
  section: {
    files: 'Test files',
    matrix: 'Policy',
    trace: 'Scenario/Task',
    blockers: 'Blockers',
    notices: 'Notices',
    integrity: 'Integrity',
  },
  integrity: {
    signal: 'Signal',
    detail: 'Detail',
    mode: 'Policy',
    notice: 'Notice',
    block: 'Block',
    unavailable: 'Unchecked',
    truncated: 'Truncated',
  },
  matrix: {
    requirement: 'Requirement',
    result: 'Latest result',
    blocker: 'Missing',
    fix_show: 'Show fix command',
    fix_hide: 'Hide fix command',
  },
  requirement: {
    required: 'Required',
    touched: 'Touched',
    register: 'Register',
    run: 'Run',
    if_registered: 'If registered',
  },
  requirement_hint: {
    required: 'The catalog needs a suite of this class, or an approved waiver; suites that run must pass',
    touched: 'Runs only when the change touches a suite of this class',
    register: 'The plan needs a suite of this kind or an approved waiver',
    run: 'Must run and pass on the current code in this stage',
    if_registered: 'Only needs to run when the plan registers it',
  },
  waiver: {
    approved: 'Approved',
    pending: 'Pending',
  },
  trace: {
    passing: 'Pass',
    failing: 'Fail',
    uncovered: 'Uncovered',
    optional: 'Optional',
    mapped: 'Not run',
    unmapped: 'Unmapped',
    unmapped_hint: 'Mapping is not required in this step',
  },
  blockers: {
    label: 'Blocker',
    subject: 'Subject',
    fix: 'Fix',
    notice: 'Notice',
  },
  files: {
    status: 'Status',
    claimed: 'Auto-claimed',
    orphan_hint: 'No catalog suite claims this file',
  },
  summary: 'Summary',
  stat: {
    suite: { one: 'Suite', other: 'Suites' },
    case: { one: 'Case', other: 'Cases' },
    fail: { one: 'Failed', other: 'Failed' },
    flaky: { one: 'Flaky', other: 'Flaky' },
  },
}
