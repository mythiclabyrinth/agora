import { parseMd, type Block } from "@agora/core";

function blockText(block: Block): string {
  if (block.kind === "codeblock") return block.text;
  if (block.kind === "table") return [block.head, ...block.rows]
    .map(row => row.map(cell => cell.map(span => span.text).join("")).join(" · ")).join(" ");
  if (block.kind === "quote") return block.blocks.map(blockText).join(" ");
  if (block.kind === "list") return block.items.map((item, i) =>
    (block.ordered ? `${block.start + i}. ` : "") + item.map(blockText).join(" ")).join(" · ");
  return block.spans.map(span => span.text).join("");
}

/** Keep previews readable without altering stored message bodies or search markers. */
export function previewText(text: string): string {
  return parseMd(text).map(blockText).join(" ").replace(/\s+/g, " ").trim();
}
