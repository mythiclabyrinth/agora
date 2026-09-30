import { describe, expect, it } from "vitest";
import { filterAndSortThreads, threadActivityTs, threadGroupOptions, type ThreadFilter, type ThreadRow, type ThreadSort } from "../src";

function thread(
  id: number,
  name: string,
  activity: number,
  options: { saved?: boolean; rootTs?: number; groupId?: string; groupName?: string } = {},
): ThreadRow {
  return {
    root: {
      id,
      alias: options.saved ? name : null,
      text: options.saved ? `Fallback ${id}` : name,
      ts: options.rootTs ?? activity,
    },
    last_reply_ts: activity,
    group_id: options.groupId ?? "product",
    group_name: options.groupName ?? "Product",
  } as ThreadRow;
}

const rows = [
  thread(1, "Zulu planning", 400, { saved: true }),
  thread(2, "Alpha launch\nignored", 300),
  thread(3, "Bravo review", 200, { saved: true }),
  thread(4, "Charlie follow-up", 100),
];

describe("filterAndSortThreads", () => {
  it("uses only valid reply timestamps for activity ordering", () => {
    const invalid = { ...thread(12, "Invalid", Number.NaN, { rootTs: 10 }), last_reply_ts: Number.NaN };
    const valid = thread(13, "Valid", 20, { rootTs: 30 });
    expect(threadActivityTs(invalid)).toBe(10);
    expect(threadActivityTs(valid)).toBe(20);
  });

  it("preserves cache order for the default recent/all view", () => {
    expect(filterAndSortThreads(rows, "recent", "all").map((t) => t.root.id))
      .toEqual([1, 2, 3, 4]);
    expect(rows.map((t) => t.root.id)).toEqual([1, 2, 3, 4]);
  });

  it.each<[ThreadFilter, number[]]>([
    ["saved", [1, 3]],
    ["unset", [2, 4]],
  ])("filters %s threads", (filter, expected) => {
    expect(filterAndSortThreads(rows, "recent", filter).map((t) => t.root.id)).toEqual(expected);
  });

  it.each<[ThreadSort, number[]]>([
    ["oldest", [4, 3, 2, 1]],
    ["az", [2, 3, 4, 1]],
    ["za", [1, 4, 3, 2]],
  ])("orders threads by %s", (sort, expected) => {
    expect(filterAndSortThreads(rows, sort, "all").map((t) => t.root.id)).toEqual(expected);
  });

  it("uses only ten normalized characters, then recent activity and id as tie-breakers", () => {
    const tied = [
      thread(8, "abcdefghij-z", 100),
      thread(7, "ABCDEFGHIJ-a", 200),
      thread(6, "abcdefghij-b", 200),
    ];
    expect(filterAndSortThreads(tied, "az", "all").map((t) => t.root.id)).toEqual([6, 7, 8]);
  });

  it("keeps empty names last in both alphabetical directions", () => {
    const empty = thread(9, "", 500);
    expect(filterAndSortThreads([empty, ...rows], "az", "all").at(-1)?.root.id).toBe(9);
    expect(filterAndSortThreads([empty, ...rows], "za", "all").at(-1)?.root.id).toBe(9);
  });

  it("falls back to the root timestamp when there is no reply timestamp", () => {
    const older = thread(10, "Older", 0, { rootTs: 10 });
    const newer = thread(11, "Newer", 0, { rootTs: 20 });
    expect(filterAndSortThreads([newer, older], "oldest", "all").map((t) => t.root.id))
      .toEqual([10, 11]);
  });

  it("combines group with saved and unset filters", () => {
    const grouped = [
      thread(1, "Saved A", 4, { saved: true, groupId: "a" }),
      thread(2, "Unset A", 3, { groupId: "a" }),
      thread(3, "Saved B", 2, { saved: true, groupId: "b" }),
      thread(4, "Unset B", 1, { groupId: "b" }),
    ];
    expect(filterAndSortThreads(grouped, "recent", "all", "a").map(t => t.root.id)).toEqual([1, 2]);
    expect(filterAndSortThreads(grouped, "recent", "saved", "a").map(t => t.root.id)).toEqual([1]);
    expect(filterAndSortThreads(grouped, "recent", "unset", "b").map(t => t.root.id)).toEqual([4]);
    expect(filterAndSortThreads(grouped, "recent", "all", "gone")).toEqual([]);
  });

  it("lists each represented group once in sidebar order, then alphabetically", () => {
    const grouped = [
      thread(1, "One", 4, { groupId: "z", groupName: "Zulu" }),
      thread(2, "Two", 3, { groupId: "a", groupName: "Alpha" }),
      thread(3, "Three", 2, { groupId: "z", groupName: "Zulu" }),
      thread(4, "Four", 1, { groupId: "b", groupName: "Beta" }),
    ];
    const sidebar = [{ id: "b", name: "Renamed Beta" }];
    expect(threadGroupOptions(grouped, sidebar)).toEqual([
      { id: "b", name: "Renamed Beta" },
      { id: "a", name: "Alpha" },
      { id: "z", name: "Zulu" },
    ]);
  });
});
