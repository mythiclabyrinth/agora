import { describe, expect, it } from "vitest";
import { appendUnique, moreAfterPage, SEARCH_TOTAL_CAP, searchCountLabel } from "../src";

describe("searchCountLabel", () => {
  it("marks only message totals past the server's cap", () => {
    expect(searchCountLabel("messages", SEARCH_TOTAL_CAP)).toBe((1000).toLocaleString());
    expect(searchCountLabel("messages", SEARCH_TOTAL_CAP + 1)).toBe(`${(1000).toLocaleString()}+`);
    expect(searchCountLabel("channels", 1500)).toBe((1500).toLocaleString());
  });
});

describe("paging helpers", () => {
  it("are exported from the barrel", () => {
    expect(appendUnique([{ id: 1 }], [{ id: 1 }, { id: 2 }])).toEqual([{ id: 1 }, { id: 2 }]);
    expect(moreAfterPage({ rows: 50, fresh: 0, limit: 50 })).toBe(false);
  });
});
