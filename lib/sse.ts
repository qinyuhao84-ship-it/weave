type Stream = { send: (payload: unknown) => void; close: () => void; onCleanup: (cleanup: () => void) => void };

/** 共用 SSE 编码、心跳与断连清理；取消订阅不会取消后台任务。 */
export function sseResponse(request: Request, setup: (stream: Stream) => void): Response {
  const encoder = new TextEncoder();
  let cancel = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const cleanups: Array<() => void> = [];
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        request.signal.removeEventListener("abort", close);
        for (const cleanup of cleanups) { try { cleanup(); } catch { /* 单个清理失败不阻塞其余订阅释放。 */ } }
        try { controller.close(); } catch { /* 已断开。 */ }
      };
      cancel = close;
      const enqueue = (text: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(text)); } catch { close(); }
      };
      const heartbeat = setInterval(() => enqueue(": ping\n\n"), 15_000);
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) { close(); return; }
      try {
        setup({
          send: payload => enqueue(`data: ${JSON.stringify(payload)}\n\n`), close,
          // subscribe() 可同步补发终态，在取得 unsubscribe 前就关闭流。
          onCleanup: cleanup => { if (closed) cleanup(); else cleanups.push(cleanup); },
        });
      } catch (error) { close(); throw error; }
    },
    cancel() { cancel(); },
  });
  return new Response(body, { headers: {
    "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive", "X-Accel-Buffering": "no",
  } });
}
