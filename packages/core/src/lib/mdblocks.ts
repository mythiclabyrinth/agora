/* Line-level block pass shared by mdlite (tree) and mdliteHtml (HTML):
   splits raw message text into plain-text runs, `>` blockquotes and
   `-`/`*`/`1.` lists, leaving everything else to each renderer's existing
   inline/fence/table grammar. Quote bodies and list items come back as raw
   markdown so the caller re-renders them recursively (a quote can hold a
   list or a code fence; a list item can hold a nested list or a fence).
   Fence-aware throughout: a `>` or `-` inside a code fence stays literal. */

export type ListItemSegment = { text: string };

export type MdSegment =
  | { kind: "text"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: ListItemSegment[] };

// `>` then a space, another `>` (a nested `>>` quote) or end of line:
// `>=` / `>foo` stay prose.
const QUOTE = /^ {0,3}> ?([^\n]*)$/;
const QUOTE_START = /^ {0,3}>(?:[ >]|$)/;
// One- to three-digit ordinals so `2026. was a year` stays prose; a marker
// needs a following space so `-5`, `->` and `**bold**` stay prose too.
// `+` is left out on purpose: "+ 1, agreed" and diff-style "+ added X"
// lines in chat are prose far more often than bullets.
const ITEM = /^( {0,3})([-*]|\d{1,3}[.)])[ \t]+(\S[^\n]*)$/;
// `* * *`, `- - -`, `___`: a divider, not a list item.
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE_AT_START = /^\s*```/;

/** Whether this line leaves a fence open: an odd number of ``` on it, the
    same way the renderers pair fences anywhere in the text (`x ```js`). */
function opensFence(line: string): boolean {
  return (line.split("```").length - 1) % 2 === 1;
}

function itemOf(line: string): RegExpExecArray | null {
  return RULE.test(line) ? null : ITEM.exec(line);
}

/** Past this nesting depth quotes and lists render as plain text. */
export const MAX_BLOCK_DEPTH = 4;

/** Index just past the fence opened at `lines[i]`, or -1 when nothing closes
    it — an unpaired ``` is prose to the renderers, so it must not swallow
    the quotes and lists after it. */
function fenceEnd(lines: string[], i: number): number {
  for (let j = i + 1; j < lines.length; j++) if (opensFence(lines[j])) return j + 1;
  return -1;
}

/** Index just past the first bare ``` line from `i`, or -1 if a different
    fence line, a blank line (where a reply would start) or nothing comes
    first. Stopping at the blank line also bounds the scan. */
function bareCloserAfter(lines: string[], i: number): number {
  for (let j = i; j < lines.length; j++) {
    if (lines[j].trim() === "") return -1;
    if (!lines[j].includes("```")) continue;
    return /^\s*```\s*$/.test(lines[j]) ? j + 1 : -1;
  }
  return -1;
}

function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)![0].replace(/\t/g, "    ").length;
}

/** Strip up to `n` leading spaces (tabs count as four). */
function dedent(line: string, n: number): string {
  let i = 0, col = 0;
  while (i < line.length && col < n && (line[i] === " " || line[i] === "\t")) {
    // A tab wider than the indent left to strip stays: removing it would
    // eat code indentation (Python, Makefiles) the fence never had.
    if (line[i] === "\t" && col + 4 > n) break;
    col += line[i] === "\t" ? 4 : 1;
    i++;
  }
  return line.slice(i);
}

function isOrdered(marker: string): boolean {
  return /\d/.test(marker);
}

/** Drop whitespace-only lines from the start and/or end, in linear time (an
    unanchored regex like /(?:\n[ \t]*)+$/ is quadratic on long blank runs,
    and a message can hold ~20k of them). */
export function trimBlankLines(text: string, edges: "start" | "end" | "both" = "both"): string {
  const lines = text.split("\n");
  let from = 0, to = lines.length;
  if (edges !== "end") while (from < to - 1 && lines[from].trim() === "") from++;
  if (edges !== "start") while (to > from + 1 && lines[to - 1].trim() === "") to--;
  const kept = lines.slice(from, to).join("\n");
  return kept.trim() === "" ? "" : kept;
}

/** `inItem`: the text is a list item's body, where an ordered sub-list may
    start at any number right under the item's text ("Setup:\n3. run"). */
export function splitMdBlocks(text: string, opts: { inItem?: boolean } = {}): MdSegment[] {
  // CRLF/CR text (Windows clients, some bridges) would otherwise leave a
  // trailing \r on every line for the markers below to trip over.
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: MdSegment[] = [];
  let plain: string[] = [];
  const flushPlain = () => {
    if (plain.length) out.push({ kind: "text", text: plain.join("\n") });
    plain = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (QUOTE_START.test(line)) {
      // The run ends at the first line without a `>`; a quoted fence is
      // handled when the body is re-rendered.
      const start = i;
      const body: string[] = [];
      // Running ``` count, so absorbing closers stays linear in the quote size.
      let fences = 0;
      const take = (l: string) => { body.push(l); fences += l.split("```").length - 1; };
      for (;;) {
        while (i < lines.length) {
          const m = QUOTE_START.test(lines[i]) ? QUOTE.exec(lines[i]) : null;
          if (!m) break;
          take(m[1]);
          i++;
        }
        // A quoted fence whose later lines dropped their `>` (common in model
        // output) still belongs to the quote up to its bare closing ```, and
        // the quote carries on after it; otherwise the stray closer would
        // open a new fence and swallow the rest of the message. Only a bare
        // ``` closes: an opener like ```js on the way means it isn't ours.
        const close = fences % 2 === 1 ? bareCloserAfter(lines, i) : -1;
        if (close === -1) break;
        for (; i < close; i++) take(lines[i]);
      }
      // Blank `>` lines at the edges carry nothing (mobile drops them too); a
      // quote with nothing else in it — a pasted `>` prompt — stays prose.
      // `i > start` also guarantees progress if the regexes ever disagree.
      const quoted = trimBlankLines(body.join("\n"));
      if (!quoted.trim() || i === start) {
        for (let j = start; j < Math.max(i, start + 1); j++) plain.push(lines[j]);
        i = Math.max(i, start + 1);
        continue;
      }
      flushPlain();
      out.push({ kind: "quote", text: quoted });
      continue;
    }
    const item = itemOf(line);
    // An ordered list numbered other than 1 may not interrupt a paragraph:
    // "dropped by\n15. That is…" is a wrapped sentence. Bullets and `1.` lists
    // do interrupt (agents write "Steps:\n- a" with no blank line).
    const prevPlain = plain.length ? plain[plain.length - 1] : "";
    // A label line ("Steps:", "**Phase 2**") introduces a list at any number.
    const isLabel = /:\s*$/.test(prevPlain) || /^\s*\*\*[^*]+\*\*:?\s*$/.test(prevPlain);
    const interruptsProse = prevPlain.trim() !== "" && !opensFence(prevPlain) && !isLabel
      && !/^#{1,4}\s/.test(prevPlain) && !/^\s*\|/.test(prevPlain);
    if (item && !(interruptsProse && !opts.inItem && isOrdered(item[2]) && parseInt(item[2], 10) !== 1)) {
      flushPlain();
      i = takeList(lines, i, out);
      continue;
    }
    // Checked after quotes and items, whose own line may open a fence
    // (`> ```js`, `- run ```bash`); those fences belong to that block.
    const end = opensFence(line) ? fenceEnd(lines, i) : -1;
    if (end !== -1) {
      // An indented fence (common under a list item that didn't parse as
      // one) loses its own indentation on every code line.
      const pad = FENCE_AT_START.test(line) ? indentOf(line) : 0;
      for (let j = i; j < end; j++) plain.push(pad ? dedent(lines[j], pad) : lines[j]);
      i = end;
      continue;
    }
    plain.push(line);
    i++;
  }
  flushPlain();
  return out;
}

