import type { Dict } from './translations'

/** 工作流页门禁段的测试设置（tests.policy.*）：一个档位单选 + 旧策略 / 旧步骤测试的只读行。页面只出词，档位所在文件放 Tooltip。 */
export const zh: Dict = {
  definition: '档位定义',
  legacy: {
    policy: '策略',
    name: '名称',
    kind: '种类',
    command: '命令',
    hint: '旧的步骤测试，只读；转成目录套件用右侧命令',
  },
}

export const en: Dict = {
  definition: 'Level definitions',
  legacy: {
    policy: 'Policy',
    name: 'Name',
    kind: 'Kind',
    command: 'Command',
    hint: 'A legacy stage test, read-only; convert it to a catalog suite with the command on the right',
  },
}
