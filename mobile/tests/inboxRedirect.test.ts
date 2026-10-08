import ThreadsRedirect from "../app/(app)/threads";
import { inboxTabFromParam } from "../app/(app)/inbox";

jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
jest.mock("expo-router", () => ({
  Redirect: () => null,
  Stack: { Screen: () => null },
  router: { push: jest.fn() },
  useLocalSearchParams: () => ({ tab: "threads" }),
}));

it("sends the old Threads route to the Threads tab", () => {
  const redirect = ThreadsRedirect();
  expect(redirect.props.href).toBe("/(app)/inbox?tab=threads");
  expect(inboxTabFromParam(new URL(redirect.props.href, "https://agora.test").searchParams.get("tab") ?? undefined))
    .toBe("threads");
});

it("accepts the Approvals tab parameter", () => {
  expect(inboxTabFromParam("approvals")).toBe("approvals");
  expect(inboxTabFromParam("invalid")).toBeNull();
});
