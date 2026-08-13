import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Alert } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, ApiProvider, type AttachmentBrowserItem } from "@agora/core";
import { AttachmentBrowser } from "../src/components/AttachmentBrowser";

jest.mock("expo-file-system/legacy", () => ({ cacheDirectory: "file:///cache/", downloadAsync: jest.fn() }));
jest.mock("expo-sharing", () => ({ shareAsync: jest.fn() }));
jest.mock("expo-image", () => ({ Image: "Image" }));
jest.mock("lucide-react-native", () => new Proxy({}, { get: () => function MockIcon() { return null; } }));

const item = (overrides: Partial<AttachmentBrowserItem> = {}): AttachmentBrowserItem => ({
  id: "shot", filename: "launch.png", mime: "image/png", size: 1000, channel_id: "general",
  message_id: 42, thread_id: 40, author_type: "user", author_id: "tom", author_name: "Tom",
  message_text: "", ts: 1_750_000_000, thread_name: "Launch review", can_delete: true, ...overrides,
});
class TestApi extends ApiClient {
  readonly gets: string[] = [];
  readonly deletes: string[] = [];
  constructor(private readonly items: AttachmentBrowserItem[]) { super({ baseUrl: "https://example.invalid", token: "test" }); }
  override async get<T>(path: string) { this.gets.push(path); return { items: this.items, has_more: false, offset: 0 } as T; }
  override async delete<T>(path: string) { this.deletes.push(path); return {} as T; }
}

test("renders previews, thread context, delete authority, and opens the exact attachment message", async () => {
  const open = jest.fn();
  const api = new TestApi([item(), item({ id: "plan", filename: "plan.pdf", mime: "application/pdf", can_delete: false, thread_name: null })]);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(
        ApiProvider,
        { client: api },
        React.createElement(AttachmentBrowser, {
          channelId: "general", threadId: null,
          session: { baseUrl: "https://example.invalid", token: "test" }, onOpenMessage: open,
        }),
      ),
    ));
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    if (tree.root.findAllByType("Image" as never).length > 0) break;
  }
  expect(api.gets).toEqual(["/api/channels/general/attachments?offset=0"]);
  expect(tree.root.findAllByType("Image" as never)).toHaveLength(1);
  expect(tree.root.findByProps({ children: "Launch review" })).toBeTruthy();
  expect(tree.root.findAll((node) => node.props.accessibilityLabel === "Delete launch.png").length).toBeGreaterThan(0);
  expect(tree.root.findAll((node) => node.props.accessibilityLabel === "Delete plan.pdf")).toHaveLength(0);
  act(() => tree.root.findByProps({ accessibilityLabel: "Jump to launch.png" }).props.onPress());
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ message_id: 42, thread_id: 40 }));
  const alert = jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
    buttons?.find((button) => button.style === "destructive")?.onPress?.();
  });
  await act(async () => {
    tree.root.findAll((node) => node.props.accessibilityLabel === "Delete launch.png")[0].props.onPress();
    for (let attempt = 0; attempt < 5; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  });
  expect(api.deletes).toEqual(["/api/channels/general/attachments/shot"]);
  expect(alert).toHaveBeenCalledWith("Delete attachment?", expect.stringContaining("removed from Agora"), expect.any(Array));
  alert.mockRestore();
  act(() => tree.unmount()); qc.clear();
});
