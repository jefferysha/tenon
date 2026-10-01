/**
 * 内建 Track 的精确定义（codex 2026-07-17 裁决钉死的默认值表）。
 *
 * BUILTIN_TRACK_IDS 只在 tracks/ 模块及其消费方内定义使用——kernel/src/types.ts 的 TRACKS
 * 常量仍是现行运行时全集来源，切换属于清单 T 的 R2 阶段（见 GOAL.md）。
 *
 * routing.pattern 的默认值只在本文件定义；项目覆盖统一来自 `.pipeline/tracks.yaml` 的
 * `policy_profile.routing`。manifest 不再承载路由数据，避免默认 registry 与模板互相镜像漂移。
 *
 * routing.priority 数值化自 hooks/router.sh 的平手序：打分仅在「严格大于」时换轨、判定顺序
 * fe→be→pm（HOT PATH 段，先判者赢平手）——故 frontend 300 > backend 200 > pm 100。
 *
 * workflow 绑定缺省 { default:'default', allowed:'*' }：与「没有 tracks.yaml」的现行为
 * 逐字一致（任何 workflow 都可绑定、缺省走 'default'），保证零迁移成本路径。
 */
import type { TrackDefinition, TrackWorkflowBinding } from './types.js'

export const BUILTIN_TRACK_IDS = ['chat', 'simple', 'standard', 'pm', 'frontend', 'backend', 'free'] as const
export type BuiltinTrackId = (typeof BUILTIN_TRACK_IDS)[number]

export function isBuiltinTrackId(id: string): id is BuiltinTrackId {
  return (BUILTIN_TRACK_IDS as readonly string[]).includes(id)
}

/** 内建启用轨的路由正则唯一默认真相源（grep -E 方言）。 */
export const BUILTIN_ROUTER_PATTERNS = {
  simple:
    '((错别字|拼写|typo|文案|注释|comment|快速修复|quick patch|移除未使用|unused import|格式化|formatting|配置值|小改|微调).*(README|CHANGELOG|文档|docs/|文件|[A-Za-z0-9_./-]+\\.(md|txt|json|ya?ml|toml|tsx?|jsx?|vue|css|scss|html|py|go|rs|java)|组件|页面|按钮|标题|标签|字段|键|key|一行|单行)|(README|CHANGELOG|文档|docs/|文件|[A-Za-z0-9_./-]+\\.(md|txt|json|ya?ml|toml|tsx?|jsx?|vue|css|scss|html|py|go|rs|java)|组件|页面|按钮|标题|标签|字段|键|key|一行|单行).*(错别字|拼写|typo|文案|注释|comment|快速修复|quick patch|移除未使用|unused import|格式化|formatting|配置值|小改|微调))',
  // 实现类请求的默认通道：改、修、加、删、重构……（中文子串；英文动词要在句首 / 标点后 / please、to、and 这类祈使引导词之后，
  // 并带词边界，不用 \b——BSD grep 没有——以免把 “the add function”“show me the add module” 里的名词当成动词）。
  // 重型信号由下面的排除正则挡掉，那些请求回到 default 的领域轨；风险较低的实现请求先走 standard，
  // 做完后按 diff 实测风险决定要不要升级，而不是靠关键词在开工前预测。
  standard:
    '(修复|修正|修一下|修个|修改|改一下|改成|改为|调整|实现|新增|增加|添加|加一个|加个|加上|补上|补一个|补个|删除|删掉|去掉|移除|替换|重命名|重构|整理|优化|拆分|抽取|提取|合并|支持|(^|[.!?;:,]|，|。|；|：|、|(^|[[:space:]])(please|pls|then|and|also|just|now|first|to|should|must|can you|could you|would you|will you|let.s|help me)[[:space:]])[[:space:]]*(fix|fixes|add|adds|implement|create|remove|delete|rename|refactor|extract|rewrite|update|change|modify|make|support|patch|handle|replace|rework|tweak|move|split|merge)([^a-z]|$))',
  frontend:
    '(前端|UI|页面|组件|React|Vue|Next|Tailwind|样式|shadcn|\\.tsx|\\.jsx|\\.vue|web 设计|响应式|button|form|layout)',
  backend:
    '(后端|backend|API|接口|数据库|Go |Python |Java |Rust |NestJS|Postgres|endpoint|service|微服务|REST|GraphQL|gRPC|migration|server|controller|schema|修复|修改|实现|添加|重构|bug|feature|微调|版本号|格式化|formatting|错别字|拼写|typo|文案|注释)',
  pm: '(调研|竞品|市场|竞争对手|对标|商业模式|PRD|需求|用户旅程|原型|market|立项|产品|user persona|流程图)',
} as const