/** An item indented less than two columns past the list's own indent is a
    sibling (LLM output is often off by one either way), not a child. */
function isSibling(item: RegExpExecArray, baseIndent: number): boolean {
  return Math.abs(item[1].length - baseIndent) < 2;
}

/** Collect one list starting at `lines[start]`; returns the next index. */
function takeList(lines: string[], start: number, out: MdSegment[]): number {
  const first = itemOf(lines[start])!;
  const baseIndent = first[1].length;
  const ordered = isOrdered(first[2]);
  const items: ListItemSegment[] = [];
  let i = start;
  while (i < lines.length) {
    const m = itemOf(lines[i]);
    if (!m || !isSibling(m, baseIndent) || isOrdered(m[2]) !== ordered) break;
    // Continuation lines align under the item text; dedent by that width
    // (capped, so a 4-space-indented child under `1.` still nests).
    const contentCol = Math.min(m[0].length - m[3].length, m[1].length + m[2].length + 4);
    const body = [m[3]];
    i++;
    // `- run ```bash` opens a fence on the item line itself; its code lines
    // belong to the item however they're indented. A mid-line ``` is only
    // taken as an opener when a bare closer follows before any blank line —
    // "- Wrap code in ``` fences" must not swallow the items after it.
    const itemFenceEnd = !opensFence(m[3]) ? -1
      : FENCE_AT_START.test(m[3]) ? fenceEnd(lines, i - 1) : bareCloserAfter(lines, i);
    for (; i < itemFenceEnd; i++) body.push(dedent(lines[i], contentCol));
    while (i < lines.length) {
      const next = lines[i];
      if (next.trim() === "") {
        // A blank line keeps the list going only if indented content or a
        // sibling item follows; otherwise it ends the list.
        let k = i;
        while (k < lines.length && lines[k].trim() === "") k++;
        if (k >= lines.length) break;
        const after = lines[k];
        const sib = itemOf(after);
        if (indentOf(after) > baseIndent && !(sib && isSibling(sib, baseIndent))) {
          for (; i < k; i++) body.push("");
          continue;
        }
        if (sib && isSibling(sib, baseIndent) && isOrdered(sib[2]) === ordered) { i = k; break; }
        break;
      }
      // An unindented fence straight under the item's text (a very common
      // model shape: "1. Run:\n```bash … ```\n2. Then…") belongs to the item.
      if (indentOf(next) <= baseIndent && FENCE_AT_START.test(next) && body[body.length - 1]?.trim()) {
        const end = fenceEnd(lines, i);
        if (end !== -1) {
          for (let j = i; j < end; j++) body.push(dedent(lines[j], indentOf(next)));
          i = end;
          continue;
        }
      }
      // Any other unindented line ends the list: in chat, a sign-off right
      // after a list ("Thanks!") is far likelier than a hard-wrapped bullet.
      if (indentOf(next) <= baseIndent) break;
      const nextItem = itemOf(next);
      if (nextItem && isSibling(nextItem, baseIndent)) break;
      const end = !opensFence(next) ? -1
        : FENCE_AT_START.test(next) ? fenceEnd(lines, i) : bareCloserAfter(lines, i + 1);
      if (end !== -1) {
        for (let j = i; j < end; j++) body.push(dedent(lines[j], contentCol));
        i = end;
        continue;
      }
      body.push(dedent(next, contentCol));
      i++;
    }
    items.push({ text: body.join("\n") });
  }
  out.push({ kind: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items });
  return i;
}
