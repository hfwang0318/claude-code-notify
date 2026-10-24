import { useEffect, useState } from 'react'
import type { AppState } from '../../shared/types'
import { api } from './api'

/** Subscribe to the single app state broadcast shared by every window. */
export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null)

  useEffect(() => {
    let alive = true
    void api.getState().then((next) => {
      if (alive) setState(next)
    })
    const off = api.onState((next) => setState(next))
    return () => {
      alive = false
      off()
    }
  }, [])

  return state
}

/**
 * A shared clock for countdowns. It is disabled while nothing can expire, so
 * an idle inbox does not re-render the whole window once per second.
 */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!enabled) return
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs, enabled])
  return now
}
