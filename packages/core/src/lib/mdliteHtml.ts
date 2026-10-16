/* HTML-emitting markdown-lite for chat messages: fenced code (incl. the
   .md-mermaid/.md-echarts markers), inline code, links, bold/italic, headings,
   tables, `>` blockquotes and `-`/`1.` lists — with esc() applied to
   everything interpolated. (lib/mdlite.ts is the tree-parsing variant the
   mobile app renders natively; both ship so either host can pick.) */

import { MAX_BLOCK_DEPTH, splitMdBlocks, trimBlankLines } from "./mdblocks";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function unesc(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) =>
    ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e] as string);
}

/** Rendered HTML plus the raw text each copy button copies. The copy text
    stays out of the HTML (buttons carry only `data-copy-index`) so later
    HTML passes like mention decoration can't rewrite it. */
export type MdliteDoc = { html: string; copies: string[]; charts: string[] };

/** What a render collects: copy-button sources, and (when the host draws
    charts itself) the source of each chart slot. Quoted charts stay source. */
type Ctx = { copies: string[] | null; charts: string[] | null; inQuote: boolean };

const COPY_ICONS =
  '<svg class="md-copy-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>'
  + '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>'
  + '<svg class="md-copied-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

function copyButton(copies: string[], text: string, what: "quote" | "code"): string {
  const label = what === "quote" ? "Copy quote" : "Copy code";
  return `<button type="button" class="md-copy" data-copy-index="${copies.push(text) - 1}" data-copy-kind="${what}" `
    + `aria-label="${label}" title="${label}">${COPY_ICONS}</button>`;
}

