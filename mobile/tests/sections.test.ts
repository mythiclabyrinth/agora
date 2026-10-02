import { conversationSections } from "@agora/core";
import {
  fixtureAgentMessage,
  fixtureRootMessage,
} from "@agora/core/testing/fixtures";
import {
  activeSectionIndex,
  agentDotStyle,
  messageRowIndex,
  pickActiveMessageId,
  sectionDotCapacity,
  visibleSectionWindow,
} from "../src/components/SectionRail";

describe("conversation sections", () => {
  it("renders marked agents as outlined rings until selected", () => {
    expect(agentDotStyle("#abc123", false)).toEqual({
      backgroundColor: "transparent", borderWidth: 1.5, borderColor: "#abc123", opacity: 1,
    });
    expect(agentDotStyle("#abc123", true)).toEqual({ backgroundColor: "#abc123" });
    expect(agentDotStyle(undefined, false)).toBeUndefined();
  });
  it("handles an empty timeline", () => {
    expect(conversationSections([])).toEqual([]);
  });

  it("starts at the first message and at each user turn", () => {
    const messages = [
      fixtureRootMessage,
      fixtureAgentMessage,
      { ...fixtureRootMessage, id: 50, text: "  Second\n  question  " },
      { ...fixtureAgentMessage, id: 51 },
    ];
    expect(
      conversationSections(messages).map((section) => section.mid),
    ).toEqual([fixtureRootMessage.id, 50]);
    expect(conversationSections(messages)[1].label).toContain(
      "Second question",
    );
  });

  it("keeps a leading agent group as its own section", () => {
    expect(
      conversationSections([
        fixtureAgentMessage,
        { ...fixtureRootMessage, id: 50 },
      ]),
    ).toHaveLength(2);
  });

  it("maps the active message after rows are prepended", () => {
    const sections = conversationSections([
      { ...fixtureRootMessage, id: 10 },
      { ...fixtureRootMessage, id: 20 },
      { ...fixtureRootMessage, id: 30 },
    ]);
    expect(activeSectionIndex(sections, 25)).toBe(1);
    const prepended = conversationSections([
      { ...fixtureRootMessage, id: 5 },
      ...[
        { ...fixtureRootMessage, id: 10 },
        { ...fixtureRootMessage, id: 20 },
        { ...fixtureRootMessage, id: 30 },
      ],
    ]);
    expect(activeSectionIndex(prepended, 25)).toBe(2);
  });

  it("resolves the current index after a divider and older-page prepend", () => {
    const target = { kind: "msg", m: { id: 30 } };
    expect(messageRowIndex([{ kind: "divider" }, target], 30)).toBe(1);
    expect(
      messageRowIndex(
        [{ kind: "msg", m: { id: 10 } }, { kind: "divider" }, target],
        30,
      ),
    ).toBe(2);
  });

  it("windows many thread turns around the active section", () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    expect(visibleSectionWindow(items, 15)).toEqual(items.slice(9, 21));
    expect(visibleSectionWindow(items, 0)).toEqual(items.slice(0, 12));
    expect(visibleSectionWindow(items, items.length - 1)).toEqual(items.slice(18));
  });

  it("shrinks the dot cap to fit a constrained rail height", () => {
    expect(sectionDotCapacity(80)).toBe(3);
    expect(sectionDotCapacity(20)).toBe(2);
    expect(sectionDotCapacity(1000)).toBe(12);
  });

  it("defaults active selection to the first section", () => {
    const sections = conversationSections([
      fixtureRootMessage,
      { ...fixtureRootMessage, id: 50 },
    ]);
    expect(activeSectionIndex(sections, null)).toBe(0);
  });

  it("uses the author fallback for blank text and ellipsizes long labels", () => {
    const blank = conversationSections([{ ...fixtureRootMessage, text: " \n " }])[0];
    const long = conversationSections([{ ...fixtureRootMessage, text: "x".repeat(80) }])[0];
    expect(blank.label).toBe(fixtureRootMessage.author_name || fixtureRootMessage.author_id);
    expect(long.label.endsWith("…")).toBe(true);
  });

  it("picks the latest message at bottom and the first visible message otherwise", () => {
    const viewableItems = [
      { index: 1, isViewable: true, item: { kind: "divider" } },
      { index: 2, isViewable: true, item: { kind: "msg", m: { id: 20 } } },
      { index: 3, isViewable: true, item: { kind: "msg", m: { id: 30 } } },
    ];
    expect(pickActiveMessageId({ viewableItems, atBottom: false, latestId: 40 })).toBe(20);
    expect(pickActiveMessageId({ viewableItems, atBottom: true, latestId: 40 })).toBe(40);
  });

  it("handles root rows, empty visibility, and an unavailable latest id", () => {
    const root = [{ index: 0, isViewable: true, item: { kind: "root", m: { id: 10 } } }];
    expect(pickActiveMessageId({ viewableItems: root, atBottom: false, latestId: 0 })).toBe(10);
    expect(pickActiveMessageId({ viewableItems: [], atBottom: true, latestId: 0 })).toBeNull();
  });
});
