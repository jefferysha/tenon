/**
 * doctor 的发布身份与源码漂移事实类型（原在 deps.ts；抽出来只为守住 deps.ts 的体量上限，
 * deps.ts 原样再导出，调用方 import 路径不变）。
 */
import type { RuntimeDevSource } from './runtime/types.js'

export type SourceDriftFacts =
  | { readonly state: 'not-source-repo' }
  | {
      readonly state: 'source-repo'
      readonly repo: string
      readonly installed:
        | {
            readonly channel: 'dev'
            readonly host: 'codex' | 'claude'
            readonly releaseId: string
            readonly devSource: RuntimeDevSource
          }
        | {
            readonly channel: 'stable'
            readonly host: 'codex' | 'claude' | 'adapter' | 'manual'
            readonly version: string
          }
        | null
      readonly live: RuntimeDevSource | { readonly error: string }
    }

export type DoctorProductIdentity =
  | {
      readonly state: 'dev'
      readonly host: 'codex' | 'claude'
      readonly runtimePluginVersion: string
      readonly runtimeReleaseId: string
      /** 源码开发安装（tenon setup --from-source）绑定的仓库工作区与安装时的 HEAD。 */
      readonly repoRealpath: string
      readonly commit: string
      readonly dirty: boolean
    }
  | {
      readonly state: 'native'
      readonly expectedVersion: string
      readonly host: 'codex' | 'claude'
      readonly hostPluginVersion: string | null
      readonly hostPluginRoot: string | null
      readonly stableTargetTag: string
      readonly stableTargetCommit: string
      readonly hostTargetExact: boolean
      /**
       * 冻结的 stable tag 是否刚刚向远端复核过。`doctor` 默认只用安装时留下的那份证明（本地健康
       * 检查不该为此联网几十秒），`--verify-release` 才去 GitHub 复核。false = 本次没复核，
       * `hostTargetExact` 只覆盖本地一致性。
       */
      readonly remoteTargetVerified: boolean
      readonly hostPayloadDigest: string | null
      readonly runtimePluginVersion: string
      readonly runtimeReleaseId: string
      readonly runtimePayloadDigest: string
      readonly payloadDigestExact: boolean
      readonly dashboardServerVersion: string | null
      readonly dashboardReleaseId: string | null
      /**
       * 最近一次 runtime 事件是回滚到当前 active release 时，被回滚掉的那份 release 的身份。回滚只换 runtime，
       * 宿主插件与 Dashboard 仍是较新的那份，所以身份对不上是这个状态的预期结果；doctor 靠它把这种漂移与真漂移分开。
       * 之后又有激活（update、setup）就没有这一项。
       */
      readonly rolledBackFrom?: {
        readonly releaseId: string
        readonly pluginVersion: string
        readonly payloadDigest: string
      }
    }
  | {
      readonly state: 'unavailable'
      readonly detail: string
      /**
       * 为什么证不出来，分开报。`network` 是链路问题（远端不可达/超时），不是装坏了；
       * `missing-tag` / `mismatch` 才是发布身份本身的问题；`local` 是本机可信命令或 runtime
       * 清单不满足前提。以前全部塌成一句「发布身份探针失败」，附带一条「重跑 setup/update」的
       * 建议——对断网的用户是错的指令。
       */
      readonly cause: 'network' | 'missing-tag' | 'mismatch' | 'local'
      /** 针对 cause 的修复指引（doctor 直接用作 hint）。 */
      readonly remediation: string
    }
