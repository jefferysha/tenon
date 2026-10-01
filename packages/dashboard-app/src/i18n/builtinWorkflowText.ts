/**
 * 内置工作流数据的界面词（`builtin.*`）：随插件发布的工作流、轨道、测试方向，其出厂中文名对应的英文名。
 *
 * 键 = 内置标识（工作流 id + 阶段 id、工作流 id + 轨道 id、测试方向 id）；zh 的值就是出厂的中文名，同时充当
 * 「这个名字是不是没被改过」的判据（builtinLabels.ts）：只有存下来的名字与出厂中文名逐字相同才取词典，
 * 用户改过的、自建的名字原样显示。出厂本身就是英文或中英同形的名字（simple 的 Change / Verify、e2e、Playwright）
 * 不需要条目。与 templates/ 里的出厂名逐项对齐由 builtinLabels.test.tsx 守。
 */
import type { Dict } from './translations'

export const zh: Dict = {
  step: {
    default: { open: '立项', explore: '调研', spec: '规格', build: '实现', verify: '验证', ship: '交付', archive: '完结' },
    standard: { open: '立项', build: '实现', verify: '验证', done: '完结', escalated: '已升级' },
    'design-system': { direction: '方向', generate: '生成', review: '预览' },
  },
  track: {
    default: { chat: '对话', pm: '产品', frontend: '前端', backend: '后端', free: '自由' },
  },
  direction: {
    benchmark: '基准',
    'code-size': '代码规模',
    'design-system': '设计体系',
    'diff-risk': '改动风险',
    integration: '集成',
    regression: '回归',
    typecheck: '类型检查',
    unit: '单测',
  },
}

export const en: Dict = {
  step: {
    default: { open: 'Open', explore: 'Explore', spec: 'Spec', build: 'Build', verify: 'Verify', ship: 'Ship', archive: 'Done' },
    standard: { open: 'Open', build: 'Build', verify: 'Verify', done: 'Done', escalated: 'Escalated' },
    'design-system': { direction: 'Direction', generate: 'Generate', review: 'Preview' },
  },
  track: {
    default: { chat: 'Chat', pm: 'Product', frontend: 'Frontend', backend: 'Backend', free: 'Free' },
  },
  direction: {
    benchmark: 'Benchmark',
    'code-size': 'Code size',
    'design-system': 'Design system',
    'diff-risk': 'Diff risk',
    integration: 'Integration',
    regression: 'Regression',
    typecheck: 'Typecheck',
    unit: 'Unit',
  },
}
