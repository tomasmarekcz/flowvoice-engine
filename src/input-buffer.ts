// Holds the caller's audio between "the call connected" and "the assistant is ready to listen" (LEA-155), so the first
// words are not lost. It keeps the newest frames only; a frame is one 20 ms piece of phone audio.

export const MAX_BUFFERED_FRAMES = 75; // 1.5 s

export class InputBuffer {
  private frames: string[] = [];

  constructor(private readonly max: number = MAX_BUFFERED_FRAMES) {}

  push(frame: string): void {
    this.frames.push(frame);
    if (this.frames.length > this.max) this.frames.shift();
  }

  /** Everything held so far, oldest first; the buffer is empty afterwards. */
  drain(): string[] {
    const out = this.frames;
    this.frames = [];
    return out;
  }

  get size(): number {
    return this.frames.length;
  }
}
