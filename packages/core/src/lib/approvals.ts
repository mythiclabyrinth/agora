/* "Resolve all" on an approvals card: what the sheet says it will do, and
   the toast after. Shared by the web dialog and the mobile sheet. */

import type { ApprovalBulkAction, ApprovalResolveResult, PendingApproval } from "../api/types";
import { parseMd, type Block, type Span } from "./mdlite";

// A link keeps its target: approving "Run cleanup.sh" must show where it points.
const spanText = (span: Span) => span.kind === "link" && span.text !== span.url ? `${span.text} (${span.url})` : span.text;

export const APPROVAL_BULK_LABELS: Record<ApprovalBulkAction, string> = {
  approve: "Approve", always: "Always allow", reject: "Reject",
};

/** Per choice, the requests it would answer; plus the tools "Always allow"
    grants (for the session), and how many can only be answered by hand. */
export function approvalBulkSummary(items: PendingApproval[]) {
  const take = (action: ApprovalBulkAction) => items.filter(item => item.actions.includes(action)).map(item => item.id);
  const tools = [...new Set(items.filter(item => item.actions.includes("always") && item.tool).map(item => item.tool as string))];
  return {
    ids: { approve: take("approve"), always: take("always"), reject: take("reject") } as Record<ApprovalBulkAction, number[]>,
    tools,
    manual: items.filter(item => item.actions.length === 0).length,
  };
}

function blockText(block: Block): string {
  if (block.kind === "codeblock") return block.text;
  if (block.kind === "table") return [block.head, ...block.rows].map(row => row.map(cell => cell.map(spanText).join("")).join(" · ")).join(" ");
  if (block.kind === "quote") return block.blocks.map(blockText).join(" ");
  if (block.kind === "list") return block.items.map(item => item.map(blockText).join(" ")).join(" · ");
  return block.spans.map(spanText).join("");
}

/** A request's words as plain text (markdown and code fences dropped, the
    command itself kept), so the sheet shows what is being approved. */
export function approvalRequestText(text: string): string {
  return parseMd(text).map(blockText).join(" ").replace(/\s+/g, " ").trim() || "Interactive request";
}

/** One line for the toast: what was answered and what is left. */
export function approvalBulkResultText(result: ApprovalResolveResult): string {
  const skipped = result.results.filter(r => r.status === "skipped");
  const manual = skipped.filter(r => r.detail === "Needs your input").length;
  const expired = skipped.filter(r => r.detail === "This request has expired").length;
  const parts = [`Resolved ${result.resolved}`];
  if (manual) parts.push(`${manual} ${manual === 1 ? "needs" : "need"} your input`);
  if (expired) parts.push(`${expired} expired`);
  if (skipped.length - manual - expired) parts.push(`${skipped.length - manual - expired} already answered`);
  if (result.failed) parts.push(`${result.failed} failed`);
  return parts.join(" · ");
}
