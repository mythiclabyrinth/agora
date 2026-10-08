import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { router } from "expo-router";
import { useSelectOption, type ApprovalItem } from "@agora/core";
import { ApprovalRow } from "../app/(app)/inbox";
import { toastErr } from "../src/components/Toast";

jest.mock("@agora/core", () => ({
  ...jest.requireActual("@agora/core"), useSelectOption: jest.fn(),
}));
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
jest.mock("../src/components/Toast", () => ({ toastErr: jest.fn() }));

const mutate = jest.fn();
const approval = {
  kind: "channel", channel_id: "general", channel_name: "general", group_id: "product", group_name: "Product",
  thread_id: null, title: null, pending_count: 1,
  message: { id: 520, author_type: "agent", author_id: "claude-cli", author_name: "Claude",
    channel_id: "general", thread_id: null, text: "Approve this action?", ts: 1,
    meta: { approval_inbox: true, options: [
      { id: "allow", label: "Approve" }, { id: "deny", label: "Reject" },
    ] },
  },
} as ApprovalItem;

beforeEach(() => {
  jest.clearAllMocks();
  (useSelectOption as jest.Mock).mockReturnValue({ mutate, isPending: false });
});

test("approval options act in place without opening the conversation", () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(ApprovalRow, { item: approval })); });
  const buttons = tree.root.findAll(node => typeof node.props.onPress === "function");
  expect(buttons).toHaveLength(3);
  const open = tree.root.findByProps({ accessibilityLabel: "Approval from Claude in general" });
  expect(open.findAll(node => node !== open && typeof node.props.onPress === "function")).toHaveLength(0);
  expect(buttons[1].findAll(node => node.children.includes("Approve"))).not.toHaveLength(0);
  expect(buttons[2].findAll(node => node.children.includes("Reject"))).not.toHaveLength(0);
  expect(buttons[1].props.accessibilityRole).toBe("button");
  act(() => buttons[1].props.onPress());
  expect(mutate).toHaveBeenCalledWith(
    { messageId: 520, optionId: "allow" },
    expect.objectContaining({ onError: expect.any(Function) }),
  );
  expect(router.push).not.toHaveBeenCalled();
  const onError = mutate.mock.calls[0][1].onError;
  const error = new Error("This request has expired");
  act(() => onError(error));
  expect(toastErr).toHaveBeenCalledWith("Couldn't send choice", error);
  act(() => tree.unmount());
});

test("pending selections disable option buttons without making the card a tap target", () => {
  (useSelectOption as jest.Mock).mockReturnValue({ mutate, isPending: true });
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(ApprovalRow, { item: approval })); });
  const open = tree.root.findByProps({ accessibilityLabel: "Approval from Claude in general" });
  expect(open.findAll(node => node !== open && typeof node.props.onPress === "function")).toHaveLength(0);
  const buttons = tree.root.findAll(node => typeof node.props.onPress === "function");
  expect(buttons).toHaveLength(3);
  expect(buttons.slice(1).every(button => button.props.disabled)).toBe(true);
  expect(buttons.slice(1).every(button => button.props.accessibilityState?.disabled)).toBe(true);
  act(() => tree.unmount());
});

test("form-only approval cards have no inline buttons", () => {
  const form = { ...approval, message: { ...approval.message,
    meta: { approval_inbox: true, form: { fields: [], buttons: [] } },
  } } as ApprovalItem;
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(ApprovalRow, { item: form })); });
  expect(tree.root.findAll(node => typeof node.props.onPress === "function")).toHaveLength(1);
  expect(useSelectOption).not.toHaveBeenCalled();
  act(() => tree.unmount());
});
