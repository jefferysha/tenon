/**
 * 测试体系视图词典的聚合：共享词表在 `tests.*`，各视图的词在 `tests.project|task|run|policy|library.*`。
 * 拆成多个文件是为了让各视图独立演进；translations.ts 只挂这一个入口。
 */
import * as library from './testsLibraryText'
import * as policy from './testsPolicyText'
import * as project from './testsProjectText'
import * as run from './testsRunText'
import * as shared from './testsShared'
import * as task from './testsTaskText'
import type { Dict } from './translations'

export const zhTests: Dict = {
  ...shared.zh,
  project: project.zh,
  task: task.zh,
  run: run.zh,
  policy: policy.zh,
  library: library.zh,
}

export const enTests: Dict = {
  ...shared.en,
  project: project.en,
  task: task.en,
  run: run.en,
  policy: policy.en,
  library: library.en,
}
