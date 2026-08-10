import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Image, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as FileSystem from "expo-file-system/legacy";
import { Composer, withinUploadLimit } from "../src/components/Composer";
import { Attachments, VideoAttachment } from "../src/components/Attachments";
import { useMessageDrafts } from "@agora/core";

jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  EncodingType: { Base64: "base64" },
  copyAsync: jest.fn(async () => {}),
  deleteAsync: jest.fn(async () => {}),
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 4_096 })),
  writeAsStringAsync: jest.fn(async () => {}),
}));

test("mobile attachment limits reject known oversize files but allow unknown sizes", () => {
  expect(withinUploadLimit({ uri: "file:///clip.mp4", name: "clip.mp4", type: "video/mp4", size: 60 * 1024 * 1024 }, 10, 100)).toBe(true);
  expect(withinUploadLimit({ uri: "file:///doc.pdf", name: "doc.pdf", type: "application/pdf", size: 60 * 1024 * 1024 }, 10, 100)).toBe(false);
  expect(withinUploadLimit({ uri: "content://provider/file", name: "file", type: "application/pdf" }, 10, 100)).toBe(true);
});
jest.mock("expo-paste-input", () => {
  const mockReact = require("react");
  const { View: MockView } = require("react-native");
  return {
    TextInputWrapper: ({ children, ...props }: React.PropsWithChildren<object>) =>
      mockReact.createElement(MockView, { ...props, testID: "paste-aware-input" }, children),
  };
});
jest.mock("expo-audio", () => ({
  AudioModule: { requestRecordingPermissionsAsync: jest.fn() },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: jest.fn(),
  useAudioRecorder: () => ({
    prepareToRecordAsync: jest.fn(),
    record: jest.fn(),
    stop: jest.fn(),
  }),
  useAudioRecorderState: () => ({ durationMillis: 0 }),
}));
jest.mock("lucide-react-native", () => new Proxy({}, {
  get: () => function MockIcon() { return null; },
}));

const files = [
  { uri: "file:///image.heic", name: "image.heic", type: "image/heic", size: 1_024 },
  { uri: "file:///middle.pdf", name: "middle.pdf", type: "application/pdf", size: 2_048 },
  { uri: "file:///last.txt", name: "last.txt", type: "text/plain" },
];

beforeEach(() => {
  jest.clearAllMocks();
  useMessageDrafts.setState({ byConvo: {} });
  (FileSystem.copyAsync as jest.Mock).mockResolvedValue(undefined);
  (FileSystem.deleteAsync as jest.Mock).mockResolvedValue(undefined);
  (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 4_096 });
});

test("drafts follow in-place conversation changes and restore when returning", () => {
  const props = { placeholder: "Message #test", mentions: [], sending: false, onSend: async () => {} };
  const screen = (addressKey: string) => React.createElement(
    SafeAreaProvider,
    { initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, right: 0, bottom: 0, left: 0 } } },
    React.createElement(Composer, { ...props, addressKey }),
  );
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(screen("channel-a"));
  });
  act(() => tree.root.findByType(TextInput).props.onChangeText("draft for A"));
  act(() => tree.update(screen("channel-b")));
  expect(tree.root.findByType(TextInput).props.value).toBe("");
  act(() => tree.root.findByType(TextInput).props.onChangeText("draft for B"));
  act(() => tree.update(screen("channel-a")));
  expect(tree.root.findByType(TextInput).props.value).toBe("draft for A");
  expect(useMessageDrafts.getState().byConvo).toEqual({ "channel-a": "draft for A", "channel-b": "draft for B" });
  act(() => tree.unmount());

  act(() => { tree = TestRenderer.create(screen("channel-a")); });
  expect(tree.root.findByType(TextInput).props.value).toBe("draft for A");
  act(() => tree.unmount());
});

