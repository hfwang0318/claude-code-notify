import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** Keep a renderer exception from turning the whole window blank. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] uncaught error', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="fatal-error" role="alert">
        <h1>界面渲染失败</h1>
        <p>审批服务仍在后台运行，重新加载界面不会丢失待审批请求。</p>
        <pre>{this.state.error.message}</pre>
        <button className="btn primary" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    )
  }
}
