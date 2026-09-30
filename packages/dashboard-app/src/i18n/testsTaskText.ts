import type { Dict } from './translations'

/** 工作台任务「测试」页签（tests.task.*）。页面只出词；说明放 Tooltip。 */
export const zh: Dict = {
  section: {
    files: '未登记文件',
    matrix: '策略',
    trace: '场景/任务',
    blockers: '阻塞',
  },
  matrix: {
    requirement: '要求',
    registered: '已登记',
    result: '最近结果',
    blocker: '缺项',
    fix_show: '展开修复命令',
    fix_hide: '收起修复命令',
  },
  requirement: {
    register: '登记',
    run: '运行',
    if_registered: '有则跑',
  },
  requirement_hint: {
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
  },
  blockers: {
    label: '阻塞',
    subject: '对象',
    fix: '修复',
    notice: '提示',
  },
  files: {
    orphan_hint: '没有任何目录套件认领这个文件',
  },
  summary: '概览',
}

export const en: Dict = {
  section: {
    files: 'Unregistered files',
    matrix: 'Policy',
    trace: 'Scenario/Task',
    blockers: 'Blockers',
  },
  matrix: {
    requirement: 'Requirement',
    registered: 'Registered',
    result: 'Latest result',
    blocker: 'Missing',
    fix_show: 'Show fix command',
    fix_hide: 'Hide fix command',
  },
  requirement: {
    register: 'Register',
    run: 'Run',
    if_registered: 'If registered',
  },
  requirement_hint: {
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
  },
  blockers: {
    label: 'Blocker',
    subject: 'Subject',
    fix: 'Fix',
    notice: 'Notice',
  },
  files: {
    orphan_hint: 'No catalog suite claims this file',
  },
  summary: 'Summary',
}
