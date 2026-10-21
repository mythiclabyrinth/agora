/* Strip a leading wake phrase from a transcript. A wake recording starts at
   the detection, but the tail of the phrase (or all of it, if the user
   repeats it) often makes it into the transcript: "Hey Agora, what's on my
   list?" -> "what's on my list?". Port of the ESP32 desk's WakeText.h
   (wakePhraseEnd), kept pure for unit tests. */

const GREETINGS = ["hey", "hi", "hay", "hei", "a", "okay", "ok"];
const ALIASES = ["agora", "jarvis"];
const ADDRESS_PUNCT = ",.!?:;";

// Letters, digits, apostrophes and anything non-ASCII (accented names) count
// as word characters, as in the firmware.
function wordChar(c: string): boolean {
  return /[A-Za-z0-9']/.test(c) || c.charCodeAt(0) > 0x7f;
}

function skipGap(text: string, at: number): number {
  while (at < text.length && !wordChar(text[at])) at++;
  return at;
}

function wordEnd(text: string, at: number): number {
  while (at < text.length && wordChar(text[at])) at++;
  return at;
}

/** Index where the message starts once a leading wake phrase is removed, or
 *  0 if the text does not start with one. `names` are extra wake names in
 *  lowercase ("claude"); "agora" and "jarvis" are always accepted. */
export function wakePhraseEnd(text: string, names: readonly string[] = []): number {
  if (!text) return 0;
  const isName = (word: string) => {
    const w = word.toLowerCase();
    return names.includes(w) || ALIASES.includes(w);
  };

  const first = skipGap(text, 0);
  const firstEnd = wordEnd(text, first);
  if (firstEnd === first) return 0;

  let end = 0;
  if (GREETINGS.includes(text.slice(first, firstEnd).toLowerCase())) {
    const second = skipGap(text, firstEnd);
    const secondEnd = wordEnd(text, second);
    if (secondEnd > second && isName(text.slice(second, secondEnd))) end = secondEnd;
  } else if (
    isName(text.slice(first, firstEnd)) &&
    firstEnd < text.length &&
    ADDRESS_PUNCT.includes(text[firstEnd])
  ) {
    // A bare name only counts when it is addressed ("Agora, ..."), so a
    // message about the app itself ("Agora is slow") keeps its first word.
    end = firstEnd;
  }
  if (!end) return 0;
  return skipGap(text, end);
}

/** The transcript with any leading wake phrase removed. */
export function stripWakePhrase(text: string, names: readonly string[] = []): string {
  return text.slice(wakePhraseEnd(text, names));
}
