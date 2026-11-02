// What the caller has actually heard (LEA-155). OpenAI streams its speech several times faster than real time, so the
// phone line holds seconds of audio that has been generated but not played yet. This clock models that queue: every
// audio chunk we send adds its playing time, and time moving on "plays" it. It answers two questions when the caller
// starts talking: is the assistant still audible, and how much of the current sentence did the caller hear.

// The last bit of queued audio is not counted as being talked over.
export const AUDIBLE_MARGIN_MS = 200;

interface QueuedItem {
  id: string;
  startsAt: number; // when its first chunk begins to play
  totalMs: number; // how much audio it holds so far
}

export class PlaybackClock {
  private playbackEndsAt = 0;
  private items: QueuedItem[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** A chunk of speech belonging to `itemId` was sent to the caller; it plays for `durationMs`. */
  audio(itemId: string, durationMs: number): void {
    const t = this.now();
    const last = this.items[this.items.length - 1];
    if (last && last.id === itemId) {
      last.totalMs += durationMs;
    } else {
      this.items.push({ id: itemId, startsAt: Math.max(t, this.playbackEndsAt), totalMs: durationMs });
    }
    this.playbackEndsAt = Math.max(t, this.playbackEndsAt) + durationMs;
    // Items that finished playing long ago are of no use any more.
    while (this.items.length > 1 && this.items[0].startsAt + this.items[0].totalMs < t - 5000) this.items.shift();
  }

  /** Is the assistant still audible, i.e. is more than a moment of queued speech left? */
  audible(): boolean {
    return this.playbackEndsAt - AUDIBLE_MARGIN_MS > this.now();
  }

  /** Milliseconds of queued speech the caller has not heard yet. */
  remainingMs(): number {
    return Math.max(0, Math.round(this.playbackEndsAt - this.now()));
  }

  /** The item being played right now (the one a barge-in cuts), with how many ms of it the caller heard. */
  playing(): { itemId: string; playedMs: number } | null {
    const t = this.now();
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item.startsAt <= t) {
        return { itemId: item.id, playedMs: Math.max(0, Math.min(item.totalMs, Math.round(t - item.startsAt))) };
      }
    }
    // Everything queued is still waiting: the caller has heard none of the first item.
    return this.items.length > 0 ? { itemId: this.items[0].id, playedMs: 0 } : null;
  }

  /** The phone line's queue was emptied (or the speech was cancelled): nothing is left to hear. */
  clear(): void {
    this.items = [];
    this.playbackEndsAt = 0;
  }
}
