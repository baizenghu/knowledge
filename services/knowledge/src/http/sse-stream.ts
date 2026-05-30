import type { Response } from "express";

export interface SseStreamOptions {
  heartbeatIntervalMs?: number;
}

export interface SseStream {
  isClosed(): boolean;
  write(chunk: string): boolean;
  writeData(payload: unknown): boolean;
  writeComment(comment: string): boolean;
  registerCleanup(fn: () => void): () => void;
  close(finalPayload?: unknown): void;
}

export function createSseStream(
  res: Pick<Response, "on" | "write" | "end" | "writableEnded">,
  options?: SseStreamOptions,
): SseStream {
  let closed = false;
  const cleanupFns = new Set<() => void>();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    for (const fn of [...cleanupFns]) {
      cleanupFns.delete(fn);
      try {
        fn();
      } catch {
        // ignore cleanup failures
      }
    }
  };

  const heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 0;
  if (heartbeatIntervalMs > 0) {
    const heartbeat = setInterval(() => {
      if (!closed) {
        try {
          res.write(": heartbeat\n\n");
        } catch {
          cleanup();
        }
      }
    }, heartbeatIntervalMs);
    heartbeat.unref?.();
    cleanupFns.add(() => clearInterval(heartbeat));
  }

  res.on("close", cleanup);
  res.on("error", cleanup);

  const write = (chunk: string): boolean => {
    if (closed || res.writableEnded) {
      return false;
    }
    try {
      res.write(chunk);
      return true;
    } catch {
      cleanup();
      return false;
    }
  };

  return {
    isClosed: () => closed || res.writableEnded,
    write,
    writeData(payload: unknown): boolean {
      return write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    writeComment(comment: string): boolean {
      return write(`: ${comment}\n\n`);
    },
    registerCleanup(fn: () => void): () => void {
      if (closed) {
        try {
          fn();
        } catch {
          // ignore cleanup failures
        }
        return () => {};
      }
      cleanupFns.add(fn);
      return () => cleanupFns.delete(fn);
    },
    close(finalPayload?: unknown): void {
      if (finalPayload !== undefined) {
        write(`data: ${JSON.stringify(finalPayload)}\n\n`);
      }
      if (!closed) {
        cleanup();
      }
      try {
        res.end();
      } catch {
        // ignore end failures
      }
    },
  };
}
