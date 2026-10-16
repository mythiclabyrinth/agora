/* Blockquotes, lists and copy buttons across both markdown renderers. */

import { describe, expect, it } from "vitest";
import { splitMdBlocks, trimBlankLines } from "../src/lib/mdblocks";
import { parseMd, type Block } from "../src/lib/mdlite";
import { mdliteClipboardHtml, mdliteDoc, mdliteHtml } from "../src/lib/mdliteHtml";

// Message 23353 from the hosted instance, the report that started this.
const slackMessage = [
  "Here's a tightened version you can paste into Slack:",
  "",
  "> Skyler's coding agent can now run on our ChatGPT (Codex) subscription. Just tell Skyler to **\"use codex\"** and it'll run the task on GPT-6 Sol.",
  ">",
  "> It's **not the default**. DeepSeek still is.",
  ">",
  "> This change also upgraded OpenCode (the agent the sandboxes run) for every model, not just Codex.",
  "",
  "What changed and why:",
  "- **\"use codex\" instead of \"provider Codex … model Sol\".** \"Use codex\" is the exact phrase Skyler maps to `--model codex`, so people are more likely to trigger it correctly.",
  "- **Added the OpenCode upgrade.** It's the real reason DeepSeek and Opus users might see differences.",
  "- **Typos and flow:** \"havent\", \"dont\" and \"its\" are fixed.",
].join("\n");

const quoteBody = [
  "Skyler's coding agent can now run on our ChatGPT (Codex) subscription. Just tell Skyler to **\"use codex\"** and it'll run the task on GPT-6 Sol.",
  "",
  "It's **not the default**. DeepSeek still is.",
  "",
  "This change also upgraded OpenCode (the agent the sandboxes run) for every model, not just Codex.",
].join("\n");

const kindsOf = (blocks: Block[]) => blocks.map(b => b.kind);
const strip = (html: string) => html.replace(/<button[\s\S]*?<\/button>/g, "<button/>");

