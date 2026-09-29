import type { Dict } from './translations'

/** 库「测试模板」（tests.library.*）。结构化只读字段，页面只出词。 */
export const zh: Dict = {
  field: {
    kind: '种类',
    cwd: '目录',
    timeout: '超时',
    scope: '范围',
    exit_code: '退出码',
    metrics_path: '指标文件',
  },
  scope: {
    full: '全量',
    known: '已知失败',
  },
  section: {
    inputs: '输入',
    outputs: '输出',
    metrics: '指标',
  },
  input: {
    kind: '类型',
    value: '值',
    document: '文档',
    file: '文件',
    env: '环境变量',
    service: '服务',
  },
  output: {
    path: '路径',
    kind: '类型',
    required: '必须',
    optional: '可选',
    report: '报告',
    coverage: '覆盖率',
    metrics: '指标',
    trace: 'trace',
    screenshot: '截图',
    log: '日志',
    other: '其它',
  },
  metric: {
    name: '名称',
    max: '上限',
    min: '下限',
    regression: '退化',
    better: '方向',
    lower: '越低越好',
    higher: '越高越好',
  },
}

export const en: Dict = {
  field: {
    kind: 'Kind',
    cwd: 'Directory',
    timeout: 'Timeout',
    scope: 'Scope',
    exit_code: 'Exit code',
    metrics_path: 'Metrics file',
  },
  scope: {
    full: 'Full',
    known: 'Known failures',
  },
  section: {
    inputs: 'Inputs',
    outputs: 'Outputs',
    metrics: 'Metrics',
  },
  input: {
    kind: 'Type',
    value: 'Value',
    document: 'Document',
    file: 'File',
    env: 'Environment variable',
    service: 'Service',
  },
  output: {
    path: 'Path',
    kind: 'Type',
    required: 'Required',
    optional: 'Optional',
    report: 'Report',
    coverage: 'Coverage',
    metrics: 'Metrics',
    trace: 'Trace',
    screenshot: 'Screenshot',
    log: 'Log',
    other: 'Other',
  },
  metric: {
    name: 'Name',
    max: 'Max',
    min: 'Min',
    regression: 'Regression',
    better: 'Direction',
    lower: 'Lower is better',
    higher: 'Higher is better',
  },
}