test("successful send clears its draft while a failed send retains it", async () => {
  const onSend = jest.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(React.createElement(
      SafeAreaProvider,
      { initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, right: 0, bottom: 0, left: 0 } } },
      React.createElement(Composer, {
        placeholder: "Message #test", mentions: [], addressKey: "channel-a", sending: false, onSend,
      }),
    ));
  });
  const input = () => tree.root.findByType(TextInput);
  act(() => input().props.onChangeText("keep me"));
  act(() => input().props.onContentSizeChange({ nativeEvent: { contentSize: { width: 300, height: 120 } } }));
  expect(StyleSheet.flatten(input().props.style).height).toBe(120);
  await act(async () => { await labelled(tree.root, "Send message").props.onPress(); });
  expect(useMessageDrafts.getState().byConvo["channel-a"]).toBe("keep me");
  expect(StyleSheet.flatten(input().props.style).height).toBe(120);
  await act(async () => { await labelled(tree.root, "Send message").props.onPress(); });
  expect(useMessageDrafts.getState().byConvo["channel-a"]).toBeUndefined();
  expect(input().props.value).toBe("");
  expect(StyleSheet.flatten(input().props.style).height).toBe(40);
  act(() => tree.unmount());
});

test("text typed while a send is pending survives when the earlier send completes", async () => {
  let finishSend!: () => void;
  const onSend = jest.fn(() => new Promise<void>((resolve) => { finishSend = resolve; }));
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(React.createElement(
      SafeAreaProvider,
      { initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, right: 0, bottom: 0, left: 0 } } },
      React.createElement(Composer, {
        placeholder: "Message #test", mentions: [], addressKey: "channel-a", sending: false, onSend,
      }),
    ));
  });
  act(() => tree.root.findByType(TextInput).props.onChangeText("first message"));
  let pending!: Promise<void>;
  act(() => { pending = labelled(tree.root, "Send message").props.onPress(); });
  act(() => tree.root.findByType(TextInput).props.onChangeText("next message"));
  await act(async () => {
    finishSend();
    await pending;
  });

  expect(useMessageDrafts.getState().byConvo["channel-a"]).toBe("next message");
  expect(tree.root.findByType(TextInput).props.value).toBe("next message");
  act(() => tree.unmount());
});

function labelled(root: TestRenderer.ReactTestInstance, label: string) {
  return root.find((node) => node.props.accessibilityLabel === label);
}

test("composer attachment cards preview images and remove the selected file", () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(
      SafeAreaProvider,
      {
        initialMetrics: {
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, right: 0, bottom: 0, left: 0 },
        },
      },
      React.createElement(Composer, {
        placeholder: "Message #test",
        mentions: [],
        sending: false,
        initialFiles: files,
        onSend: async () => {},
      }),
    ));
  });

  expect(labelled(tree.root, "Preview image.heic")).toBeDefined();
  expect(labelled(tree.root, "Remove image.heic")).toBeDefined();
  expect(labelled(tree.root, "Remove middle.pdf")).toBeDefined();
  expect(labelled(tree.root, "Remove last.txt")).toBeDefined();
  expect(tree.root.findAll((node) => node.props.accessibilityLabel === "Preview middle.pdf"))
    .toHaveLength(0);
  expect(tree.root.findAllByProps({ children: "1.0 KB" }).length).toBeGreaterThan(0);
  expect(tree.root.findAllByProps({ children: "2.0 KB" }).length).toBeGreaterThan(0);

  act(() => labelled(tree.root, "Preview image.heic").props.onPress());
  expect(labelled(tree.root, "Close image preview")).toBeDefined();
  act(() => labelled(tree.root, "Close image preview").props.onPress());
  expect(tree.root.findAll((node) => node.props.accessibilityLabel === "Close image preview"))
    .toHaveLength(0);

  act(() => labelled(tree.root, "Remove middle.pdf").props.onPress());

  expect(labelled(tree.root, "Remove image.heic")).toBeDefined();
  expect(labelled(tree.root, "Remove last.txt")).toBeDefined();
  expect(tree.root.findAll((node) => node.props.accessibilityLabel === "Remove middle.pdf"))
    .toHaveLength(0);
  act(() => tree.unmount());
});

