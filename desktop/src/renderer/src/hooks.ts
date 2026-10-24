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

/** A shared one-second clock for countdowns and relative timestamps. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}
