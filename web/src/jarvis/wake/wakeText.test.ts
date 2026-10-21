import { describe, expect, it } from "vitest";
import { stripWakePhrase, wakePhraseEnd } from "./wakeText";

describe("stripWakePhrase", () => {
  it.each([
    ["Hey Agora, what's on my list?", "what's on my list?"],
    ["hey agora what's on my list", "what's on my list"],
    ["Hey, Agora. Summarize the thread.", "Summarize the thread."],
    ["Hi Jarvis! Open the release room", "Open the release room"],
    ["Okay Agora: ping Claude", "ping Claude"],
    ["A Agora, hello", "hello"], // Whisper mishearing "Hey" as "A"
    ["- Agora! Read it back", "Read it back"],
    ["Agora, start a call", "start a call"],
    ["HEY AGORA", ""],
  ])("%j -> %j", (input, expected) => {
    expect(stripWakePhrase(input)).toBe(expected);
  });

  it.each([
    "Agora is slow today",
    "What's on my list?",
    "Hey Siri, what time is it",
    "Hey there Agora",
    "Agoras are Greek marketplaces",
    "",
    "   ",
    "Hey",
  ])("keeps %j unchanged", (input) => {
    expect(wakePhraseEnd(input)).toBe(0);
    expect(stripWakePhrase(input)).toBe(input);
  });

  it("accepts extra wake names from the caller", () => {
    expect(stripWakePhrase("Hey Claude, run the tests", ["claude"])).toBe("run the tests");
    expect(stripWakePhrase("Hey Claude, run the tests")).toBe("Hey Claude, run the tests");
  });

  it("treats non-ASCII letters as part of a word", () => {
    expect(stripWakePhrase("Hey Agoraé, hi")).toBe("Hey Agoraé, hi");
  });
});
