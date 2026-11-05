// LEA-164: cuts the text of an answer, which arrives word by word, into pieces worth speaking. A short first piece (a clause)
// lets the voice start sooner; the rest go sentence by sentence so the intonation stays natural.

const ABBREVIATIONS = new Set(["tj", "tzn", "např", "atd", "apod", "mj", "tzv", "str", "č", "p", "pí", "ing", "mgr", "mudr", "judr", "bc", "prof", "dr", "resp", "cca", "min", "max"]);
const SENTENCE_END = /[.!?…]/;
const CLAUSE_END = /[,;:–—]/;
// LEA-181: 12 characters (was 25), so the voice can start on the first short clause.
const FIRST_CLAUSE_MIN = 12;
const MIN_CHUNK = 8;

export class SentenceChunker {
  private buffer = "";
  private first = true;

  /** Add the next piece of text; returns the pieces that are complete now. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      const at = this.boundary();
      if (at < 0) break;
      const piece = this.buffer.slice(0, at + 1).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (piece) { out.push(piece); this.first = false; }
    }
    return out;
  }

  /** The answer is over: whatever is left is the last piece. */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (!rest) return [];
    this.first = false;
    return [rest];
  }

  /** A new answer starts (also after an interruption). */
  reset(): void {
    this.buffer = "";
    this.first = true;
  }

  // Index of the last character of the first complete piece in the buffer, or -1.
  private boundary(): number {
    const b = this.buffer;
    for (let i = 0; i < b.length; i++) {
      const ch = b[i];
      const sentenceEnd = SENTENCE_END.test(ch);
      const clauseEnd = this.first && CLAUSE_END.test(ch) && i + 1 >= FIRST_CLAUSE_MIN;
      if (!sentenceEnd && !clauseEnd) continue;
      // A piece ends only once the next character shows it is over (a space or the start of another word).
      if (i + 1 >= b.length) return -1;
      if (!/\s/.test(b[i + 1])) continue;
      if (sentenceEnd && ch === "." && this.isNotAnEnd(i)) continue;
      if (b.slice(0, i + 1).trim().length < MIN_CHUNK) continue;
      return i;
    }
    return -1;
  }

  // "4. listopadu", "14. 30", "tj. dnes": the period belongs to the word or number, not to the sentence.
  private isNotAnEnd(dotAt: number): boolean {
    const before = this.buffer.slice(0, dotAt);
    const after = this.buffer.slice(dotAt + 1).trimStart();
    const nextStartsLower = /^[a-záčďéěíňóřšťúůýž]/.test(after);
    const nextIsDigit = /^\d/.test(after);
    const word = /([A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž]+|\d+)$/.exec(before)?.[1] ?? "";
    if (/^\d{1,2}$/.test(word) && (nextStartsLower || nextIsDigit)) return true; // ordinal number or date
    if (ABBREVIATIONS.has(word.toLowerCase()) && nextStartsLower) return true;
    return false;
  }
}