test("native image paste becomes an attachment while text paste stays native", async () => {
  jest.spyOn(Image, "getSize").mockImplementation((_, success) => {
    success(640, 480);
  });

  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(React.createElement(
      SafeAreaProvider,
      {
        initialMetrics: {
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, right: 0, bottom: 0, left: 0 },
        },
      },
      React.createElement(Composer, {
        placeholder: "Message #test",
        mentions: [],
        sending: false,
        onSend: async () => {},
      }),
    ));
  });

  const pasteInput = tree.root.findByProps({ testID: "paste-aware-input" });
  expect(StyleSheet.flatten(tree.root.findByType(TextInput).props.style).flex).toBe(0);
  await act(async () => {
    pasteInput.props.onPaste({ type: "text", value: "ordinary paste" });
    await Promise.resolve();
  });
  expect(tree.root.findAll((node) => node.props.accessibilityLabel?.startsWith("Remove pasted-")))
    .toHaveLength(0);

  await act(async () => {
    pasteInput.props.onPaste({ type: "images", uris: ["file:///tmp/copied.png"] });
    await Promise.resolve();
  });

  expect(FileSystem.copyAsync).toHaveBeenCalledWith({
    from: "file:///tmp/copied.png",
    to: expect.stringMatching(/^file:\/\/\/cache\/pasted-\d+-\d+-0\.png$/),
  });
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
    "file:///tmp/copied.png",
    { idempotent: true },
  );
  expect(tree.root.find(
    (node) => node.type === View && node.props.accessibilityLabel?.startsWith("Remove pasted-"),
  )).toBeDefined();
  act(() => tree.unmount());
});

test("Android wraps the composer input for native image paste", () => {
  const originalOS = Platform.OS;
  Object.defineProperty(Platform, "OS", { configurable: true, value: "android" });
  let tree!: TestRenderer.ReactTestRenderer;
  try {
    act(() => {
      tree = TestRenderer.create(React.createElement(
        SafeAreaProvider,
        {
          initialMetrics: {
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 0, right: 0, bottom: 0, left: 0 },
          },
        },
        React.createElement(Composer, {
          placeholder: "Message #test",
          mentions: [],
          sending: false,
          onSend: async () => {},
        }),
      ));
    });
    expect(tree.root.findByProps({ testID: "paste-aware-input" })).toBeDefined();
    expect(StyleSheet.flatten(tree.root.findByType(TextInput).props.style).flex).toBe(0);
  } finally {
    if (tree) act(() => tree.unmount());
    Object.defineProperty(Platform, "OS", { configurable: true, value: originalOS });
  }
});

test("web leaves the composer input unwrapped", () => {
  const originalOS = Platform.OS;
  Object.defineProperty(Platform, "OS", { configurable: true, value: "web" });
  let tree!: TestRenderer.ReactTestRenderer;
  try {
    act(() => {
      tree = TestRenderer.create(React.createElement(
        SafeAreaProvider,
        {
          initialMetrics: {
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 0, right: 0, bottom: 0, left: 0 },
          },
        },
        React.createElement(Composer, {
          placeholder: "Message #test",
          mentions: [],
          sending: false,
          onSend: async () => {},
        }),
      ));
    });
    expect(tree.root.findAllByProps({ testID: "paste-aware-input" })).toHaveLength(0);
    expect(StyleSheet.flatten(tree.root.findByType(TextInput).props.style).flex).toBe(1);
  } finally {
    if (tree) act(() => tree.unmount());
    Object.defineProperty(Platform, "OS", { configurable: true, value: originalOS });
  }
});

test("attachment sheet does not offer a separate paste image action", () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(
      SafeAreaProvider,
      {
        initialMetrics: {
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, right: 0, bottom: 0, left: 0 },
        },
      },
      React.createElement(Composer, {
        placeholder: "Message #test",
        mentions: [],
        sending: false,
        onSend: async () => {},
      }),
    ));
  });
  /* The sheet is a Modal: closed, it renders nothing, so asserting the row's
     absence only means anything once the "+" has actually opened it — hence
     the "Photo library" check pinning that the sheet really is on screen. */
  const [plus] = tree.root.findAll((node) =>
    typeof node.props.onPress === "function" &&
    node.findAll((child) => child.type === Text && child.props.children === "+").length > 0
  );
  act(() => plus.props.onPress());
  expect(tree.root.findAllByProps({ children: "Photo library" }).length).toBeGreaterThan(0);
  expect(tree.root.findAllByProps({ children: "Paste image" })).toHaveLength(0);
  act(() => tree.unmount());
});

