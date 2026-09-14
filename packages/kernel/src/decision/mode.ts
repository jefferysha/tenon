export type UserDecisionMode = 'hitl' | 'afk'
export type DecisionStrategy = 'interactive' | 'recommended-defaults' | 'afk'

export function strategyForDecisionMode(mode: UserDecisionMode, recommendedDefaults = false): DecisionStrategy {
  if (mode === 'afk') return 'afk'
  return recommendedDefaults ? 'recommended-defaults' : 'interactive'
}
