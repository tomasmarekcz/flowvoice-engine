// Buffers log events in memory and ships them to CloudWatch Logs in batches.
// Contract: push() never throws and never blocks; if AWS is unreachable events are dropped.

type Entry = { timestamp: number; message: string };

export interface CloudWatchTransport {
  ensureStream(group: string, stream: string): Promise<void>;
  put(group: string, stream: string, events: Entry[]): Promise<void>;
}

export type SinkOptions = {
  group: string;
  stream: string;
  transport: CloudWatchTransport;
  flushIntervalMs?: number;
  maxBatchEvents?: number;
  maxBatchBytes?: number;
  maxQueue?: number;
  maxPerMinute?: number;
  now?: () => number;
  onError?: (message: string) => void;
};

const EVENT_OVERHEAD_BYTES = 26; // CloudWatch counts 26 bytes per event on top of the message
const BACKOFF_MS = 30_000;
const ERROR_REPORT_EVERY_MS = 60_000;

export class CloudWatchSink {
  private queue: Entry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  private streamReady = false;
  private minute = -1;
  private countInMinute = 0;
  private dropped = 0;
  private lastErrorAt = -Infinity;
  private pausedUntil = 0;
  private readonly o: Required<SinkOptions>;

  constructor(options: SinkOptions) {
    this.o = {
      flushIntervalMs: 2000,
      maxBatchEvents: 100,
      maxBatchBytes: 256 * 1024,
      maxQueue: 5000,
      maxPerMinute: 2000,
      now: () => Date.now(),
      onError: (m) => { process.stderr.write(`[log-sink] ${m}\n`); },
      ...options,
    };
  }

  push(event: Record<string, unknown>): void {
    try {
      const nowMs = this.o.now();
      const minute = Math.floor(nowMs / 60_000);
      if (minute !== this.minute) {
        const dropped = this.dropped;
        this.minute = minute;
        this.countInMinute = 0;
        this.dropped = 0;
        if (dropped > 0) {
          this.enqueue(nowMs, {
            ts: new Date(nowMs).toISOString(),
            level: "warn",
            service: event.service,
            event: "log.rate_limited",
            message: "log rate limit hit, events dropped",
            data: { dropped },
          });
        }
      }
      if (this.countInMinute >= this.o.maxPerMinute) {
        this.dropped++;
        return;
      }
      this.countInMinute++;
      this.enqueue(nowMs, event);
    } catch {
      /* logging must never break the caller */
    }
  }

  private enqueue(nowMs: number, event: Record<string, unknown>): void {
    this.queue.push({ timestamp: nowMs, message: JSON.stringify(event) });
    if (this.queue.length > this.o.maxQueue) this.queue.shift();
    if (this.queue.length >= this.o.maxBatchEvents) void this.flush();
  }

  flush(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.drain().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  private async drain(): Promise<void> {
    if (this.o.now() < this.pausedUntil) return;
    try {
      while (this.queue.length) await this.send(this.takeBatch());
    } catch (e) {
      this.pausedUntil = this.o.now() + BACKOFF_MS;
      this.report(e);
    }
  }

  private takeBatch(): Entry[] {
    const batch: Entry[] = [];
    let bytes = 0;
    while (this.queue.length && batch.length < this.o.maxBatchEvents) {
      const size = Buffer.byteLength(this.queue[0].message) + EVENT_OVERHEAD_BYTES;
      if (batch.length && bytes + size > this.o.maxBatchBytes) break;
      bytes += size;
      batch.push(this.queue.shift() as Entry);
    }
    return batch.sort((a, b) => a.timestamp - b.timestamp);
  }

  private async send(batch: Entry[]): Promise<void> {
    if (!batch.length) return;
    const { transport, group, stream } = this.o;
    if (!this.streamReady) {
      await transport.ensureStream(group, stream);
      this.streamReady = true;
    }
    try {
      await transport.put(group, stream, batch);
    } catch (e) {
      if ((e as { name?: string })?.name !== "ResourceNotFoundException") throw e;
      this.streamReady = false;
      await transport.ensureStream(group, stream);
      this.streamReady = true;
      await transport.put(group, stream, batch);
    }
  }

  private report(e: unknown): void {
    const t = this.o.now();
    if (t - this.lastErrorAt < ERROR_REPORT_EVERY_MS) return;
    this.lastErrorAt = t;
    try {
      this.o.onError(`CloudWatch write failed: ${e instanceof Error ? e.message : String(e)}`);
    } catch {
      /* ignore */
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, this.o.flushIntervalMs);
    this.timer.unref?.();
    process.once("beforeExit", () => { void this.flush(); });
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}
