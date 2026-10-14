import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { FetchStatus } from "@tanstack/react-query";
import { useDividerSnapshot } from "../src/lib/useDividerSnapshot";

type Groups = { isPending: boolean; fetchStatus: FetchStatus; failureCount: number };
type Channel = { unread?: number; last_read_id?: number } | null;

function mount(channel: Channel, groups: Groups) {
  let out!: ReturnType<typeof useDividerSnapshot>;
  function Probe(p: { channel: Channel; groups: Groups }) {
    out = useDividerSnapshot(p.channel, p.groups);
    return null;
  }
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(Probe, { channel, groups })); });
  return {
    get out() { return out; },
    update: (c: Channel, g: Groups) => act(() => tree.update(React.createElement(Probe, { channel: c, groups: g }))),
  };
}

const fetching: Groups = { isPending: true, fetchStatus: "fetching", failureCount: 0 };
const loaded: Groups = { isPending: false, fetchStatus: "idle", failureCount: 0 };

describe("useDividerSnapshot", () => {
  it("waits only while the groups request's first attempt is in flight", () => {
    expect(mount(null, fetching).out.dividerReady).toBe(false);
    expect(mount(null, { ...fetching, failureCount: 1 }).out.dividerReady).toBe(true);
    expect(mount(null, { ...fetching, fetchStatus: "paused" }).out.dividerReady).toBe(true);
    expect(mount(null, { ...fetching, fetchStatus: "idle" }).out.dividerReady).toBe(true);
    expect(mount(null, loaded).out.dividerReady).toBe(true);
  });

  it("snapshots the marker once, and only with unread", () => {
    const h = mount({ unread: 3, last_read_id: 140 }, loaded);
    expect(h.out.marker).toBe(140);
    h.update({ unread: 0, last_read_id: 200 }, loaded);
    expect(h.out.marker).toBe(140);
    expect(mount({ unread: 0, last_read_id: 90 }, loaded).out.marker).toBe(0);
  });

  it("freezes 'no divider' once the opening decided, so a late payload adds none", () => {
    const h = mount(null, fetching);
    act(() => h.out.onOpeningDecided());
    h.update({ unread: 5, last_read_id: 140 }, loaded);
    expect(h.out.marker).toBe(0);
    expect(h.out.dividerReady).toBe(true);
  });

  it("an on-time payload still sets the divider when the opening hasn't decided", () => {
    const h = mount(null, fetching);
    h.update({ unread: 5, last_read_id: 140 }, loaded);
    expect(h.out.marker).toBe(140);
  });
});
