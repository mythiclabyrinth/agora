import { describe, expect, it } from "vitest";
import { filterAndSortThreads, type ThreadFilter, type ThreadRow, type ThreadSort } from "../src";

function thread(
  id: number,
  name: string,
  activity: number,
  options: { saved?: boolean; rootTs?: number } = {},
): ThreadRow {
  return {
    root: {
      id,
      alias: options.saved ? name : null,
      text: options.saved ? `Fallback ${id}` : name,
      ts: options.rootTs ?? activity,
    },
    last_reply_ts: activity,
  } as ThreadRow;
}

const rows = [
  thread(1, "Zulu planning", 400, { saved: true }),
  thread(2, "Alpha launch\nignored", 300),
  thread(3, "Bravo review", 200, { saved: true }),
  thread(4, "Charlie follow-up", 100),
];

describe("filterAndSortThreads", () => {
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
});
