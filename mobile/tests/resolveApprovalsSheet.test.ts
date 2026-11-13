import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Text } from "react-native";
import { useConversationApprovals, useResolveApprovals, type ApprovalItem, type PendingApproval } from "@agora/core";
import { ResolveApprovalsSheet } from "../src/components/ResolveApprovalsSheet";
import { toast, toastErr } from "../src/components/Toast";

jest.mock("@agora/core", () => ({
  ...jest.requireActual("@agora/core"), useConversationApprovals: jest.fn(), useResolveApprovals: jest.fn(),
}));
jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
jest.mock("../src/components/Toast", () => ({ toast: jest.fn(), toastErr: jest.fn() }));

const item = {
  kind: "thread", channel_id: "home", channel_name: "home", group_id: "g", group_name: "MacBook",
  thread_id: 77, title: "/new ~/Coding", pending_count: 4,
  message: { id: 1, author_type: "agent", author_id: "claude", author_name: "Claude", channel_id: "home", thread_id: 77, text: "Allow?", ts: 1 },
} as ApprovalItem;
const pending = (id: number, actions: PendingApproval["actions"], tool: string | null = null): PendingApproval =>
  ({ id, ts: id, author_name: "Claude", text: "Allow?", actions, tool });
const mutateAsync = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (useConversationApprovals as jest.Mock).mockReturnValue({ isLoading: false, isError: false, data: [
    pending(1, ["approve", "always", "reject"], "WebSearch"),
    pending(2, ["approve", "always", "reject"], "Bash"),
    pending(3, ["approve", "reject"]),
    pending(4, []),
  ] });
  (useResolveApprovals as jest.Mock).mockReturnValue({ mutateAsync, isPending: false });
});

function render(onClose = jest.fn()) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(ResolveApprovalsSheet, { item, onClose })); });
  return tree;
}
const choice = (tree: TestRenderer.ReactTestRenderer, label: string) =>
  tree.root.find(node => typeof node.props.accessibilityLabel === "string"
    && node.props.accessibilityLabel.startsWith(`${label},`) && typeof node.props.onPress === "function");

test("shows what each choice answers and the tools Always allow grants", () => {
  const tree = render();
  expect(useConversationApprovals).toHaveBeenCalledWith("home", 77);
  const text = tree.root.findAllByType(Text).map(n => [n.props.children].flat().join("")).join("\n");
  expect(text).toContain("4 pending requests · 1 needs answering one by one");
  // Each request is named before anything is approved.
  expect(tree.root.findAllByType(Text).filter(n => [n.props.children].flat().join("") === "Claude: ")).toHaveLength(4);
  expect(choice(tree, "Approve").props.accessibilityLabel).toBe("Approve, 3 requests");
  expect(choice(tree, "Always allow").props.accessibilityLabel)
    .toBe("Always allow, 2 requests · stops asking about WebSearch, Bash for this agent session");
  expect(choice(tree, "Reject").props.accessibilityLabel).toBe("Reject, 3 requests");
});

test("a choice sends exactly the listed requests that offer it, then reports and closes", async () => {
  const onClose = jest.fn();
  mutateAsync.mockResolvedValue({ resolved: 2, skipped: 0, failed: 0, results: [] });
  const tree = render(onClose);
  await act(async () => choice(tree, "Always allow").props.onPress());
  expect(mutateAsync).toHaveBeenCalledWith({ channelId: "home", threadId: 77, ids: [1, 2], action: "always" });
  expect(toast).toHaveBeenCalledWith("Resolved 2", undefined);
  expect(onClose).toHaveBeenCalled();
});

test("a failure shows in the sheet and as a toast (seen even if the sheet was closed)", async () => {
  const onClose = jest.fn();
  const error = new Error("offline");
  mutateAsync.mockRejectedValue(error);
  const tree = render(onClose);
  await act(async () => choice(tree, "Reject").props.onPress());
  const text = tree.root.findAllByType(Text).map(n => [n.props.children].flat().join("")).join("\n");
  expect(text).toContain("Resolve all failed: offline");
  expect(toastErr).toHaveBeenCalledWith("Resolve all failed", error);
  expect(onClose).not.toHaveBeenCalled();
});

test("a choice none of the requests offer is disabled", () => {
  (useConversationApprovals as jest.Mock).mockReturnValue({ isLoading: false, isError: false, data: [pending(3, ["approve", "reject"])] });
  const tree = render();
  const always = choice(tree, "Always allow");
  expect(always.props.disabled).toBe(true);
  expect(always.props.accessibilityLabel).toBe("Always allow, None of these offer it");
  act(() => always.props.onPress());
  expect(mutateAsync).not.toHaveBeenCalled();
});

test("a double tap sends one request, and a late result never closes a newer sheet", async () => {
  let finish!: (v: unknown) => void;
  mutateAsync.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const onClose = jest.fn();
  const tree = render(onClose);
  act(() => { choice(tree, "Approve").props.onPress(); choice(tree, "Approve").props.onPress(); });
  expect(mutateAsync).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
  await act(async () => finish({ resolved: 3, skipped: 0, failed: 0, results: [] }));
  expect(toast).toHaveBeenCalledWith("Resolved 3", undefined);
  expect(onClose).not.toHaveBeenCalled();
});

test("Always allow still names its scope when a request's tool can't be read", () => {
  (useConversationApprovals as jest.Mock).mockReturnValue({ isLoading: false, isError: false, data: [
    pending(1, ["approve", "always", "reject"], "Bash"), pending(2, ["approve", "always", "reject"]),
  ] });
  const tree = render();
  expect(choice(tree, "Always allow").props.accessibilityLabel)
    .toBe("Always allow, 2 requests · stops asking about Bash and the tool of each other request that offers it for this agent session");
});
