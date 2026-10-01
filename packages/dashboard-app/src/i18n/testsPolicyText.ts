import type { Dict } from './translations'

/** 工作流页测试策略表单（tests.policy.*）。页面只出词；每个字段的说明都在 Tooltip（*_hint 键）。 */
export const zh: Dict = {
  add: '策略',
  add_label: '添加测试策略',
  remove_label: '移除测试策略',
  field: {
    kinds: '登记种类',
    run: '必跑种类',
    scope: '范围',
    coverage: '覆盖率',
    flaky: '不稳定上限',
    baseline: '要求基线',
    scenarios: '场景',
    integrity: '完整性',
  },
  hint: {
    kinds: '计划里必须有这些种类的套件，或已批准的豁免',
    run: '本阶段必须在当前代码上运行并通过；种类须先登记',
    scope: '全量：只认全量运行；变更：变更范围的运行也算数',
    coverage: '低于门槛判为失败；留空不设门槛',
    flaky: '重试后才通过的用例超过这个数就拦下；留空不限制',
    baseline: '基准套件在本机器画像下没有基线时也拦下；关闭时只提示',
    scenarios: '不要求；要求每个场景至少映射一个用例或有已批准的豁免；要求映射的用例本轮通过',
    integrity: '用例数下降、跳过、删除或弱化的测试、快照改写、基线与已知失败改动、覆盖率门槛降低：提示 = 只列出；阻塞 = 有信号就拦下出口',
    picker: '选择种类',
  },
  integrity: {
    notice: '提示',
    block: '阻塞',
  },
  scope: {
    full: '全量',
    changed: '变更',
  },
  scenarios: {
    off: '不要求',
    required: '要求映射',
    passing: '要求通过',
  },
  coverage: {
    lines: '行',
    branches: '分支',
    changed_lines: '变更行',
  },
  legacy: {
    name: '名称',
    kind: '种类',
    command: '命令',
    hint: '旧的步骤测试，只读；转成目录套件用右侧命令',
  },
}

export const en: Dict = {
  add: 'Policy',
  add_label: 'Add test policy',
  remove_label: 'Remove test policy',
  field: {
    kinds: 'Register kinds',
    run: 'Run kinds',
    scope: 'Scope',
    coverage: 'Coverage',
    flaky: 'Flaky limit',
    baseline: 'Require baseline',
    scenarios: 'Scenarios',
    integrity: 'Integrity',
  },
  hint: {
    kinds: 'The plan needs suites of these kinds, or approved waivers',
    run: 'Must run and pass on the current code in this stage; the kind must be registered first',
    scope: 'Full: only full runs count; Changed: runs over the changed scope count too',
    coverage: 'Below the threshold fails; leave empty for no threshold',
    flaky: 'Blocks when more cases than this only passed after a retry; leave empty for no limit',
    baseline: 'Also blocks a benchmark suite that has no baseline for this machine profile; off only reports it',
    scenarios: 'Off; require every scenario to map to a case or have an approved waiver; require the mapped cases to pass this round',
    integrity: 'Case-count drops, skips, deleted or weakened tests, snapshot rewrites, baseline and known-failure changes, lowered coverage thresholds. Notice only lists them; Block stops the step exit',
    picker: 'Choose kinds',
  },
  integrity: {
    notice: 'Notice',
    block: 'Block',
  },
  scope: {
    full: 'Full',
    changed: 'Changed',
  },
  scenarios: {
    off: 'Off',
    required: 'Mapped',
    passing: 'Passing',
  },
  coverage: {
    lines: 'Lines',
    branches: 'Branches',
    changed_lines: 'Changed lines',
  },
  legacy: {
    name: 'Name',
    kind: 'Kind',
    command: 'Command',
    hint: 'A legacy stage test, read-only; convert it to a catalog suite with the command on the right',
  },
}
