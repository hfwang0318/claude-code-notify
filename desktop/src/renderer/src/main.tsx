import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Popup from './Popup'
import { api } from './api'
import { resolveFontScale } from '../../shared/typography'
import './styles.css'

const isPopup = window.location.hash.includes('popup')
if (isPopup) document.body.classList.add('popup')

function applyTheme(theme: string): void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  document.documentElement.dataset.theme =
    theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
}

function applyFont(style: string | undefined, size: string | undefined): void {
  document.documentElement.dataset.font = style || 'system'
  document.documentElement.style.setProperty(
    '--font-scale',
    String(resolveFontScale((size || 'normal') as never))
  )
}

/** Maximized Windows windows keep native square corners; CSS rounding would
 * otherwise cut transparent notches out of the maximized frame. */
function applyMaximized(): void {
  const maximized =
    window.outerWidth >= window.screen.availWidth - 4 &&
    window.outerHeight >= window.screen.availHeight - 4
  document.documentElement.dataset.maximized = maximized ? 'true' : 'false'
}

function Root(): React.JSX.Element {
  useEffect(() => {
    let current = 'system'
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => applyTheme(current)
    applyMaximized()
    window.addEventListener('resize', applyMaximized)
    void api.getState().then((state) => {
      current = state.prefs.theme
      apply()
      applyFont(state.prefs.fontStyle, state.prefs.fontSize)
    })
    const offState = api.onState((state) => {
      current = state.prefs.theme
      apply()
      applyFont(state.prefs.fontStyle, state.prefs.fontSize)
    })
    media.addEventListener('change', apply)
    return () => {
      offState()
      media.removeEventListener('change', apply)
      window.removeEventListener('resize', applyMaximized)
    }
  }, [])

  return isPopup ? <Popup /> : <App />
}

const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(
  <StrictMode>
    <Root />
  </StrictMode>
)
