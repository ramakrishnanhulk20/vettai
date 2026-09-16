/**
 * Waits, and gives up waiting the moment the signal is aborted.
 *
 * Every loop in the treasury and every scripted run uses this one, so a shutdown never has
 * to sit through a three second poll before the process can exit. Without a signal it is
 * a plain timer.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }

  if (signal.aborted) return Promise.resolve()

  return new Promise((resolve) => {
    const stop = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      resolve()
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      resolve()
    }, ms)

    signal.addEventListener('abort', stop, { once: true })
  })
}