describe("splitMdBlocks", () => {
  it("groups a `>` run (lone `>` lines included) into one quote", () => {
    const segs = splitMdBlocks(slackMessage);
    expect(segs.map(s => s.kind)).toEqual(["text", "quote", "text", "list"]);
    expect(segs[1]).toEqual({ kind: "quote", text: quoteBody });
    expect(segs[3]).toMatchObject({ kind: "list", ordered: false });
    expect((segs[3] as { items: unknown[] }).items).toHaveLength(3);
  });

  it("keeps prose that only looks like markers", () => {
    for (const line of ["+ 1, agreed", "->x", "-5 degrees", "2026. was a year", ">= 3", ">quoted?", "**bold** start", "*italic* start"]) {
      expect(splitMdBlocks(line)).toEqual([{ kind: "text", text: line }]);
    }
  });

  it("leaves markers inside fences literal", () => {
    const text = "```\n> not a quote\n- not a list\n1. nope\n```";
    expect(splitMdBlocks(text)).toEqual([{ kind: "text", text }]);
  });

  it("protects a fence opened mid-line, as the renderers pair it", () => {
    const text = "Example: ```js\n- a\n> b\n```";
    expect(splitMdBlocks(text)).toEqual([{ kind: "text", text }]);
    expect(mdliteHtml(text)).toBe("Example: <pre class=\"md-pre\" data-lang=\"js\">- a\n&gt; b</pre>");
  });

  it("keeps a fence opened on the item line inside that item", () => {
    expect(splitMdBlocks("- run ```bash\nnpm test\n```\n- next")).toEqual([{
      kind: "list", ordered: false, start: 1, items: [{ text: "run ```bash\nnpm test\n```" }, { text: "next" }],
    }]);
  });

  it("ends a quote at a `>=` line, like a quote never starts on one", () => {
    expect(splitMdBlocks("> Threshold is high\n>= 3 retries trigger it")).toEqual([
      { kind: "quote", text: "Threshold is high" },
      { kind: "text", text: ">= 3 retries trigger it" },
    ]);
  });

  it("handles CRLF and U+2028 text without stalling", () => {
    expect(splitMdBlocks("> hello\r\n> again\r\nworld")).toEqual([
      { kind: "quote", text: "hello\nagain" },
      { kind: "text", text: "world" },
    ]);
    expect(splitMdBlocks("- a\r\n- b")).toEqual([
      { kind: "list", ordered: false, start: 1, items: [{ text: "a" }, { text: "b" }] },
    ]);
    expect(splitMdBlocks("> a\u2028b")).toEqual([{ kind: "quote", text: "a\u2028b" }]);
    expect(splitMdBlocks("- a\u2028b")).toEqual([
      { kind: "list", ordered: false, start: 1, items: [{ text: "a\u2028b" }] },
    ]);
    expect(kindsOf(parseMd("> x\r\n"))).toEqual(["quote"]);
  });

  it("treats an item off by one column as a sibling, two or more as a child", () => {
    expect(splitMdBlocks("- a\n - b\n- c")).toEqual([{
      kind: "list", ordered: false, start: 1, items: [{ text: "a" }, { text: "b" }, { text: "c" }],
    }]);
    expect(splitMdBlocks("- a\n  - b")).toEqual([{
      kind: "list", ordered: false, start: 1, items: [{ text: "a\n- b" }],
    }]);
  });

  it("keeps a `>>` line inside the quote as a nested quote", () => {
    expect(splitMdBlocks("> outer\n>> inner\n> more")).toEqual([{ kind: "quote", text: "outer\n> inner\nmore" }]);
    expect(mdliteHtml("> outer\n>> inner")).toBe(
      "<blockquote class=\"md-quote\">outer<blockquote class=\"md-quote\">inner</blockquote></blockquote>");
  });

  it("continues a list when an item drifts one column left", () => {
    expect(splitMdBlocks(" - a\n- b")).toEqual([{
      kind: "list", ordered: false, start: 1, items: [{ text: "a" }, { text: "b" }],
    }]);
  });

  it("closes a quoted fence on a bare ``` line and keeps parsing after it", () => {
    expect(splitMdBlocks("> ```js\n> code\n```\n\n- one\n- two").map(seg => seg.kind)).toEqual(["quote", "text", "list"]);
    expect(splitMdBlocks("> ```js\n> code\n```")[0]).toEqual({ kind: "quote", text: "```js\ncode\n```" });
    expect(splitMdBlocks("> ```\ncode\n```")).toEqual([{ kind: "quote", text: "```\ncode\n```" }]);
    expect(splitMdBlocks("> ```js\n> code\n```\n> More of the quote")).toEqual([
      { kind: "quote", text: "```js\ncode\n```\nMore of the quote" },
    ]);
  });

  it("treats an unpaired ``` as prose so later blocks still parse", () => {
    expect(splitMdBlocks("Wrap code in ``` fences.\n\n- one\n- two\n\n> note").map(seg => seg.kind))
      .toEqual(["text", "list", "text", "quote"]);
  });

  it("leaves dividers like `* * *` and `- - -` as prose", () => {
    for (const rule of ["* * *", "- - -", "***", "---", "_ _ _"]) {
      expect(splitMdBlocks(rule)).toEqual([{ kind: "text", text: rule }]);
    }
  });

  it("ends a list at an unindented line, and lets only `1.` interrupt prose", () => {
    expect(splitMdBlocks("- a\n- b\nThanks!")).toEqual([
      { kind: "list", ordered: false, start: 1, items: [{ text: "a" }, { text: "b" }] },
      { kind: "text", text: "Thanks!" },
    ]);
    expect(splitMdBlocks("Total latency dropped by\n15. That is the headline.")).toEqual([
      { kind: "text", text: "Total latency dropped by\n15. That is the headline." },
    ]);
    expect(splitMdBlocks("Steps:\n1. one").map(seg => seg.kind)).toEqual(["text", "list"]);
    expect(splitMdBlocks("```\nnpm i\n```\n2. Run the server").map(seg => seg.kind)).toEqual(["text", "list"]);
    expect(splitMdBlocks("## Results\n2. second").map(seg => seg.kind)).toEqual(["text", "list"]);
  });

  it("doesn't let a quoted fence opener swallow an unquoted reply", () => {
    expect(splitMdBlocks("> ```\n> const a = 1;\n\nWhy not this?\n```\nfixed()\n```")).toEqual([
      { kind: "quote", text: "```\nconst a = 1;" },
      { kind: "text", text: "\nWhy not this?\n```\nfixed()\n```" },
    ]);
  });

  it("only lets a bare ``` close a quote's open fence", () => {
    expect(splitMdBlocks("> Wrap code in ``` fences.\n\nExample:\n```js\nx\n```").map(seg => seg.kind))
      .toEqual(["quote", "text"]);
    expect(splitMdBlocks("> Wrap code in ``` fences.\n\nExample:\n```js\nx\n```")[0])
      .toEqual({ kind: "quote", text: "Wrap code in ``` fences." });
  });

  it("pairs fences in a quote by ``` count, the same rule the renderers use", () => {
    expect(splitMdBlocks("> ```npm i``` then restart\nafter").map(seg => seg.kind)).toEqual(["quote", "text"]);
    expect(splitMdBlocks("> run ```bash\nnpm i\n```\n\nafter")).toEqual([
      { kind: "quote", text: "run ```bash\nnpm i\n```" },
      { kind: "text", text: "\nafter" },
    ]);
  });

  it("trims blank `>` edges and leaves a bare `>` as prose", () => {
    expect(splitMdBlocks(">\n> note\n>")).toEqual([{ kind: "quote", text: "note" }]);
    expect(splitMdBlocks("Result:\n>")).toEqual([{ kind: "text", text: "Result:\n>" }]);
  });

  it("aligns continuation lines under the item text, extra marker spacing included", () => {
    expect(splitMdBlocks("-   Step one\n    detail line")).toEqual([
      { kind: "list", ordered: false, start: 1, items: [{ text: "Step one\ndetail line" }] },
    ]);
  });

  it("lets a nested ordered list start at any number under an item's text", () => {
    expect(mdliteHtml("1. Setup:\n   3. run migrations\n   4. restart")).toBe(
      "<ol class=\"md-list\"><li>Setup:<ol class=\"md-list\" start=\"3\"><li>run migrations</li><li>restart</li></ol></li></ol>");
  });

  it("restores every block marker when blocks sit back to back", () => {
    expect(mdliteHtml("```\na\n```\n\n```\nb\n```\n\n```\nc\n```")).toBe(
      "<pre class=\"md-pre\">a</pre><pre class=\"md-pre\">b</pre><pre class=\"md-pre\">c</pre>");
    expect(mdliteDoc("```echarts\n{}\n```\n\n```echarts\n[]\n```", { charts: true }).html).toBe(
      "<div class=\"md-echarts-slot\" data-chart-index=\"0\"></div><div class=\"md-echarts-slot\" data-chart-index=\"1\"></div>");
  });

  it("resolves code inside a table cell", () => {
    expect(mdliteHtml("| cmd | note |\n|---|---|\n| ```npm i``` | `x` |")).toBe(
      "<div class=\"md-table-wrap\"><table class=\"md-table\"><thead><tr><th>cmd</th><th>note</th></tr></thead>"
      + "<tbody><tr><td><pre class=\"md-pre\" data-lang=\"npm\"> i</pre></td><td><code>x</code></td></tr></tbody></table></div>");
  });

  it("stays fast on long blank runs", () => {
    const blanks = "\n".repeat(20000);
    const started = performance.now();
    mdliteHtml(`a${blanks}x\n\`\`\`\ncode\n\`\`\`\n- item`);
    mdliteHtml(`> a${"\n>".repeat(10000)}\n> b\n- c`);
    parseMd(`> a${"\n>".repeat(10000)}\n> b`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("trims only whitespace-only edge lines", () => {
    expect(trimBlankLines("\n  \na\n\n b \n \n")).toBe("a\n\n b ");
    expect(trimBlankLines("\n\na", "end")).toBe("\n\na");
    expect(trimBlankLines("a\n \n", "start")).toBe("a\n \n");
    expect(trimBlankLines("\n \n")).toBe("");
    expect(trimBlankLines("   ")).toBe("");
    expect(mdliteHtml("> quoted\n   \n- item")).toBe(
      "<blockquote class=\"md-quote\">quoted</blockquote><ul class=\"md-list\"><li>item</li></ul>");
  });

  it("keeps an unindented fence under an item inside it, and the list going", () => {
    expect(splitMdBlocks("1. Run:\n```bash\nnpm test\n```\n2. Then deploy")).toEqual([{
      kind: "list", ordered: true, start: 1, items: [{ text: "Run:\n```bash\nnpm test\n```" }, { text: "Then deploy" }],
    }]);
  });

  it("starts a list at any number after a label line", () => {
    expect(splitMdBlocks("**Phase 2**\n3. c\n4. d").map(seg => seg.kind)).toEqual(["text", "list"]);
    expect(splitMdBlocks("Next steps:\n3. c").map(seg => seg.kind)).toEqual(["text", "list"]);
  });

  it("doesn't let an inline ``` in an item swallow the items after it", () => {
    expect(splitMdBlocks("- Wrap code in ``` fences\n- Second tip\n\nExample:\n```js\nx\n```")).toEqual([
      { kind: "list", ordered: false, start: 1, items: [{ text: "Wrap code in ``` fences" }, { text: "Second tip" }] },
      { kind: "text", text: "\nExample:\n```js\nx\n```" },
    ]);
  });

  it("keeps tab indentation in code under an indented fence", () => {
    expect(splitMdBlocks("Run:\n  ```py\n  def f():\n  \treturn 1\n  ```")).toEqual([
      { kind: "text", text: "Run:\n```py\ndef f():\n\treturn 1\n```" },
    ]);
    expect(splitMdBlocks("x:\n  ```\n\tcode\n  ```")[0]).toEqual({ kind: "text", text: "x:\n```\n\tcode\n```" });
  });

  it("nests indented items and keeps fences inside an item", () => {
    const segs = splitMdBlocks([
      "- Payloads:",
      "  ```json",
      "  {",
      "    \"id\": 1",
      "  }",
      "  ```",
      "- Impl:",
      "  - `store.rs`",
      "  - `server.rs`",
    ].join("\n"));
    expect(segs).toEqual([{
      kind: "list", ordered: false, start: 1, items: [
        { text: "Payloads:\n```json\n{\n  \"id\": 1\n}\n```" },
        { text: "Impl:\n- `store.rs`\n- `server.rs`" },
      ],
    }]);
  });

  it("splits a bullet list from a following numbered list and keeps the start", () => {
    const segs = splitMdBlocks("- a\n- b\n3. c\n4. d");
    expect(segs).toEqual([
      { kind: "list", ordered: false, start: 1, items: [{ text: "a" }, { text: "b" }] },
      { kind: "list", ordered: true, start: 3, items: [{ text: "c" }, { text: "d" }] },
    ]);
  });

  it("keeps a list across blank lines between items, but ends it before prose", () => {
    expect(splitMdBlocks("1. a\n\n2. b\n\nAfter.").map(s => s.kind)).toEqual(["list", "text"]);
  });

  it("dedents a fence indented outside any list", () => {
    expect(splitMdBlocks("Payload:\n  ```json\n  { \"a\": 1 }\n  ```")).toEqual([
      { kind: "text", text: "Payload:\n```json\n{ \"a\": 1 }\n```" },
    ]);
  });
});

describe("mdliteHtml blocks", () => {
  it("renders the reported message as one quote box and a real list", () => {
    const html = mdliteHtml(slackMessage);
    expect(html.match(/<blockquote/g)).toHaveLength(1);
    expect(html).not.toMatch(/&gt;/);
    expect(html).toContain("<blockquote class=\"md-quote\">Skyler&#39;s coding agent");
    expect(html).toContain("<ul class=\"md-list\"><li><b>&quot;use codex&quot; instead of");
    expect(html.match(/<li>/g)).toHaveLength(3);
    // No copy buttons unless asked (search snippets, golden vectors).
    expect(html).not.toContain("md-copy");
  });

  it("drops the line breaks that framed a block", () => {
    expect(mdliteHtml("Intro:\n\n> q\n\nAfter")).toBe("Intro:<blockquote class=\"md-quote\">q</blockquote>After");
    expect(mdliteHtml("- a\n   \nThanks")).toBe("<ul class=\"md-list\"><li>a</li></ul>Thanks");
  });

  it("drops the line breaks around code blocks and tables but keeps paragraph breaks", () => {
    expect(mdliteHtml("Run:\n\n```\nx\n```\n\nThen\n\nmore")).toBe("Run:<pre class=\"md-pre\">x</pre>Then\n\nmore");
    expect(mdliteHtml("Totals:\n\n| a |\n| --- |\n| 1 |\n\nDone")).toBe(
      "Totals:<div class=\"md-table-wrap\"><table class=\"md-table\"><thead><tr><th>a</th></tr></thead>"
      + "<tbody><tr><td>1</td></tr></tbody></table></div>Done");
  });

  it("drops literal NULs so code can't be read as slot markers", () => {
    expect(mdliteHtml("```\na\u00000\u0000b\n```\n`x`")).toBe("<pre class=\"md-pre\">a0b</pre><code>x</code>");
  });

  it("leaves search highlight markers alone", () => {
    expect(mdliteHtml("find \u000142\u0002 here")).toBe("find \u000142\u0002 here");
  });

  it("renders ordered lists with their start number and nested lists", () => {
    expect(mdliteHtml("2. a\n3. b\n   - x")).toBe(
      "<ol class=\"md-list\" start=\"2\"><li>a</li><li>b<ul class=\"md-list\"><li>x</li></ul></li></ol>");
  });

  it("renders a fence inside a quote as code, without `>` markers", () => {
    const html = mdliteHtml("> ```js\n> if (a > b) x();\n> ```");
    expect(html).toBe("<blockquote class=\"md-quote\"><pre class=\"md-pre\" data-lang=\"js\">if (a &gt; b) x();</pre></blockquote>");
  });

  it("escapes HTML inside quotes and list items", () => {
    const html = mdliteHtml("> <img src=x onerror=alert(1)>\n- <script>x</script>");
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("mdliteDoc copy buttons", () => {
  it("puts one button on the quote and keeps its raw markdown out of the HTML", () => {
    const doc = mdliteDoc("> Ask @tom about <b> & \"this\"\n>\n> **Second** paragraph", { copy: true });
    expect(doc.copies).toEqual(["Ask @tom about <b> & \"this\"\n\n**Second** paragraph"]);
    expect(strip(doc.html)).toBe(
      "<blockquote class=\"md-quote md-quote-copy\">Ask @tom about &lt;b&gt; &amp; &quot;this&quot;\n\n<b>Second</b> paragraph<button/></blockquote>");
    expect(doc.html).toContain("data-copy-index=\"0\"");
    expect(doc.html).toContain("data-copy-kind=\"quote\" aria-label=\"Copy quote\"");
  });

  it("wraps code blocks and copies the unescaped code", () => {
    const doc = mdliteDoc("```ts\nconst a = b && c < d;\n```", { copy: true });
    expect(doc.copies).toEqual(["const a = b && c < d;"]);
    expect(strip(doc.html)).toBe(
      "<div class=\"md-code\"><pre class=\"md-pre\" data-lang=\"ts\"><span class=\"md-code-text\">const a = b &amp;&amp; c &lt; d;</span></pre><button/></div>");
  });

  it("indexes nested buttons so each copies its own block", () => {
    const doc = mdliteDoc("> intro\n> ```\n> code\n> ```\n\n```\nsecond\n```", { copy: true });
    expect(doc.copies).toEqual(["intro\n```\ncode\n```", "code", "second"]);
    const indexes = [...doc.html.matchAll(/data-copy-index="(\d+)" data-copy-kind="\w+" aria-label="([^"]+)"/g)].map(m => [m[1], m[2]]);
    expect(indexes).toEqual([["1", "Copy code"], ["0", "Copy quote"], ["2", "Copy code"]]);
  });

  it("leaves chart slots for unquoted echarts fences, list items included", () => {
    const doc = mdliteDoc("- Revenue:\n  ```echarts\n  {\"a\":1}\n  ```\n- Next\n\n> ```echarts\n> {}\n> ```", { charts: true });
    expect(doc.charts).toEqual(["{\"a\":1}"]);
    expect(doc.html).toBe(
      "<ul class=\"md-list\"><li>Revenue:<div class=\"md-echarts-slot\" data-chart-index=\"0\"></div></li><li>Next</li></ul>"
      + "<blockquote class=\"md-quote\"><div class=\"md-echarts\"><pre class=\"md-pre\">{}</pre></div></blockquote>");
  });

  it("skips mermaid and echarts fences", () => {
    const doc = mdliteDoc("```mermaid\ngraph TD; A-->B;\n```\n```echarts\n{}\n```", { copy: true });
    expect(doc.copies).toEqual([]);
    expect(doc.html).not.toContain("md-copy");
  });
});

describe("parseMd blocks", () => {
  const kinds = (blocks: Block[]) => blocks.map(b => b.kind);

  it("parses the reported message into a quote with its source and a list", () => {
    const blocks = parseMd(slackMessage);
    expect(kinds(blocks)).toEqual(["para", "quote", "para", "list"]);
    const quote = blocks[1] as Extract<Block, { kind: "quote" }>;
    expect(quote.source).toBe(quoteBody);
    expect(kinds(quote.blocks)).toEqual(["para", "para", "para"]);
    const list = blocks[3] as Extract<Block, { kind: "list" }>;
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(3);
    expect(list.items[0][0]).toMatchObject({ kind: "para" });
  });

  it("nests lists and fences inside items, and code inside quotes", () => {
    const [list] = parseMd("1. Run:\n   ```bash\n   npm test\n   ```\n2. Then:\n   - check") as Extract<Block, { kind: "list" }>[];
    expect(list).toMatchObject({ kind: "list", ordered: true, start: 1 });
    expect(list.items[0]).toEqual([
      { kind: "para", spans: [{ kind: "text", text: "Run:" }] },
      { kind: "codeblock", lang: "bash", text: "npm test" },
    ]);
    expect(kinds(list.items[1])).toEqual(["para", "list"]);
    const [quote] = parseMd("> ```\n> a > b\n> ```") as Extract<Block, { kind: "quote" }>[];
    expect(quote.blocks).toEqual([{ kind: "codeblock", lang: undefined, text: "a > b" }]);
  });

  it("leaves plain messages unchanged", () => {
    expect(parseMd("Hello **there**\n\n->x and -5")).toEqual([
      { kind: "para", spans: [{ kind: "text", text: "Hello " }, { kind: "bold", text: "there" }] },
      { kind: "para", spans: [{ kind: "text", text: "->x and -5" }] },
    ]);
  });
});

describe("mdliteClipboardHtml", () => {
  it("turns prose line breaks into <br> but leaves code alone", () => {
    expect(mdliteClipboardHtml("**One**\n\nTwo\n```\na\nb\n```")).toBe(
      "<b>One</b><br><br>Two<pre class=\"md-pre\">a\nb</pre>");
  });
});
