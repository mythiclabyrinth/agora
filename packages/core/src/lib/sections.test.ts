import { describe, expect, it } from "vitest";
import type { Message } from "../api/types";
import { RAIL_AGENT_COLORS, agentRailColors, conversationSections, hashId } from "./sections";

const message = (
  id: number,
  author_type: Message["author_type"],
  text = "text",
): Message => ({
  id,
  channel_id: "general",
  thread_id: null,
  author_type,
  author_id: author_type === "user" ? "alice" : "helper",
  author_name: author_type === "user" ? "Alice" : "Helper",
  text,
  ts: 1,
  attachments: [],
});

describe("conversationSections", () => {
  it("groups agent replies under the preceding user turn", () => {
    expect(
      conversationSections([
        message(1, "user"),
        message(2, "agent"),
        message(3, "user"),
        message(4, "agent"),
      ]).map((section) => section.mid),
    ).toEqual([1, 3]);
  });

  it("makes a leading agent group a section and normalizes its label", () => {
    expect(
      conversationSections([
        message(1, "agent", "  First\n  response  "),
        message(2, "agent"),
        message(3, "user"),
      ]),
    ).toEqual([
      { mid: 1, label: "Helper: First response" },
      { mid: 3, label: "Alice: text" },
    ]);
  });

  it("marks every listed agent post while unlisted replies stay grouped", () => {
    const colors = agentRailColors([{ id: "helper", rail_marker: true }]);
    const other = { ...message(3, "agent"), author_id: "other" };
    const humanWithAgentId = { ...message(5, "user"), author_id: "helper" };
    const sections = conversationSections([
      message(1, "user"), message(2, "agent"), other,
      message(4, "agent"), humanWithAgentId,
    ], colors);
    expect(sections.map(s => s.mid)).toEqual([1, 2, 4, 5]);
    expect(sections[1].agentId).toBe("helper");
    expect(sections[3].agentId).toBeUndefined();
    expect(conversationSections([message(1, "user"), message(2, "agent"), other]).map(s => s.mid))
      .toEqual([1]);
  });

  it("keeps colours independent of message order and pagination for one roster", () => {
    const roster = ["alpha", "beta", "gamma", "delta"].map(id => ({ id, rail_marker: true }));
    const forward = agentRailColors(roster);
    const reversed = agentRailColors([...roster].reverse());
    expect([...forward]).toEqual([...reversed]);
    expect(new Set(forward.values()).size).toBe(roster.length);
    const early = conversationSections([{ ...message(1, "agent"), author_id: "beta" }], forward);
    const paged = conversationSections([
      { ...message(0, "agent"), author_id: "alpha" },
      { ...message(1, "agent"), author_id: "beta" },
    ], forward);
    expect(forward.get(early[0].agentId!)).toBe(forward.get(paged[1].agentId!));
  });

  it("reuses palette colours after six flagged agents", () => {
    const roster = Array.from({ length: 7 }, (_, i) => ({ id: `agent-${i}`, rail_marker: true }));
    const colors = agentRailColors(roster);
    expect(colors.size).toBe(7);
    expect(new Set(colors.values()).size).toBe(6);
    expect(colors.get("agent-6")).toBe(RAIL_AGENT_COLORS[hashId("agent-6") % RAIL_AGENT_COLORS.length]);
  });

  it("excludes agents without the rail marker", () => {
    expect(agentRailColors([{ id: "a", rail_marker: false }, { id: "b" }]).size).toBe(0);
  });
});
