import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useT } from './i18n'

function ErrorFallback(): JSX.Element {
  const { t } = useT()
  return (
    <div role="alert" data-testid="app-error-boundary">
      <p className="p-5 text-body text-red">{t('common.app_error')}</p>
      <button
        type="button"
        className="cursor-pointer rounded-sm bg-btn-bg px-4 py-2 text-caption font-bold text-btn-fg transition-colors hover:bg-btn-hover"
        onClick={() => { try { location.reload() } catch { /* ignore */ } }}
      >
        {t('common.app_error_reload')}
      </button>
    </div>
  )
}

interface ErrorBoundaryState {
  hasError: boolean
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      console.error('[dashboard] render 抛错，已被顶层 ErrorBoundary 兜底：', error, info.componentStack)
    } catch {
      /* ignore */
    }
  }

  render(): ReactNode {
    return this.state.hasError ? <ErrorFallback /> : this.props.children
  }
}
