/**
 * Minimal Server-Sent Events channel on top of an Express response.
 * Handles header setup, backpressure, heartbeats and client aborts (EPIPE).
 */
import type { Response } from 'express';

export interface SseChannel {
  /** Sends one event; resolves after the write is flushed (waits for drain on backpressure). */
  send(event: string, data: unknown): Promise<void>;
  /** Sends an SSE comment line (ignored by EventSource clients). */
  comment(text: string): void;
  /** Starts a heartbeat comment ("hb") every ms milliseconds; returns a stop function. */
  startHeartbeat(ms: number): () => void;
  /** Stops heartbeats and ends the response. Idempotent. */
  close(): void;
  /** True while the response can still be written to. */
  isOpen(): boolean;
}

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MIN_HEARTBEAT_MS = 100;
const DEFAULT_HEARTBEAT_MS = 15000;

export function openSse(res: Response): SseChannel {
  let closed = false;
  const heartbeatStops = new Set<() => void>();

  const stopAllHeartbeats = (): void => {
    for (const stop of Array.from(heartbeatStops)) stop();
  };

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  try {
    res.socket?.setNoDelay(true);
  } catch {
    // The socket may already be gone; there is nothing to tune in that case.
  }

  // EPIPE and similar write errors on client abort must never crash the process.
  res.on('error', () => {
    closed = true;
    stopAllHeartbeats();
  });
  res.on('close', () => {
    closed = true;
    stopAllHeartbeats();
  });

  const isWritable = (): boolean => !closed && !res.writableEnded && !res.destroyed;

  const writeFrame = (frame: string): Promise<void> => {
    if (!isWritable()) return Promise.resolve();
    let flushed = true;
    try {
      flushed = res.write(frame);
    } catch {
      closed = true;
      return Promise.resolve();
    }
    if (flushed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const release = (): void => {
        res.off('drain', release);
        res.off('close', release);
        resolve();
      };
      res.once('drain', release);
      res.once('close', release);
    });
  };

  return {
    async send(event: string, data: unknown): Promise<void> {
      if (!EVENT_NAME_PATTERN.test(event)) {
        throw new Error('invalid SSE event name');
      }
      const payload = JSON.stringify(data === undefined ? null : data);
      await writeFrame('event: ' + event + '\ndata: ' + payload + '\n\n');
    },

    comment(text: string): void {
      const line = text.replace(/[\r\n]+/g, ' ');
      void writeFrame(': ' + line + '\n\n');
    },

    startHeartbeat(ms: number): () => void {
      const interval = Number.isFinite(ms) ? Math.max(MIN_HEARTBEAT_MS, Math.floor(ms)) : DEFAULT_HEARTBEAT_MS;
      const timer = setInterval(() => {
        if (!isWritable()) return;
        try {
          res.write(': hb\n\n');
        } catch {
          closed = true;
        }
      }, interval);
      timer.unref();
      let stopped = false;
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        heartbeatStops.delete(stop);
      };
      heartbeatStops.add(stop);
      return stop;
    },

    close(): void {
      stopAllHeartbeats();
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {
          // Already closed by the client.
        }
      }
      closed = true;
    },

    isOpen(): boolean {
      return isWritable();
    },
  };
}
