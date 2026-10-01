/** `tenon support bundle` 与 `tenon logs` 的输出。 */
export const SUPPORT_MESSAGES = {
  'support.written': {
    zh: '支持包已生成: {path}（{size}）',
    en: 'Support bundle written: {path} ({size})',
  },
  'support.included': {
    zh: '包含：',
    en: 'Included:',
  },
  'support.entry.truncated': {
    zh: '（只留最近 {kept}，原 {total}）',
    en: ' (last {kept} of {total})',
  },
  'support.entry.unavailable': {
    zh: '（不可用：{reason}）',
    en: ' (unavailable: {reason})',
  },
  'support.hooksTimings': {
    zh: '没有 hook 耗时记录',
    en: 'no hook timing records',
  },
  'support.redacted': {
    zh: '已脱敏：{summary}',
    en: 'Redacted: {summary}',
  },
  'support.redactedNone': {
    zh: '已脱敏：未发现需要抹掉的内容',
    en: 'Redacted: nothing needed to be removed',
  },
  'support.kind.token': { zh: '{count} 个凭证', en: '{count} token(s)' },
  'support.kind.cookie': { zh: '{count} 个 cookie/会话', en: '{count} cookie/session value(s)' },
  'support.kind.credential-url': { zh: '{count} 个带密码的 URL', en: '{count} URL credential(s)' },
  'support.kind.private-key': { zh: '{count} 个私钥块', en: '{count} private key block(s)' },
  'support.kind.email': { zh: '{count} 个邮箱', en: '{count} email(s)' },
  'support.kind.home-path': { zh: '{count} 处 home 路径', en: '{count} home path(s)' },
  'support.kind.user-name': { zh: '{count} 处用户名', en: '{count} user name(s)' },
  'support.notIncluded': {
    zh: '未包含：项目源码、对话与提示词、tap 抓包、secrets 的值、任何仓库文件',
    en: 'Not included: project source, conversations and prompts, tap traces, secret values, any repository file',
  },
  'support.review': {
    zh: '分享前请先解开检查一遍；文件权限为 0600。',
    en: 'Unpack and review it before sharing; the file mode is 0600.',
  },
  'support.writeFailed': {
    zh: '无法写入支持包 {path}: {error}',
    en: 'cannot write the support bundle {path}: {error}',
  },
  'support.outInvalid': {
    zh: '--out 必须是一个文件路径，且不能是已存在的目录',
    en: '--out must be a file path and cannot be an existing directory',
  },
  'logs.none': {
    zh: '还没有 Dashboard 日志：{path}（server 启动后才会产生；用 tenon dashboard --background 启动）',
    en: 'No Dashboard log yet: {path} (it is created when the server starts; start it with tenon dashboard --background)',
  },
  'logs.linesInvalid': {
    zh: '--lines 必须是正整数',
    en: '--lines must be a positive integer',
  },
  'logs.readFailed': {
    zh: '无法读取日志 {path}: {error}',
    en: 'cannot read the log {path}: {error}',
  },
  'logs.following': {
    zh: '正在跟随 {path}（Ctrl+C 结束）',
    en: 'Following {path} (Ctrl+C to stop)',
  },
} as const
