export const contentEntries = [
  ['index', '首页', 'Home', '开始使用', 'concept'],
  ['installation', '安装与宿主配置', 'Installation and host setup', '开始使用', 'how-to'],
  ['quickstart', '第一个受治理任务', 'First governed task', '开始使用', 'tutorial'],
  ['routing-and-workflows', '选择执行模式', 'Choose an execution mode', '教程', 'concept'],
  ['default-workflow', 'Default 七阶段工作流', 'The seven-phase default workflow', '教程', 'concept'],
  ['custom-workflows-and-tracks', '自定义 Workflow 与 Track', 'Custom Workflows and Tracks', '操作指南', 'how-to'],
  ['documents-skills-and-evidence', '文档、Skill 与证据链', 'Documents, Skills, and evidence', '概念与架构', 'concept'],
  ['agents', '智能体', 'Agents', '概念与架构', 'concept'],
  ['dashboard-and-local-api', 'Dashboard 与本地 API', 'Dashboard and local API', '参考', 'reference'],
  ['automation-and-loops', '自动化、AFK 与 Loops', 'Automation, AFK, and loops', '操作指南', 'how-to'],
  ['cli-reference', 'CLI 参考', 'CLI reference', '参考', 'reference'],
  ['updates-recovery-and-uninstall', '更新、恢复与卸载', 'Updates, recovery, and uninstall', '运维与安全', 'how-to'],
  ['troubleshooting', '故障排查', 'Troubleshooting', '运维与安全', 'how-to'],
  ['security-model', '安全模型', 'Security model', '运维与安全', 'concept'],
  ['ci-verification', 'CI 校验', 'CI verification', '运维与安全', 'how-to'],
  ['release-notes', '发布说明', 'Release notes', '发布说明', 'reference'],
  ['advanced-tools', '高级工具', 'Advanced tools', '参考', 'reference'],
  ['contributor-development', '贡献者开发指南', 'Contributor development', '贡献', 'how-to'],
].map(([slug, zhTitle, enTitle, group, contentType]) => ({
  slug,
  group,
  contentType,
  locales: {
    'zh-CN': {
      title: zhTitle,
      description: `Tenon ${zhTitle}：基于当前仓库行为的可验证指南。`,
      source: `docs/usage/zh-CN/${slug}.md`,
      target: slug === 'index' ? 'index.md' : `${slug}.md`,
    },
    en: {
      title: enTitle,
      description: `Tenon ${enTitle}: a verifiable guide based on current repository behavior.`,
      source: slug === 'index' ? 'docs/usage/README.md' : `docs/usage/${slug}.md`,
      target: slug === 'index' ? 'en/index.md' : `en/${slug}.md`,
    },
  },
}))

export const publicGroups = [
  '开始使用',
  '教程',
  '操作指南',
  '概念与架构',
  '参考',
  '运维与安全',
  '发布说明',
  '贡献',
]