test("native paste cleans unused temporary images when the draft already has five files", async () => {
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(React.createElement(
      SafeAreaProvider,
      {
        initialMetrics: {
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, right: 0, bottom: 0, left: 0 },
        },
      },
      React.createElement(Composer, {
        placeholder: "Message #test",
        mentions: [],
        sending: false,
        initialFiles: [...files, files[0], files[1]],
        onSend: async () => {},
      }),
    ));
  });

  await act(async () => {
    tree.root.findByProps({ testID: "paste-aware-input" }).props.onPaste({
      type: "images",
      uris: ["file:///tmp/unused-a.png", "file:///tmp/unused-b.png"],
    });
    await Promise.resolve();
  });

  expect(FileSystem.copyAsync).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
    "file:///tmp/unused-a.png",
    { idempotent: true },
  );
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
    "file:///tmp/unused-b.png",
    { idempotent: true },
  );
  act(() => tree.unmount());
});

test("send waits for native paste processing and failed copies clean both temporary paths", async () => {
  let releaseCopy!: () => void;
  (FileSystem.copyAsync as jest.Mock)
    .mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseCopy = resolve;
    }))
    .mockRejectedValueOnce(new Error("copy failed"));
  jest.spyOn(Image, "getSize").mockImplementation((_, success) => {
    success(640, 480);
  });
  const onSend = jest.fn(async () => {});

  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(React.createElement(
      SafeAreaProvider,
      {
        initialMetrics: {
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, right: 0, bottom: 0, left: 0 },
        },
      },
      React.createElement(Composer, {
        placeholder: "Message #test",
        mentions: [],
        sending: false,
        initialFiles: [files[0]],
        onSend,
      }),
    ));
  });

  act(() => {
    tree.root.findByProps({ testID: "paste-aware-input" }).props.onPaste({
      type: "images",
      uris: ["file:///tmp/slow.png"],
    });
  });
  expect(labelled(tree.root, "Processing pasted image").props.disabled).toBe(true);
  await act(async () => {
    labelled(tree.root, "Processing pasted image").props.onPress();
    await Promise.resolve();
  });
  expect(onSend).not.toHaveBeenCalled();

  await act(async () => {
    releaseCopy();
    await new Promise((resolve) => setImmediate(resolve));
  });
  expect(labelled(tree.root, "Send message").props.disabled).toBe(false);

  await act(async () => {
    tree.root.findByProps({ testID: "paste-aware-input" }).props.onPaste({
      type: "images",
      uris: ["file:///tmp/broken.png"],
    });
    await new Promise((resolve) => setImmediate(resolve));
  });
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
    "file:///tmp/broken.png",
    { idempotent: true },
  );
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
    expect.stringMatching(/^file:\/\/\/cache\/pasted-\d+-\d+-0\.png$/),
    { idempotent: true },
  );
  act(() => tree.unmount());
});

test("sent image attachments open and close the full-screen preview", () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(Attachments, {
      session: { baseUrl: "https://example.invalid", token: "test" },
      attachments: [{
        id: "image",
        filename: "agent-diagram.svg",
        mime: "image/svg+xml",
        size: 4_096,
      }],
      imageSource: () => ({ uri: "data:image/svg+xml,<svg/>" }),
    }));
  });

  expect(labelled(tree.root, "Preview agent-diagram.svg")).toBeDefined();
  act(() => labelled(tree.root, "Preview agent-diagram.svg").props.onPress());
  const modal = tree.root.find((node) => node.props.accessibilityViewIsModal === true);
  expect(modal.find((node) => node.props.accessibilityLabel === "Close image preview")).toBeDefined();
  expect(modal.find((node) =>
    node.props.accessibilityLabel === "agent-diagram.svg" && node.props.accessible === true
  )).toBeDefined();
  expect(modal.findAll((node) =>
    node.type === Text && node.props.children === "agent-diagram.svg"
  )).toHaveLength(0);
  expect(tree.root.findAll((node) => node.props.accessibilityLabel === "Next image")).toHaveLength(0);
  act(() => labelled(tree.root, "Close image preview").props.onPress());
  expect(tree.root.findAll((node) => node.props.accessibilityLabel === "Close image preview"))
    .toHaveLength(0);
  act(() => tree.unmount());
});

