import { beforeEach, describe, expect, it } from "vitest";
import { replyingChannelIds, replyingNames, useLive } from "../src/state/live";
import type { TypingEvent, ProgressEvent } from "../src/api/types";

const typing = (agent_id: string, thread_id: number | null = null): TypingEvent => ({
  type: "typing", channel_id: "general", thread_id, agent_id,
  agent_name: agent_id, active: true,
});
const progress = (agent_id: string, thread_id: number | null = null): ProgressEvent => ({
  type: "progress", channel_id: "general", thread_id, agent_id,
  agent_name: agent_id, handle: `${agent_id}:work`, text: "Working",
});

describe("replying activity", () => {
  beforeEach(() => useLive.setState({ typing: {}, progress: {}, epoch: 0, touched: {} }));

  it("keeps thread activity off the channel and on that thread", () => {
    expect(replyingNames({ thread: typing("thread", 42) }, { work: progress("work", 42) })).toEqual([]);
    expect(replyingNames({ thread: typing("thread", 42) }, { work: progress("work", 42) }, 42)).toEqual(["thread", "work"]);
    expect(replyingNames({ bot: typing("bot") }, { work: progress("bot") })).toEqual(["bot"]);
    expect(replyingNames({ bot: typing("bot") }, undefined, 42)).toEqual([]);
    expect(replyingNames({ zed: typing("zed"), amy: typing("amy") })).toEqual(["amy", "zed"]);
  });

  it("lists only main-channel activity in stable channel order", () => {
    useLive.getState().onTyping({ ...typing("bot"), channel_id: "zeta" });
    useLive.getState().onProgress({ ...progress("bot"), channel_id: "alpha" });
    useLive.getState().onTyping({ ...typing("thread", 42), channel_id: "thread-only" });
    expect(replyingChannelIds(useLive.getState())).toEqual(["alpha", "zeta"]);
  });

  it("replaces stale entries from a previous connection", () => {
    useLive.getState().onTyping(typing("old"));
    const startEpoch = useLive.getState().epoch;
    useLive.getState().seedAll({ channels: { general: { typing: [typing("new")], progress: [] } } }, startEpoch);
    expect(replyingNames(useLive.getState().typing.general)).toEqual(["new"]);
    expect(useLive.getState().touched).toEqual({});
    useLive.getState().seedAll({ channels: {} }, useLive.getState().epoch);
    expect(useLive.getState().typing).toEqual({});
  });

  it("does not restore an agent cleared while the snapshot was loading", () => {
    useLive.getState().onTyping(typing("bot"));
    const startEpoch = useLive.getState().epoch;
    useLive.getState().agentDone("general", "bot");
    useLive.getState().seedAll({ channels: {
      general: { typing: [typing("bot")], progress: [progress("bot")] },
    } }, startEpoch);
    expect(replyingNames(useLive.getState().typing.general, useLive.getState().progress.general)).toEqual([]);
  });

  it("keeps typing and progress received while the snapshot was loading", () => {
    const startEpoch = useLive.getState().epoch;
    useLive.getState().onTyping(typing("bot"));
    useLive.getState().onProgress(progress("bot"));
    useLive.getState().seedAll({ channels: {} }, startEpoch);
    expect(replyingNames(useLive.getState().typing.general, useLive.getState().progress.general)).toEqual(["bot"]);
    expect(Object.keys(useLive.getState().progress.general)).toEqual(["bot:work"]);
  });

  it("clears an agent after its reply", () => {
    useLive.getState().onTyping(typing("bot"));
    useLive.getState().onProgress(progress("bot"));
    useLive.getState().agentDone("general", "bot");
    expect(replyingNames(useLive.getState().typing.general, useLive.getState().progress.general)).toEqual([]);
  });
});
