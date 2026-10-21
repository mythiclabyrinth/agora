/* Splits the assistant's streamed answer into sentences as they complete,
   so each can be synthesized and spoken while the rest is still streaming.
   Offsets index the full answer text (for highlighting what is spoken). */

export interface Sentence {
  text: string;
  start: number;
  end: number;
}

// Abbreviations whose period does not end a sentence.
const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "st", "vs", "etc", "e.g", "i.e", "approx", "no"]);
// Sentence punctuation, optional closing quotes/brackets, then whitespace.
const BOUNDARY = /[.!?…]+["'”’)\]]*\s+|\n+/g;

export interface SentenceChunker {
  /** Add streamed text; returns the sentences it completed. */
  push(text: string): Sentence[];
  /** The stream ended: whatever is left, as a final sentence. */
  flush(): Sentence[];
}

/** Longest piece sent to /api/jarvis/speech, under the server's 600-character
    cap: a run-on sentence (a long draft read back) is cut at word gaps. */
export const MAX_SPOKEN_CHARS = 500;

function splitLong(s: Sentence): Sentence[] {
  const out: Sentence[] = [];
  let { text, start } = s;
  while (text.length > MAX_SPOKEN_CHARS) {
    const window = text.slice(0, MAX_SPOKEN_CHARS + 1);
    const comma = window.search(/[,;:][^,;:]*$/);
    const space = window.lastIndexOf(" ");
    const cut = comma > MAX_SPOKEN_CHARS / 2 ? comma + 1 : space > 0 ? space : MAX_SPOKEN_CHARS;
    const head = text.slice(0, cut).trimEnd();
    out.push({ text: head, start, end: start + head.length });
    const rest = text.slice(cut);
    const skip = rest.length - rest.trimStart().length;
    start += cut + skip;
    text = rest.trimStart();
  }
  if (text) out.push({ text, start, end: start + text.length });
  return out;
}

export function createSentenceChunker(): SentenceChunker {
  let full = "";
  let from = 0; // start of the unspoken remainder in `full`

  const take = (end: number, next: number): Sentence[] => {
    const raw = full.slice(from, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    const start = from + lead;
    from = next;
    return text && /[\p{L}\p{N}]/u.test(text) ? splitLong({ text, start, end: start + text.length }) : [];
  };

  return {
    push(chunk) {
      full += chunk;
      const out: Sentence[] = [];
      BOUNDARY.lastIndex = from;
      let m: RegExpExecArray | null;
      while ((m = BOUNDARY.exec(full))) {
        const end = m.index + m[0].trimEnd().length;
        // "Dr. Smith", "e.g. this": not a boundary.
        const word = /([\p{L}.]+)\.$/u.exec(full.slice(from, end))?.[1]?.toLowerCase();
        if (m[0][0] === "." && word && ABBREVIATIONS.has(word)) continue;
        out.push(...take(end, m.index + m[0].length));
      }
      return out;
    },
    flush() {
      return take(full.length, full.length);
    },
  };
}
