import { describe, expect, it } from "vitest";
import { approvalBulkResultText, approvalBulkSummary, approvalRequestText, type PendingApproval } from "../src";

const item = (id: number, actions: PendingApproval["actions"], tool: string | null = null): PendingApproval =>
  ({ id, ts: id, author_name: "Claude", text: "Allow?", actions, tool });

describe("resolve all", () => {
  it("lists what each choice answers, the tools Always allow grants, and what needs a hand", () => {
    const summary = approvalBulkSummary([
      item(1, ["approve", "always", "reject"], "WebSearch"),
      item(2, ["approve", "always", "reject"], "Bash"),
      item(3, ["approve", "always", "reject"], "WebSearch"),
      item(4, ["approve", "reject"]),
      item(5, []),
    ]);
    expect(summary.ids).toEqual({ approve: [1, 2, 3, 4], always: [1, 2, 3], reject: [1, 2, 3, 4] });
    expect(summary.tools).toEqual(["WebSearch", "Bash"]);
    expect(summary.manual).toBe(1);
  });

  it("says what was answered and what is left", () => {
    const r = (status: "resolved" | "skipped" | "failed", detail = "") => ({ id: 0, status, detail });
    expect(approvalBulkResultText({ resolved: 4, skipped: 0, failed: 0, results: [] })).toBe("Resolved 4");
    expect(approvalBulkResultText({ resolved: 2, skipped: 3, failed: 1, results: [
      r("resolved"), r("resolved"), r("skipped", "Needs your input"), r("skipped", "This request has expired"),
      r("skipped", "Options already resolved"), r("failed", "x"),
    ] })).toBe("Resolved 2 · 1 needs your input · 1 expired · 1 already answered · 1 failed");
  });

  it("shows a request's command as plain text, not markdown", () => {
    expect(approvalRequestText("Claude wants to use **Bash**:\n```\nrm -rf ./build\n```")).toBe("Claude wants to use Bash: rm -rf ./build");
    expect(approvalRequestText("")).toBe("Interactive request");
    expect(approvalRequestText("Run [cleanup.sh](https://evil.example/x.sh)")).toBe("Run cleanup.sh (https://evil.example/x.sh)");
  });
});
