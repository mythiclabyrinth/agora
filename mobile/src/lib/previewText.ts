import { parseMd } from "@agora/core";

/** Keep previews readable without altering stored message bodies or search markers. */
export function previewText(text: string): string {
  return parseMd(text).map(block => {
    if (block.kind === "codeblock") return block.text;
    if (block.kind === "table") return [block.head, ...block.rows]
      .map(row => row.map(cell => cell.map(span => span.text).join("")).join(" · ")).join(" ");
    return block.spans.map(span => span.text).join("");
  }).join(" ").replace(/\s+/g, " ").trim();
}
