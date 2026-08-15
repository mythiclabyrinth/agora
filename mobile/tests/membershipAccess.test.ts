import { canManageMembershipScope, visibleMembershipScopes } from "../src/lib/membershipAccess";

test("group admins can manage every membership scope", () => {
  expect(canManageMembershipScope({ channel_id: null }, true, undefined, false)).toBe(true);
  expect(canManageMembershipScope({ channel_id: "other" }, true, "general", false)).toBe(true);
});

test("channel admins can manage only their channel-scoped rows", () => {
  expect(canManageMembershipScope({ channel_id: "general" }, false, "general", true)).toBe(true);
  expect(canManageMembershipScope({ channel_id: null }, false, "general", true)).toBe(false);
  expect(canManageMembershipScope({ channel_id: "other" }, false, "general", true)).toBe(false);
});

test("regular members cannot manage membership scopes", () => {
  expect(canManageMembershipScope({ channel_id: "general" }, false, "general", false)).toBe(false);
});

test("channel-focused removal receives only rendered scopes", () => {
  const scopes = [
    { channel_id: null, label: "group" },
    { channel_id: "general", label: "selected" },
    { channel_id: "private", label: "hidden" },
  ];
  expect(visibleMembershipScopes(scopes, "general").map(scope => scope.label)).toEqual([
    "group", "selected",
  ]);
  expect(visibleMembershipScopes(scopes).map(scope => scope.label)).toEqual([
    "group", "selected", "hidden",
  ]);
});
