import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { toastIn, toastOut, type MotionHandle } from './motion'

export interface Flash {
  readonly kind: 'toast' | 'error'
  readonly msg: string
}

const FLASH_MS = 4000

/** 自研 toast：GSAP 滑入；4s 后先播退场，播完才卸载。新消息或切换语言会中止退场。 */
export function useFlash(language: string): {
  readonly flash: Flash | null
  readonly flashRef: RefObject<HTMLDivElement>
  readonly showFlash: (kind: Flash['kind'], message: string) => void
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

  const showFlash = useCallback((kind: Flash['kind'], message: string): void => {
    stopPending()
    setFlash({ kind, msg: message })
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
    }, FLASH_MS)
  }, [stopPending])

  return { flash, flashRef, showFlash }
}
