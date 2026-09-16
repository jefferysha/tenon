/** 跨会话记忆检索的 HTTP 契约（从 types.ts 拆出，保持单文件在 400 行以内）。 */
import type { MemPlatform, MemPlatformFilter } from '@tenon/kernel'

export interface RelatedSessionSearchRequest {
  root: string
  query: string
  platform: MemPlatformFilter
}

export interface RelatedSessionSearchMatch {
  platform: MemPlatform
  session_id: string
  title?: string
  updated_at?: string
  score: number
  hit_count: number
  excerpt: string
  descendants_merged: number
}

export interface RelatedSessionSearchResponse {
  protocol: 'tenon-related-session-memory/v1'
  query: string
  platform: MemPlatformFilter
  partial: boolean
  warnings: Array<{ code: string; message: string }>
  matches: RelatedSessionSearchMatch[]
}

export type RelatedSessionSearchRunner = (
  request: RelatedSessionSearchRequest,
) => RelatedSessionSearchResponse | Promise<RelatedSessionSearchResponse>