/** Fences, inline spans, headings and tables over one plain-text run. */
function inlineHtml(s: string, ctx: Ctx): string {
  const { copies } = ctx;
  // NUL delimits the slot markers below; a literal one in the text (pasted
  // binary/log output) must not be read back as a marker.
  let t = esc(s.replace(/\u0000/g, ""));
  const slots: string[] = [];
  const stash = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;
  // Block-level output (code, diagrams, tables) gets its own marker so the
  // pre-wrap line breaks around it can be dropped; its margins space it.
  const stashBlock = (html: string) => `\u0000B${slots.push(html) - 1}\u0000`;
  t = t.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang: string, code: string) => {
    code = code.replace(/\n$/, "");
    // A mermaid fence keeps its code block visible inside a marker div; the
    // mermaid renderer swaps it for the SVG after render (and leaves the
    // code standing when the graph doesn't parse).
    if (lang.toLowerCase() === "mermaid") {
      return stashBlock(`<div class="md-mermaid"><pre class="md-pre">${code}</pre></div>`);
    }
    if (lang.toLowerCase() === "echarts") {
      // The host mounts a chart into the slot, wherever it sits (a list item
      // included), so web and mobile share one block grammar.
      if (ctx.charts && !ctx.inQuote) {
        return stashBlock(`<div class="md-echarts-slot" data-chart-index="${ctx.charts.push(unesc(code)) - 1}"></div>`);
      }
      return stashBlock(`<div class="md-echarts"><pre class="md-pre">${code}</pre></div>`);
    }
    const pre = (body: string) => `<pre class="md-pre"${lang ? ` data-lang="${lang}"` : ""}>${body}</pre>`;
    if (!copies) return stashBlock(pre(code));
    // The button sits beside the scroller, not in it, so it stays put while
    // a long line scrolls underneath. The end-of-line room for it lives on an
    // inline-block span: WebKit doesn't count a scroller's own inline-end
    // padding as scrollable overflow.
    return stashBlock(`<div class="md-code">${pre(`<span class="md-code-text">${code}</span>`)}`
      + `${copyButton(copies, unesc(code), "code")}</div>`);
  });
  t = t.replace(/`([^`\n]+)`/g, (_, c: string) => stash(`<code>${c}</code>`));
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_, label: string, url: string) => stash(`<a href="${url}" target="_blank" rel="noopener">${label}</a>`));
  t = t.replace(/(^|\s)(https?:\/\/[^\s<\u0000]+)/g,
    (_, pre: string, url: string) => pre + stash(`<a href="${url}" target="_blank" rel="noopener">${url}</a>`));
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  t = t.replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=$|[\s).,!?:;])/gm, "$1<i>$2</i>");
  t = t.replace(/^#{1,4}\s+(.+)$/gm, "<b>$1</b>");
  t = t.replace(
    /(^|\n)(\|[^\n]*\|[ \t]*\r?\n\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*(?:\r?\n\|[^\n]*\|[ \t]*)*)\r?\n?/g,
    (_, pre: string, block: string) => {
      const rows = block.trim().split(/\r?\n/).map(line =>
        line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(c => c.trim()));
      const aligns = rows[1].map(c =>
        /^:-+:$/.test(c) ? "center" : /^-+:$/.test(c) ? "right" : "");
      const cell = (tag: string, c: string, i: number) =>
        `<${tag}${aligns[i] ? ` style="text-align:${aligns[i]}"` : ""}>${c}</${tag}>`;
      const head = `<tr>${rows[0].map((c, i) => cell("th", c, i)).join("")}</tr>`;
      const body = rows.slice(2).map(r =>
        `<tr>${r.map((c, i) => cell("td", c, i)).join("")}</tr>`).join("");
      return pre + stashBlock(`<div class="md-table-wrap"><table class="md-table"><thead>${head}</thead>`
        + `<tbody>${body}</tbody></table></div>`);
    });
  // Slots can hold markers of their own (a table whose cell has a fence or
  // inline code), so restore recursively. Literal NULs were stripped above,
  // so every marker here is ours, and a slot never contains itself.
  const restore = (html: string): string => html
    // The leading newline run may only start at its first newline, keeping
    // this linear on long blank runs; a marker right after a newline (the
    // previous block's trailing run already consumed) still matches.
    .replace(/(?:(?<!\n)\n+)?\u0000B(\d+)\u0000\n*/g, (_, i: string) => restore(slots[Number(i)]))
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => restore(slots[Number(i)]));
  return restore(t);
}

function blocksHtml(s: string, ctx: Ctx, depth: number, inItem = false): string {
  if (depth > MAX_BLOCK_DEPTH) return inlineHtml(s, ctx);
  const { copies } = ctx;
  const segs = splitMdBlocks(s, { inItem });
  return segs.map((seg, i) => {
    if (seg.kind === "text") {
      // Bubbles are white-space: pre-wrap, so the line breaks that framed a
      // quote or list would render as empty lines; block margins space them.
      let text = seg.text;
      // Whitespace-only lines count as blank here, as they do in splitMdBlocks.
      const first = i === 0, last = i === segs.length - 1;
      if (!first || !last) text = trimBlankLines(text, first ? "end" : last ? "start" : "both");
      return text ? inlineHtml(text, ctx) : "";
    }
    if (seg.kind === "quote") {
      const button = copies ? copyButton(copies, seg.text, "quote") : "";
      // A class, not :has(), reserves the button's room so it holds where
      // :has() isn't supported (older WebKitGTK).
      const cls = copies ? "md-quote md-quote-copy" : "md-quote";
      return `<blockquote class="${cls}">${blocksHtml(seg.text, { ...ctx, inQuote: true }, depth + 1)}${button}</blockquote>`;
    }
    const tag = seg.ordered ? "ol" : "ul";
    const start = seg.ordered && seg.start !== 1 ? ` start="${seg.start}"` : "";
    const items = seg.items.map(item => `<li>${blocksHtml(item.text, ctx, depth + 1, true)}</li>`).join("");
    return `<${tag} class="md-list"${start}>${items}</${tag}>`;
  }).join("");
}

/** Render a message, with copy buttons on quotes and code blocks and/or
    chart slots for the host to fill, when asked. */
export function mdliteDoc(s: string, opts: { copy?: boolean; charts?: boolean } = {}): MdliteDoc {
  const copies: string[] = [];
  const charts: string[] = [];
  const html = blocksHtml(String(s ?? ""), {
    copies: opts.copy ? copies : null, charts: opts.charts ? charts : null, inQuote: false,
  }, 0);
  return { html, copies, charts };
}

export function mdliteHtml(s: string): string {
  return mdliteDoc(s).html;
}

/** Rich-text clipboard HTML for a block of markdown: no CSS travels with a
    paste, so the line breaks bubbles show via pre-wrap become <br> (code
    blocks keep theirs inside <pre>). */
export function mdliteClipboardHtml(s: string): string {
  return mdliteHtml(s)
    .split(/(<pre[\s\S]*?<\/pre>)/)
    .map((part, i) => i % 2 ? part : part.replace(/\n/g, "<br>"))
    .join("");
}