test("sent image gallery navigates only images in the same mixed attachment message", () => {
  const attachments = [
    { id: "first", filename: "first.png", mime: "image/png", size: 100 },
    { id: "notes", filename: "notes.pdf", mime: "application/pdf", size: 200 },
    { id: "second", filename: "second.png", mime: "image/png", size: 300 },
    { id: "clip", filename: "clip.mp4", mime: "video/mp4", size: 400 },
    { id: "third", filename: "third.png", mime: "image/png", size: 500 },
  ];
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(Attachments, {
      session: { baseUrl: "https://example.invalid", token: "test" }, attachments,
      imageSource: (attachment: { id: string }) => ({ uri: `data:image/png,${attachment.id}` }),
    }));
  });
  act(() => labelled(tree.root, "Preview first.png").props.onPress());
  expect(labelled(tree.root, "Previous image").props.accessibilityState.disabled).toBe(true);
  expect(tree.root.findByProps({ accessibilityLiveRegion: "polite" }).props.children).toEqual(["Image ", 1, " of ", 3]);
  act(() => labelled(tree.root, "Next image").props.onPress());
  expect(labelled(tree.root, "second.png")).toBeDefined();
  act(() => labelled(tree.root, "Next image").props.onPress());
  expect(labelled(tree.root, "third.png")).toBeDefined();
  expect(labelled(tree.root, "Next image").props.accessibilityState.disabled).toBe(true);
  act(() => labelled(tree.root, "Previous image").props.onPress());
  expect(labelled(tree.root, "second.png")).toBeDefined();
  act(() => tree.unmount());
});

test("sent image gallery closes if its active attachment is removed", () => {
  const props = (attachments: Array<{ id: string; filename: string; mime: string; size: number }>) => React.createElement(Attachments, {
    session: { baseUrl: "https://example.invalid", token: "test" }, attachments,
    imageSource: (attachment: { id: string }) => ({ uri: `data:image/png,${attachment.id}` }),
  });
  const first = { id: "first", filename: "first.png", mime: "image/png", size: 100 };
  const second = { id: "second", filename: "second.png", mime: "image/png", size: 100 };
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(props([first, second])); });
  act(() => labelled(tree.root, "Preview second.png").props.onPress());
  expect(labelled(tree.root, "Close image preview")).toBeDefined();
  act(() => tree.update(props([first])));
  expect(tree.root.findAll((node) => node.props.accessibilityLabel === "Close image preview")).toHaveLength(0);
  act(() => tree.unmount());
});

test("sent video attachments render an authenticated native player", () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(Attachments, {
      session: { baseUrl: "https://example.invalid", token: "test" },
      attachments: [{ id: "video", filename: "demo.mp4", mime: "video/mp4", size: 24_000_000 }],
    }));
  });
  expect(tree.root.findByProps({ testID: "video-view" }).props.player.source).toEqual({
    uri: "https://example.invalid/api/files/video",
    headers: { Authorization: "Bearer test" },
  });
  act(() => tree.unmount());
});

test("failed native video playback falls back to a file card", () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(Attachments, {
      session: { baseUrl: "https://example.invalid", token: "test" },
      attachments: [{ id: "video-error", filename: "broken.mp4", mime: "video/mp4", size: 24_000_000 }],
    }));
  });
  act(() => tree.root.findByType(VideoAttachment).props.onError());
  expect(tree.root.findAllByProps({ testID: "video-view" })).toHaveLength(0);
  expect(tree.root.findByProps({ children: "broken.mp4" })).toBeDefined();
  act(() => tree.unmount());
});

test("iOS WebM attachments fall back to the downloadable file card", () => {
  const original = Platform.OS;
  Object.defineProperty(Platform, "OS", { configurable: true, value: "ios" });
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(Attachments, {
      session: { baseUrl: "https://example.invalid", token: "test" },
      attachments: [{ id: "video", filename: "screen.webm", mime: "video/webm", size: 8_000_000 }],
    }));
  });
  expect(tree.root.findAllByProps({ testID: "video-view" })).toHaveLength(0);
  expect(tree.root.findByProps({ children: "screen.webm" })).toBeDefined();
  act(() => tree.unmount());
  Object.defineProperty(Platform, "OS", { configurable: true, value: original });
});
