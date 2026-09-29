import type { Dict } from './translations'

/** 项目页「测试」视图（tests.project.*）。页面只出词；说明放 Tooltip。 */
export const zh: Dict = {
  segment: '项目视图',
  empty: '还没有测试目录',
  col: {
    name: '名称',
    result: '最近结果',
  },
  detail: {
    cwd: '目录',
    timeout: '超时',
    report: '报告',
    services: '服务',
    browsers: '浏览器',
    retries: '重试',
    tags: '标签',
    thresholds: '覆盖率门槛',
    ready: '就绪',
  },
  threshold: {
    lines: '行',
    branches: '分支',
    changed_lines: '变更行',
  },
  baseline: {
    profile: '画像',
    metric: '指标',
    median: '中位数',
    p95: 'p95',
    samples: '样本',
    updated: '更新',
    trend: '走势',
    corrupt: '基线文件损坏',
    better_lower: '越低越好',
    better_higher: '越高越好',
  },
  known: {
    test: '用例',
    reason: '原因',
    link: '链接',
    expires: '到期',
    expired: '过期',
    invalid: '已知失败清单无法解析',
  },
}

export const en: Dict = {
  segment: 'Project view',
  empty: 'No test catalog yet',
  col: {
    name: 'Name',
    result: 'Latest result',
  },
  detail: {
    cwd: 'Directory',
    timeout: 'Timeout',
    report: 'Report',
    services: 'Services',
    browsers: 'Browsers',
    retries: 'Retries',
    tags: 'Tags',
    thresholds: 'Coverage thresholds',
    ready: 'Ready',
  },
  threshold: {
    lines: 'Lines',
    branches: 'Branches',
    changed_lines: 'Changed lines',
  },
  baseline: {
    profile: 'Profile',
    metric: 'Metric',
    median: 'Median',
    p95: 'P95',
    samples: 'Samples',
    updated: 'Updated',
    trend: 'Trend',
    corrupt: 'Corrupt baseline files',
    better_lower: 'Lower is better',
    better_higher: 'Higher is better',
  },
  known: {
    test: 'Case',
    reason: 'Reason',
    link: 'Link',
    expires: 'Expires',
    expired: 'Expired',
    invalid: 'The known-failure list cannot be parsed',
  },
}
