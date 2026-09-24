import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { toastIn, toastOut, type MotionHandle } from './motion'

/** 提示气泡里的一个动作（如归档后的「撤销」）。 */
export interface FlashAction {
  readonly label: string
  readonly run: () => void
}

export interface Flash {
  readonly kind: 'toast' | 'error'
  readonly msg: string
  readonly action?: FlashAction
}

const FLASH_MS = 4000
/** 带动作的提示多留一会儿，够用户去点。 */
const FLASH_ACTION_MS = 8000

/** 自研 toast：GSAP 滑入；4s 后先播退场，播完才卸载。新消息或切换语言会中止退场。 */
export function useFlash(language: string): {
  readonly flash: Flash | null
  readonly flashRef: RefObject<HTMLDivElement>
  readonly showFlash: (kind: Flash['kind'], message: string, action?: FlashAction) => void
} {
  const [flash, setFlash] = useState<Flash | null>(null)
  const flashRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | null>(null)
  const exitRef = useRef<MotionHandle | null>(null)

  const stopPending = useCallback((): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    exitRef.current?.kill()
    exitRef.current = null
  }, [])

  useEffect(() => {
    stopPending()
    setFlash(null)
  }, [language, stopPending])

  useEffect(() => {
    if (!flash || !flashRef.current) return
    const tween = toastIn(flashRef.current)
    return () => tween.kill()
  }, [flash])

  useEffect(() => stopPending, [stopPending])

  const showFlash = useCallback((kind: Flash['kind'], message: string, action?: FlashAction): void => {
    stopPending()
    setFlash(action === undefined ? { kind, msg: message } : { kind, msg: message, action })
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      const el = flashRef.current
      if (!el) {
        setFlash(null)
        return
      }
      exitRef.current = toastOut(el, () => {
        exitRef.current = null
        setFlash(null)
      })
    }, action === undefined ? FLASH_MS : FLASH_ACTION_MS)
  }, [stopPending])

  return { flash, flashRef, showFlash }
}
