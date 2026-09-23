/**
 * 输出被下游提前关闭（`tenon resources list | head`）时 stdout/stderr 的写会以 EPIPE 失败；Node 把它当作
 * 未处理的 'error' 事件抛出一整段堆栈。读者已经拿够了，这不是错误：静默结束进程，退出码沿用已设定的
 * `process.exitCode`（缺省 0）。其它流错误原样重新抛出，不被吞掉。
 */
interface ErrorEmitter {
  on(event: 'error', listener: (error: unknown) => void): unknown
}

export function isEpipe(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'EPIPE'
}

export function exitQuietlyOnEpipe(streams: readonly ErrorEmitter[], exit: () => void): void {
  for (const stream of streams) {
    stream.on('error', (error) => {
      if (isEpipe(error)) {
        exit()
        return
      }
      throw error
    })
  }
}
