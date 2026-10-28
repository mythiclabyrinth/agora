import { describe, expect, it } from "vitest";
import { appendUnique, moreAfterPage } from "./searchPages";

describe("appendUnique", () => {
  it("drops rows a later page repeats, keeping the first copy and the order", () => {
    const first = [{ id: 1, v: "a" }, { id: 2, v: "b" }];
    const page = [{ id: 2, v: "b again" }, { id: 3, v: "c" }, { id: 3, v: "c twice" }];
    expect(appendUnique(first, page)).toEqual([{ id: 1, v: "a" }, { id: 2, v: "b" }, { id: 3, v: "c" }]);
  });

  it("handles string ids and empty pages", () => {
    expect(appendUnique([{ id: "x" }], [])).toEqual([{ id: "x" }]);
    expect(appendUnique([], [{ id: "x" }, { id: "x" }])).toEqual([{ id: "x" }]);
  });
});

describe("moreAfterPage", () => {
  it("continues only after a full page with something new", () => {
    expect(moreAfterPage({ rows: 50, fresh: 50, limit: 50 })).toBe(true);
    expect(moreAfterPage({ rows: 50, fresh: 50, limit: 50, hasMore: true })).toBe(true);
  });

  it("stops on a short page, a page of repeats, or the server's has_more", () => {
    expect(moreAfterPage({ rows: 10, fresh: 10, limit: 50 })).toBe(false);
    expect(moreAfterPage({ rows: 0, fresh: 0, limit: 50 })).toBe(false);
    expect(moreAfterPage({ rows: 50, fresh: 0, limit: 50 })).toBe(false);
    expect(moreAfterPage({ rows: 50, fresh: 50, limit: 50, hasMore: false })).toBe(false);
  });
});
