import type { Member } from "@agora/core";
import { accessDraft, applyAccess, planAccess, type AccessDraft } from "../src/lib/participantAccess";
const scope = (channel_id: string | null, role: "member" | "admin" = "member", member_type: "user" | "agent" = "user"): Member => ({ member_id: "maya", name: "Maya", channel_id, role, member_type, added_at: 0 });
const groupAdmin = { groupAdmin: true, channelIds: ["general", "design"] };
const channelAdmin = { groupAdmin: false, channelIds: ["general"] };
const selected = (channels: AccessDraft["channels"]): AccessDraft => ({ mode: "channels", role: "member", channels });
test("whole-group grant supersedes channel roles", () => {
  expect(accessDraft([scope(null, "admin"), scope("general")]).mode).toBe("group");
  expect(planAccess([scope("general")], { mode: "group", role: "admin", channels: {} }, groupAdmin)).toEqual([{ kind: "add", channelId: null, role: "admin" }]);
});
test("group narrowing removes global first and applies each selected role", () => {
  expect(planAccess([scope(null)], selected({ general: "admin", design: "member" }), groupAdmin)).toEqual([
    { kind: "remove", channelId: null, role: "member" }, { kind: "add", channelId: "general", role: "admin" }, { kind: "add", channelId: "design", role: "member" },
  ]);
});
test("channel admins can change their channel and preserve another channel", () => {
  expect(planAccess([scope("general"), scope("design")], selected({ general: "admin", design: "member" }), channelAdmin)).toEqual([{ kind: "add", channelId: "general", role: "admin" }]);
});
test.each([
  selected({ general: "member", design: "admin" }), selected({ general: "member" }),
  { mode: "group", role: "admin", channels: {} } as AccessDraft,
])("channel admin cannot change or remove another scope", draft => {
  expect(() => planAccess([scope("general"), scope("design")], draft, channelAdmin)).toThrow();
});
test("inherited global grant cannot be narrowed by channel admin", () => {
  expect(() => planAccess([scope(null)], selected({ general: "admin" }), channelAdmin)).toThrow("inherited");
});
test("additions precede removals for selected-channel access", () => {
  expect(planAccess([scope("general")], selected({ design: "member" }), groupAdmin).map(change => change.kind)).toEqual(["add", "remove"]);
});
test("agent global conversion cleans up narrower rows", () => {
  expect(planAccess([scope("general", "member", "agent")], { mode: "group", role: "member", channels: {} }, groupAdmin)).toEqual([
    { kind: "add", channelId: null, role: "member" }, { kind: "remove", channelId: "general", role: "member" },
  ]);
});
test("agent narrowing removes unselected shadowed grants", () => {
  expect(planAccess([scope(null, "member", "agent"), scope("design", "member", "agent")], selected({ general: "member" }), groupAdmin)).toContainEqual({ kind: "remove", channelId: "design", role: "member" });
});
test("failed narrowing restores the prior global role", async () => {
  const apply = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
  await expect(applyAccess(planAccess([scope(null, "admin")], selected({ general: "member" }), groupAdmin), apply)).rejects.toThrow("restored");
  expect(apply.mock.calls[2][0]).toEqual({ kind: "add", channelId: null, role: "admin" });
});
test("restoration failure reports partial state explicitly", async () => {
  const apply = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("offline"));
  await expect(applyAccess(planAccess([scope(null)], selected({ general: "member" }), groupAdmin), apply)).rejects.toThrow("could not be restored");
});
test("no-op draft makes no requests", async () => {
  const apply = jest.fn(); await applyAccess(planAccess([scope("general")], selected({ general: "member" }), groupAdmin), apply);
  expect(apply).not.toHaveBeenCalled();
});