/** Exclusion is evaluated before score/priority; it is never a negative score heuristic. */
export const BUILTIN_ROUTER_EXCLUDE_PATTERNS = {
  simple:
    '(跨模块|多模块|多文件|整个项目|全项目|全仓|所有文件|批量|新功能|feature|重构|架构|算法|业务逻辑|核心逻辑|行为变更|API|接口|公共契约|contract|协议|schema|migration|数据库|登录|认证|鉴权|权限|auth|security|安全|并发|事务|transaction|依赖|dependency|package|npm|pnpm|yarn|bun|升级|升到|更新版本|生产数据|部署|发布|release|外部副作用|多端|前后端|全栈)',
  standard:
    '(架构|architecture|跨模块|多模块|多个模块|整个项目|全项目|全仓|所有文件|批量|迁移|migration|schema|数据库|database|鉴权|认证|登录|权限|auth|security|安全|依赖升级|升级依赖|升到|发布|部署|release|deploy|生产数据|全栈|前后端|多端|完整流程|调研|竞品|市场|商业模式|PRD|用户旅程)',
} as const

const WORKFLOW_ANY: TrackWorkflowBinding = { default: 'default', allowed: '*' }

export const BUILTIN_TRACK_DEFINITIONS: readonly TrackDefinition[] = [
  {
    id: 'chat',
    label: 'Chat',
    builtin: true,
    workflow: WORKFLOW_ANY,
    policyProfile: {
      reviewSeed: 'pending',
      automationEligible: true,
      coverageProfile: 'none',
      routing: { enabled: false },
      skills: { matrix: false, profile: '_all' },
    },
  },
  {
    id: 'simple',
    label: 'Simple',
    builtin: true,
    workflow: { default: 'simple', allowed: ['simple'] },
    policyProfile: {
      reviewSeed: 'pending',
      automationEligible: false,
      coverageProfile: 'none',
      routing: {
        enabled: true,
        pattern: BUILTIN_ROUTER_PATTERNS.simple,
        excludePattern: BUILTIN_ROUTER_EXCLUDE_PATTERNS.simple,
        priority: 1000,
      },
      skills: { matrix: false, profile: '_all' },
    },
  },
  {
    id: 'standard',
    label: 'Standard',
    builtin: true,
    workflow: { default: 'standard', allowed: ['standard'] },
    policyProfile: {
      reviewSeed: 'pending',
      automationEligible: false,
      coverageProfile: 'none',
      routing: {
        enabled: true,
        pattern: BUILTIN_ROUTER_PATTERNS.standard,
        excludePattern: BUILTIN_ROUTER_EXCLUDE_PATTERNS.standard,
        priority: 500,
      },
      skills: { matrix: false, profile: '_all' },
    },
  },
  {
    id: 'pm',
    label: 'PM',
    builtin: true,
    workflow: WORKFLOW_ANY,
    policyProfile: {
      reviewSeed: 'skipped',
      // PM 的默认产物是调研/规格；当 Spec 已完成时交给 AFK 队列继续执行。该位与
      // automationEligible 分开，避免前端/后端的“可手动 AFK”被误解成“自动接管 Build”。
      autoEnqueueOnSpecComplete: true,
      // 手动 AFK capability 与自动入队保持两条独立授权：两者都仍会经过 normal loop
      // admission、skill bundle、verification 与 L1/L2/L3 执行闸。
      automationEligible: true,
      coverageProfile: 'pm',
      routing: { enabled: true, pattern: BUILTIN_ROUTER_PATTERNS.pm, priority: 100 },
      skills: { matrix: true, profile: 'pm' },
    },
  },
  {
    id: 'frontend',
    label: 'Frontend',
    builtin: true,
    workflow: WORKFLOW_ANY,
    policyProfile: {
      reviewSeed: 'pending',
      automationEligible: true,
      coverageProfile: 'frontend',
      routing: { enabled: true, pattern: BUILTIN_ROUTER_PATTERNS.frontend, priority: 300 },
      skills: { matrix: true, profile: 'frontend' },
    },
  },
  {
    id: 'backend',
    label: 'Backend',
    builtin: true,
    workflow: WORKFLOW_ANY,
    policyProfile: {
      reviewSeed: 'pending',
      automationEligible: true,
      coverageProfile: 'backend',
      routing: { enabled: true, pattern: BUILTIN_ROUTER_PATTERNS.backend, priority: 200 },
      skills: { matrix: true, profile: 'backend' },
    },
  },
  {
    id: 'free',
    label: 'Free',
    builtin: true,
    workflow: WORKFLOW_ANY,
    policyProfile: {
      reviewSeed: 'pending',
      automationEligible: false,
      coverageProfile: 'none',
      routing: { enabled: false },
      skills: { matrix: false, profile: 'free' },
    },
  },
]

const BUILTIN_BY_ID: ReadonlyMap<BuiltinTrackId, TrackDefinition> = new Map(
  BUILTIN_TRACK_DEFINITIONS.map((t) => [t.id as BuiltinTrackId, t]),
)

/** 取内建定义（id 已由类型收窄，缺失属内部错误）。 */
export function builtinTrack(id: BuiltinTrackId): TrackDefinition {
  const def = BUILTIN_BY_ID.get(id)
  if (!def) throw new Error(`tracks 内部错误：内建定义缺 '${id}'`)
  return def
}
