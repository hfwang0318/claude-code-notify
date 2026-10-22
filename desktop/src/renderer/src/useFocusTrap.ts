import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hasAttribute('hidden') &&
      element.getAttribute('aria-hidden') !== 'true' &&
      element.tabIndex !== -1
  )
}

/**
 * 模态弹窗焦点陷阱：
 * - 激活时把焦点移到容器内第一个可聚焦元素；
 * - Tab / Shift+Tab 在容器内循环；
 * - 关闭时把焦点还给打开弹窗前的元素；
 * - 可选 onEscape 回调用于保留弹窗自身的 Esc 关闭逻辑。
 */
export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onEscape?: () => void
): void {
  const escapeHandler = useRef(onEscape)

  useEffect(() => {
    escapeHandler.current = onEscape
  }, [onEscape])

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null

    const focusFirst = (): void => {
      const [first] = focusableElements(container)
      if (first) {
        first.focus()
        return
      }
      if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1')
      container.focus()
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && escapeHandler.current) {
        event.preventDefault()
        escapeHandler.current()
        return
      }
      if (event.key !== 'Tab') return

      const focusables = focusableElements(container)
      if (focusables.length === 0) {
        event.preventDefault()
        container.focus()
        return
      }

      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const index = focusables.findIndex((element) => element === document.activeElement)

      if (!event.shiftKey) {
        if (index === -1 || index === focusables.length - 1) {
          event.preventDefault()
          first.focus()
        }
      } else if (index <= 0) {
        event.preventDefault()
        last.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    focusFirst()

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus()
    }
  }, [active, containerRef])
}
