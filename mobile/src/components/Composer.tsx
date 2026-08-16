/* Message composer: text, attachments (max 5, like the server), voice notes
   (🎤 → transcribed server-side), @mention autocomplete over the channel's
   live agents + group members, and a "talk to" multi-select that prepends
   the chosen agents' mentions to every message sent here. */

import React, { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Image as ReactNativeImage,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { TextInputWrapper, type PasteEventPayload } from "expo-paste-input";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { Image } from "expo-image";
import {
  ArrowUp,
  AtSign,
  Bot,
  Camera,
  Check,
  FileText,
  Image as ImageIcon,
  MessageSquareReply,
  Mic,
  NotepadText,
  Paperclip,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { OutgoingFile } from "@agora/core";
import { fmtSize, MAX_MESSAGE_CHARS, slugify, uploadMaxBytes } from "@agora/core";
import { toOutgoing, type LocalFile } from "../api/voice";
import { useKeyboardVisible } from "../lib/keyboard";
import { colors } from "../lib/theme";
import { useAddressed, useMessageDrafts } from "@agora/core";
import { usePrefs } from "../state/prefs";
import { AgentAvatar } from "./AgentAvatar";
import { Icon } from "./Icon";
import { toast, toastErr } from "./Toast";
import { ImagePreviewModal } from "./ImagePreviewModal";
import { NATIVE_IMAGE, WEB_SAFE_IMAGE } from "../lib/files";
import { TemplateSheet } from "./TemplateSheet";

const NONE_ADDRESSED: string[] = [];

const MAX_FILES = 5;

/** Keep-awake tag for voice notes: the screen must not auto-lock mid-take. */
const REC_KEEP_AWAKE = "composer-voice-note";
const COMPOSER_INPUT_MIN_HEIGHT = 40;

/** Longest edge for uploads; keeps photos comfortably under server caps. */
const MAX_IMAGE_EDGE = 2048;

const PASTED_IMAGE_MIME: Record<string, string> = {
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
};
let pastedImageSequence = 0;

function imageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    ReactNativeImage.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      () => resolve({ width: 0, height: 0 }),
    );
  });
}

function PasteAwareInput({
  children,
  enabled,
  onPaste,
  style,
}: {
  children: ReactElement;
  enabled: boolean;
  onPaste: (payload: PasteEventPayload) => void;
  style: StyleProp<ViewStyle>;
}) {
  if (!enabled) return children;
  return <TextInputWrapper style={style} onPaste={onPaste}>{children}</TextInputWrapper>;
}

async function toWebSafeImage(a: ImagePicker.ImagePickerAsset): Promise<LocalFile> {
  const type = a.mimeType ?? "image/jpeg";
  const name = a.fileName ?? `photo-${Date.now()}.jpg`;
  let width = a.width ?? 0;
  let height = a.height ?? 0;
  if (width <= 0 || height <= 0) {
    const probe = await ImageManipulator.manipulate(a.uri).renderAsync();
    width = probe.width;
    height = probe.height;
  }
  const oversize = Math.max(width, height) > MAX_IMAGE_EDGE;
  if (WEB_SAFE_IMAGE.test(type) && !oversize) {
    return { uri: a.uri, name, type, size: a.fileSize };
  }
  const ctx = ImageManipulator.manipulate(a.uri);
  if (oversize) {
    ctx.resize(
      width >= height ? { width: MAX_IMAGE_EDGE } : { height: MAX_IMAGE_EDGE },
    );
  }
  const rendered = await ctx.renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
  const info = await FileSystem.getInfoAsync(saved.uri).catch(() => null);
  return {
    uri: saved.uri,
    name: name.replace(/\.[a-z0-9]+$/i, "") + ".jpg",
    type: "image/jpeg",
    size: info?.exists ? info.size : undefined,
  };
}

export interface MentionCandidate {
  id: string;
  name: string;
}

export function withinUploadLimit(file: LocalFile, maxFileMb?: number, maxVideoMb?: number) {
  const maxBytes = uploadMaxBytes(file.type, maxFileMb, maxVideoMb);
  return file.size === undefined || maxBytes === undefined || file.size <= maxBytes;
}

export function Composer({
  placeholder,
  mentions,
  agents = [],
  addressKey,
  groupId,
  sending,
  threadToggle,
  requireAgentToggle,
  onSend,
  onSendVoice,
  initialFiles = [],
  maxFileMb,
  maxVideoMb,
}: {
  placeholder: string;
  mentions: MentionCandidate[];
  /** The channel's agents for the "talk to" multi-select; empty hides it. */
  agents?: MentionCandidate[];
  /** Conversation key (channel id / channel:t<root>) the "talk to" selection
      is remembered under for the app session; unset hides the picker. */
  addressKey?: string;
  /** Resolved containing group; templates stay hidden until it is known. */
  groupId?: string;
  sending: boolean;
  /** Offer the per-message "reply in thread" ask (agents answer in a thread
      under the message). Channel composer only — a thread already is one. */
  threadToggle?: boolean;
  /** Sticky thread ask: only tagged agents act. Hidden in agent DMs. */
  requireAgentToggle?: boolean;
  onSend: (v: {
    text: string;
    files: OutgoingFile[];
    replyInThread?: boolean;
    requireAgent?: boolean;
  }) => Promise<void>;
  /** When set (server has voice), a 🎤 button records a voice note and hands
      the file here for the transcribe-and-post upload. `mentions` carries the
      "talk to" prefix ("@a, @b") so the transcript addresses the same agents
      a typed message would. */
  onSendVoice?: (file: LocalFile, mentions?: string) => Promise<void>;
  /** Deterministic initial attachments for component catalogs and tests. */
  initialFiles?: LocalFile[];
  maxFileMb?: number;
  maxVideoMb?: number;
}) {
  /* Keep this render-time so platform-branch tests can verify Android rather
     than inheriting the test runtime's iOS value captured at module load. */
  const nativePasteInput = Platform.OS === "ios" || Platform.OS === "android";
  const storedText = useMessageDrafts((s) => (addressKey ? s.byConvo[addressKey] ?? "" : undefined));
  const setStoredText = useMessageDrafts((s) => s.setDraft);
  const [localText, setLocalText] = useState("");
  const text = storedText ?? localText;
  const setText = (next: string) => {
    if (addressKey) setStoredText(addressKey, next);
    else setLocalText(next);
  };
  const [files, setFiles] = useState<LocalFile[]>(initialFiles);
  const filesRef = useRef<LocalFile[]>(initialFiles);
  const [preview, setPreview] = useState<LocalFile | null>(null);
  const [focused, setFocused] = useState(false);
  const [inputHeight, setInputHeight] = useState(COMPOSER_INPUT_MIN_HEIGHT);
  const [attachSheet, setAttachSheet] = useState(false);
  const [pasteOps, setPasteOps] = useState(0);
  const pasteGeneration = useRef(0);
  const pasteReservations = useRef(0);
  /* "Reply in thread": one message's ask, so it resets after each send. */
  const [replyInThread, setReplyInThread] = useState(false);
  /* "Talk to": which agents this conversation addresses. Session-level state
     keyed by addressKey, so it's remembered when you leave and come back;
     their @mentions are prepended on send ("@a, @b, …"), so the server's
     mention routing delivers to exactly those agents. */
  const addressed =
    useAddressed((s) => (addressKey ? s.byConvo[addressKey] : undefined)) ?? NONE_ADDRESSED;
  const toggleAddr = useAddressed((s) => s.toggle);
  const clearAddr = useAddressed((s) => s.clear);
  const [addrSheet, setAddrSheet] = useState(false);
  const [templateSheet, setTemplateSheet] = useState(false);
  const [forcedSelection, setForcedSelection] = useState<{ start: number; end: number }>();
  const addressedAgents = useMemo(
    () => agents.filter((a) => addressed.includes(a.id)),
    [agents, addressed],
  );
  const showRequireAgent = !!requireAgentToggle && !!addressKey && agents.length > 0;
  const requireAgentOn = usePrefs((s) =>
    showRequireAgent && addressKey ? s.requireAgentThreads.includes(addressKey) : false,
  );
  const toggleRequireAgent = usePrefs((s) => s.toggleRequireAgent);
  const toggleAddressed = (id: string) => {
    if (addressKey) toggleAddr(addressKey, id);
  };
  const selection = useRef({ start: 0, end: 0 });
  const hasSelection = useRef(false);
  const inputRef = useRef<TextInput>(null);

  /* iOS multiline inputs do not reliably shrink after a controlled clear.
     Track their content height explicitly and restore the one-line baseline
     whenever the actual draft becomes empty. */
  useEffect(() => {
    if (!text) setInputHeight(COMPOSER_INPUT_MIN_HEIGHT);
  }, [text]);

  /* A native paste finishes asynchronously. Invalidate in-flight work when
     this composer changes conversation or unmounts so an old image can never
     land in a new draft. */
  useEffect(() => {
    pasteGeneration.current += 1;
    setPasteOps(0);
    /* Production composers remount per conversation, naturally resetting all
       local state (including attachments); only text survives via the store. */
    return () => {
      pasteGeneration.current += 1;
    };
  }, [addressKey]);

  /* iOS can't present the native picker while the attach-sheet Modal is
     still dismissing — the launch is silently dropped. Stash the action and
     run it from the Modal's onDismiss (fires after dismissal completes).
     Android has no such race, so run immediately there. */
  const pendingPick = useRef<(() => void) | null>(null);
  const closeSheet = (action?: () => void) => {
    setAttachSheet(false);
    if (!action) return;
    if (Platform.OS === "ios") {
      pendingPick.current = action;
    } else {
      action();
    }
  };
  const onSheetDismissed = () => {
    const action = pendingPick.current;
    pendingPick.current = null;
    action?.();
  };

  /* Voice note recording. The recorder hook is unconditional (hooks rule);
     nothing touches the mic until the 🎤 tap. */
  const [recPhase, setRecPhase] = useState<"idle" | "recording" | "uploading">("idle");
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recState = useAudioRecorderState(recorder, 500);

  const startRec = async () => {
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        toast("Microphone access is needed for voice messages", "warn");
        return;
      }
      // allowsBackgroundRecording: a long voice note must survive the phone
      // locking (auto-lock or pocketed mid-take); keep-awake just delays it.
      await setAudioModeAsync({
        allowsRecording: true,
        allowsBackgroundRecording: true,
        playsInSilentMode: true,
      });
      await recorder.prepareToRecordAsync();
      recorder.record();
      void activateKeepAwakeAsync(REC_KEEP_AWAKE).catch(() => {});
      setRecPhase("recording");
    } catch (e) {
      toastErr("Couldn't start recording", e);
    }
  };

  const stopRec = async (): Promise<string | null> => {
    try {
      await recorder.stop();
    } catch {
      /* already stopped */
    }
    void deactivateKeepAwake(REC_KEEP_AWAKE).catch(() => {});
    await setAudioModeAsync({
      allowsRecording: false,
      allowsBackgroundRecording: false,
      playsInSilentMode: true,
    }).catch(() => {});
    return recorder.uri;
  };

  const cancelRec = async () => {
    await stopRec();
    setRecPhase("idle");
  };

  const finishRec = async () => {
    const tooShort = (recState.durationMillis ?? 0) < 500;
    const uri = await stopRec();
    if (!uri || tooShort) {
      if (tooShort) toast("Recording too short", "warn");
      setRecPhase("idle");
      return;
    }
    setRecPhase("uploading");
    try {
      // Voice notes address the "talk to" agents exactly like typed sends.
      const prefix = addressedAgents.map((a) => `@${slugify(a.name)}`).join(", ");
      await onSendVoice?.(
        {
          uri,
          name: `voice-note-${Date.now()}.m4a`,
          type: "audio/m4a",
        },
        prefix || undefined,
      );
    } catch (e) {
      toastErr("Voice message failed", e);
    }
    setRecPhase("idle");
  };

  /* Clear the home indicator when the keyboard is down; sit flush against
     the keyboard when it's up (the KeyboardAvoidingView handles the lift). */
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const bottomPad = keyboardVisible ? 6 : Math.max(insets.bottom, 6);

  /* @mention autocomplete: active while the token before the cursor looks
     like a partial mention. */
  const mentionQuery = useMemo(() => {
    const upto = text.slice(0, selection.current.start || text.length);
    const m = /(^|\s)@([a-z0-9-]*)$/i.exec(upto);
    return m ? m[2].toLowerCase() : null;
  }, [text]);

  const candidates = useMemo(() => {
    if (mentionQuery === null) return [];
    return mentions
      .filter((c) => slugify(c.name).startsWith(mentionQuery) || c.id.toLowerCase().startsWith(mentionQuery))
      .slice(0, 6);
  }, [mentionQuery, mentions]);

  const insertMention = (c: MentionCandidate) => {
    const at = selection.current.start || text.length;
    const before = text.slice(0, at).replace(/@[a-z0-9-]*$/i, `@${slugify(c.name)} `);
    setText(before + text.slice(at));
    inputRef.current?.focus();
  };

  const addFiles = (picked: LocalFile[]): LocalFile[] => {
    const candidates = picked.filter(file => withinUploadLimit(file, maxFileMb, maxVideoMb));
    const oversized = picked.filter(file => !withinUploadLimit(file, maxFileMb, maxVideoMb));
    const accepted = candidates.slice(0, Math.max(0, MAX_FILES - filesRef.current.length));
    const dropped = [...oversized, ...candidates.slice(accepted.length)];
    filesRef.current = [...filesRef.current, ...accepted];
    setFiles(filesRef.current);
    if (oversized.length > 0) toast("One or more files exceed the server upload limit", "warn");
    if (candidates.length > accepted.length) toast(`Max ${MAX_FILES} files per message`, "warn");
    return dropped;
  };

  /* The native wrapper keeps React Native's real TextInput, but teaches
     its standard edit menu how to turn an image paste into temporary file
     URIs. Text events are deliberately ignored here: the native input has
     already inserted them normally. Some "Copy Image" sources publish both an image
     and a URL; the native wrapper intentionally gives the image precedence. */
  const onNativePaste = async (payload: PasteEventPayload) => {
    if (payload.type !== "images") return;

    const generation = pasteGeneration.current;
    setPasteOps((count) => count + 1);
    const pasted: LocalFile[] = [];
    let reserved = 0;
    try {
      const sourceUris = payload.uris.filter((uri): uri is string => typeof uri === "string");
      const available = Math.max(
        0,
        MAX_FILES - filesRef.current.length - pasteReservations.current,
      );
      const acceptedUris = sourceUris.slice(0, available);
      reserved = acceptedUris.length;
      pasteReservations.current += reserved;
      for (const sourceUri of sourceUris.slice(available)) {
        void FileSystem.deleteAsync(sourceUri, { idempotent: true }).catch(() => {});
      }
      if (sourceUris.length > available) toast(`Max ${MAX_FILES} files per message`, "warn");

      for (const [index, sourceUri] of acceptedUris.entries()) {
        const rawName = sourceUri.split("/").pop() ?? "";
        const ext = rawName.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() ?? "unknown";
        pastedImageSequence += 1;
        const name = `pasted-${Date.now()}-${pastedImageSequence}-${index}.${ext}`;
        const uri = `${FileSystem.cacheDirectory}${name}`;
        let normalized: LocalFile | null = null;
        try {
          /* expo-paste-input owns sourceUri in temporary storage. Copy it
             before returning from the callback so attachment previews/uploads
             never depend on the package's temporary-file lifetime. */
          await FileSystem.copyAsync({ from: sourceUri, to: uri });
          const [size, info] = await Promise.all([
            imageSize(uri),
            FileSystem.getInfoAsync(uri).catch(() => null),
          ]);
          normalized = await toWebSafeImage({
            uri,
            width: size.width,
            height: size.height,
            /* Unknown types are deliberately unsafe so normalization decodes
               and re-encodes them instead of mislabelling bytes as PNG. */
            mimeType: PASTED_IMAGE_MIME[ext] ?? "application/octet-stream",
            fileName: name,
            fileSize: info?.exists ? info.size : undefined,
          } as ImagePicker.ImagePickerAsset);
          pasted.push(normalized);
        } catch (e) {
          toastErr("Paste failed", e);
        } finally {
          void FileSystem.deleteAsync(sourceUri, { idempotent: true }).catch(() => {});
          if (!normalized || normalized.uri !== uri) {
            void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
          }
        }
      }

      if (generation !== pasteGeneration.current) {
        for (const file of pasted) {
          void FileSystem.deleteAsync(file.uri, { idempotent: true }).catch(() => {});
        }
        return;
      }
      for (const file of addFiles(pasted)) {
        void FileSystem.deleteAsync(file.uri, { idempotent: true }).catch(() => {});
      }
    } finally {
      pasteReservations.current = Math.max(0, pasteReservations.current - reserved);
      setPasteOps((count) => Math.max(0, count - 1));
    }
  };

  const pickDocuments = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (res.canceled) return;
      addFiles(
        res.assets.map((a) => ({
          uri: a.uri,
          name: a.name ?? "file",
          type: a.mimeType ?? "application/octet-stream",
          size: a.size,
        })),
      );
    } catch (e) {
      toastErr("File pick failed", e);
    }
  };

  const pickPhotos = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"],
        allowsMultipleSelection: true,
        selectionLimit: MAX_FILES,
        quality: 0.9,
      });
      if (res.canceled) return;
      addFiles(await Promise.all(res.assets.map((asset) => asset.type === "video" ? {
        uri: asset.uri,
        name: asset.fileName ?? `video-${Date.now()}.${asset.mimeType === "video/quicktime" ? "mov" : asset.mimeType === "video/webm" ? "webm" : "mp4"}`,
        type: asset.mimeType ?? "video/mp4",
        size: asset.fileSize,
      } : toWebSafeImage(asset))));
    } catch (e) {
      toastErr("Photo pick failed", e);
    }
  };

  const takePhoto = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        toast("Camera access is needed to take photos", "warn");
        return;
      }
      const res = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.9 });
      if (res.canceled) return;
      addFiles(await Promise.all(res.assets.map(toWebSafeImage)));
    } catch (e) {
      toastErr("Camera failed", e);
    }
  };

  /* Insert a template at the caret rather than replacing the draft. The sheet
     blurs the input, so the last tracked selection is the insert point; RN
     needs a controlled `selection` to move the caret, released again on the
     next selection change so it never fights typing. */
  const insertTemplate = (template: string) => {
    // Clamp: the tracked selection can outlive the draft it was taken from
    // (a send clears the text without a selection change).
    const fallback = hasSelection.current ? selection.current : { start: text.length, end: text.length };
    const start = Math.min(fallback.start, text.length);
    const end = Math.min(Math.max(fallback.end, start), text.length);
    const next = text.slice(0, start) + template + text.slice(end);
    /* Count code points, like the server's chars().count(). */
    if ([...next].length > MAX_MESSAGE_CHARS) {
      Alert.alert(
        "Template is too long",
        `It would exceed the ${MAX_MESSAGE_CHARS.toLocaleString()}-character message limit.`,
      );
      return;
    }
    const caret = start + template.length;
    setText(next);
    selection.current = { start: caret, end: caret };
    setForcedSelection({ start: caret, end: caret });
    setTemplateSheet(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const send = async () => {
    if (pasteOps > 0) return;
    const sentText = text;
    const body = text.trim();
    if (!body && files.length === 0) return;
    const prefix = addressedAgents.map((a) => `@${slugify(a.name)}`).join(", ");
    try {
      await onSend({
        text: prefix ? (body ? `${prefix}, ${body}` : prefix) : body,
        files: files.map(toOutgoing),
        replyInThread: threadToggle ? replyInThread : undefined,
        requireAgent: showRequireAgent && requireAgentOn,
      });
      if (addressKey) {
        if ((useMessageDrafts.getState().byConvo[addressKey] ?? "") === sentText) {
          useMessageDrafts.getState().clear(addressKey);
        }
      } else {
        setLocalText((cur) => (cur === sentText ? "" : cur));
      }
      filesRef.current = [];
      setFiles([]);
      setReplyInThread(false);
    } catch (e) {
      toastErr("Send failed", e);
    }
  };

  if (recPhase !== "idle") {
    const secs = Math.floor((recState.durationMillis ?? 0) / 1000);
    const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    return (
      <View style={[styles.wrap, { paddingBottom: bottomPad }]}>
        <View style={styles.row}>
          <View style={styles.recDot} />
          <Text style={styles.recTime}>
            {recPhase === "uploading" ? "Transcribing…" : clock}
          </Text>
          <View style={{ flex: 1 }} />
          <Pressable onPress={cancelRec} disabled={recPhase === "uploading"} style={styles.recCancel}>
            <Text style={styles.recCancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={finishRec}
            disabled={recPhase === "uploading"}
            style={[styles.sendBtn, recPhase === "uploading" && styles.sendOff]}
          >
            {recPhase === "uploading" ? (
              <ActivityIndicator size="small" color={colors.onAccent} />
            ) : (
              <Icon icon={ArrowUp} size={20} color={colors.onAccent} strokeWidth={2.4} />
            )}
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, { paddingBottom: bottomPad }]}>
      {addressedAgents.length > 0 ? (
        <ScrollView horizontal keyboardShouldPersistTaps="always" style={styles.addrBar}>
          <Pressable style={styles.addrLabelBtn} onPress={() => setAddrSheet(true)} hitSlop={6}>
            <Text style={styles.addrLabel}>To</Text>
          </Pressable>
          {addressedAgents.map((a) => (
            <Pressable key={a.id} style={styles.addrChip} onPress={() => toggleAddressed(a.id)}>
              <AgentAvatar agentId={a.id} size={16} />
              <Text style={styles.addrChipText} numberOfLines={1}>
                {a.name}
              </Text>
              <Icon icon={X} size={11} />
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {focused && candidates.length > 0 ? (
        <ScrollView horizontal keyboardShouldPersistTaps="always" style={styles.mentionBar}>
          {candidates.map((c) => (
            <Pressable key={c.id} style={styles.mentionChip} onPress={() => insertMention(c)}>
              <Text style={styles.mentionText}>@{slugify(c.name)}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {files.length > 0 ? (
        <ScrollView horizontal style={styles.fileBar} keyboardShouldPersistTaps="always">
          {files.map((f, i) => {
            const image = NATIVE_IMAGE.test(f.type);
            return (
              <View key={`${f.uri}-${i}`} style={[styles.fileChip, image && styles.imageChip]}>
                {image ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Preview ${f.name}`}
                    onPress={() => setPreview(f)}
                  >
                    <Image source={{ uri: f.uri }} style={styles.fileThumb} contentFit="cover" />
                  </Pressable>
                ) : (
                  <View style={styles.fileIcon}><Icon icon={FileText} size={20} /></View>
                )}
                <View style={styles.fileMeta}>
                  <Text style={styles.fileText} numberOfLines={1}>{f.name}</Text>
                  {f.size != null ? <Text style={styles.fileSize}>{fmtSize(f.size)}</Text> : null}
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${f.name}`}
                  style={styles.fileRemove}
                  onPress={() => {
                    filesRef.current = filesRef.current.filter((_, j) => j !== i);
                    setFiles(filesRef.current);
                  }}
                >
                  <Icon icon={X} size={14} />
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
      ) : null}
      {preview ? (
        <ImagePreviewModal
          source={{ uri: preview.uri }}
          filename={preview.name}
          onClose={() => setPreview(null)}
        />
      ) : null}
      {/* Slack-style: collapsed = one pill row (+ | input | 🎤); focused =
          full-width input with a toolbar row underneath. The TextInput keeps
          a stable key so refocusing/layout swaps never remount it (which
          would drop the keyboard). */}
      <View style={focused ? styles.colFocused : styles.row}>
        {!focused ? (
          <Pressable onPress={() => setAttachSheet(true)} hitSlop={8} style={styles.plusBtn}>
            <Text style={styles.plusText}>+</Text>
          </Pressable>
        ) : null}
        <PasteAwareInput
          enabled={nativePasteInput}
          style={focused ? styles.pasteWrapFocused : styles.pasteWrap}
          onPaste={(payload) => void onNativePaste(payload)}
        >
          <TextInput
            key="composer-input"
            ref={inputRef}
            style={[
              focused ? styles.inputFocused : styles.input,
              nativePasteInput && !focused ? styles.inputWrapped : null,
              { height: inputHeight },
            ]}
            value={text}
            onChangeText={setText}
            onContentSizeChange={(e) => {
              setInputHeight(Math.max(COMPOSER_INPUT_MIN_HEIGHT, e.nativeEvent.contentSize.height));
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onSelectionChange={(e) => {
              selection.current = e.nativeEvent.selection;
              hasSelection.current = true;
              if (forcedSelection) setForcedSelection(undefined);
            }}
            selection={forcedSelection}
            placeholder={placeholder}
            placeholderTextColor={colors.faint}
            multiline
            maxLength={MAX_MESSAGE_CHARS}
          />
        </PasteAwareInput>
        {/* Collapsed with a draft pending (e.g. after the picker stole focus):
            swap the mic for a send button so the draft isn't stranded. */}
        {!focused && (text.trim() || files.length > 0) ? (
          <Pressable
            onPress={send}
            disabled={sending || pasteOps > 0}
            accessibilityRole="button"
            accessibilityLabel={pasteOps > 0 ? "Processing pasted image" : "Send message"}
            style={[styles.sendBtn, (sending || pasteOps > 0) && styles.sendOff]}
          >
            {sending || pasteOps > 0 ? (
              <ActivityIndicator size="small" color={colors.onAccent} />
            ) : (
              <Icon icon={ArrowUp} size={20} color={colors.onAccent} strokeWidth={2.4} />
            )}
          </Pressable>
        ) : !focused && onSendVoice ? (
          <Pressable onPress={startRec} hitSlop={8} style={styles.iconBtn}>
            <Icon icon={Mic} size={22} />
          </Pressable>
        ) : null}
      </View>
      {focused ? (
        <View style={styles.toolbar}>
          <Pressable onPress={() => setAttachSheet(true)} hitSlop={8} style={styles.plusBtn}>
            <Text style={styles.plusText}>+</Text>
          </Pressable>
          {agents.length > 0 && addressKey ? (
            <Pressable onPress={() => setAddrSheet(true)} hitSlop={8} style={styles.toolBtn}>
              <View style={styles.addrBtn}>
                <View style={addressedAgents.length === 0 && styles.addrIdle}>
                  <Icon icon={Bot} size={22} color={addressedAgents.length > 0 ? colors.a1 : colors.dim} />
                </View>
                {addressedAgents.length > 0 ? (
                  <View style={styles.addrBadge}>
                    <Text style={styles.addrBadgeText}>{addressedAgents.length}</Text>
                  </View>
                ) : null}
              </View>
            </Pressable>
          ) : null}
          <Pressable onPress={pickPhotos} hitSlop={8} style={styles.toolBtn}>
            <Icon icon={ImageIcon} size={22} />
          </Pressable>
          {onSendVoice ? (
            <Pressable onPress={startRec} hitSlop={8} style={styles.toolBtn}>
              <Icon icon={Mic} size={22} />
            </Pressable>
          ) : null}
          {groupId ? (
            <Pressable onPress={() => setTemplateSheet(true)} hitSlop={8} style={styles.toolBtn} accessibilityRole="button" accessibilityLabel="Message templates">
              <Icon icon={NotepadText} size={22} />
            </Pressable>
          ) : null}
          {showRequireAgent && addressKey ? (
            <Pressable
              onPress={() => toggleRequireAgent(addressKey)}
              hitSlop={8}
              style={styles.toolBtn}
              accessibilityRole="button"
              accessibilityState={{ selected: requireAgentOn }}
              accessibilityLabel={
                requireAgentOn
                  ? "Agents only act when tagged"
                  : "Agents can reply without an @mention"
              }
            >
              <Icon
                icon={AtSign}
                size={22}
                color={requireAgentOn ? colors.a1 : colors.dim}
              />
            </Pressable>
          ) : null}
          <View style={{ flex: 1 }} />
          {threadToggle ? (
            <Pressable
              onPress={() => setReplyInThread((v) => !v)}
              hitSlop={8}
              style={styles.toolBtn}
              accessibilityLabel="Agents answer this message in a thread under it"
            >
              <Icon
                icon={MessageSquareReply}
                size={22}
                color={replyInThread ? colors.a1 : colors.dim}
              />
            </Pressable>
          ) : null}
          <Pressable
            onPress={send}
            disabled={sending || pasteOps > 0 || (!text.trim() && files.length === 0)}
            accessibilityRole="button"
            accessibilityLabel={pasteOps > 0 ? "Processing pasted image" : "Send message"}
            style={[
              styles.sendBtn,
              (sending || pasteOps > 0 || (!text.trim() && files.length === 0)) && styles.sendOff,
            ]}
          >
            {sending || pasteOps > 0 ? (
              <ActivityIndicator size="small" color={colors.onAccent} />
            ) : (
              <Icon icon={ArrowUp} size={20} color={colors.onAccent} strokeWidth={2.4} />
            )}
          </Pressable>
        </View>
      ) : null}
      {addrSheet ? (
        <Modal transparent animationType="fade" onRequestClose={() => setAddrSheet(false)}>
          <Pressable style={styles.sheetBackdrop} onPress={() => setAddrSheet(false)}>
            <Pressable style={styles.sheet} onPress={() => {}}>
              <View style={styles.addrHead}>
                <Text style={styles.addrTitle}>Talk to</Text>
                {addressed.length > 0 && addressKey ? (
                  <Pressable onPress={() => clearAddr(addressKey)} hitSlop={8}>
                    <Text style={styles.addrClear}>Clear</Text>
                  </Pressable>
                ) : null}
              </View>
              <ScrollView style={styles.addrList}>
                {agents.map((a) => {
                  const on = addressed.includes(a.id);
                  return (
                    <Pressable key={a.id} style={styles.addrRow} onPress={() => toggleAddressed(a.id)}>
                      <AgentAvatar agentId={a.id} size={28} />
                      <Text style={styles.addrRowName} numberOfLines={1}>
                        {a.name}
                      </Text>
                      <View style={[styles.addrCheck, on && styles.addrCheckOn]}>
                        {on ? <Icon icon={Check} size={14} color={colors.onAccent} strokeWidth={2.6} /> : null}
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>
              <Pressable style={styles.addrDone} onPress={() => setAddrSheet(false)}>
                <Text style={styles.addrDoneText}>Done</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
      {/* Outside the `focused` block on purpose: opening the sheet blurs the
          input, which collapses the toolbar the button lives in. */}
      {groupId ? (
        <TemplateSheet
          groupId={groupId}
          visible={templateSheet}
          draft={text}
          onClose={() => {
            setTemplateSheet(false);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          onChoose={insertTemplate}
        />
      ) : null}
      <Modal
        transparent
        visible={attachSheet}
        animationType="fade"
        onRequestClose={() => closeSheet()}
        onDismiss={onSheetDismissed}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => closeSheet()}>
          <View style={styles.sheet}>
            <Pressable style={styles.sheetBtn} onPress={() => closeSheet(() => void pickPhotos())}>
              <Icon icon={ImageIcon} size={19} color={colors.text} />
              <Text style={styles.sheetText}>Photo library</Text>
            </Pressable>
            <Pressable style={styles.sheetBtn} onPress={() => closeSheet(() => void takePhoto())}>
              <Icon icon={Camera} size={19} color={colors.text} />
              <Text style={styles.sheetText}>Camera</Text>
            </Pressable>
            <Pressable style={styles.sheetBtn} onPress={() => closeSheet(() => void pickDocuments())}>
              <Icon icon={Paperclip} size={19} color={colors.text} />
              <Text style={styles.sheetText}>Document</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  addrBar: { paddingHorizontal: 12, paddingTop: 8 },
  addrLabelBtn: { alignSelf: "center", marginRight: 8 },
  addrLabel: {
    color: colors.faint,
    fontSize: 10.5,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  addrChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(139,124,255,0.12)",
    borderWidth: 1,
    borderColor: "rgba(139,124,255,0.35)",
    borderRadius: 999,
    paddingVertical: 3,
    paddingLeft: 4,
    paddingRight: 8,
    marginRight: 6,
    maxWidth: 180,
  },
  addrChipText: { color: "#cfc8ff", fontSize: 12.5, fontWeight: "600", flexShrink: 1 },
  addrBtn: { flexDirection: "row", alignItems: "flex-start" },
  addrIdle: { opacity: 0.6 },
  addrBadge: {
    minWidth: 15,
    height: 15,
    borderRadius: 999,
    paddingHorizontal: 4,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -3,
    marginTop: -3,
  },
  addrBadgeText: { color: colors.onAccent, fontSize: 9.5, fontWeight: "800" },
  addrHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  addrTitle: { color: colors.text, fontSize: 16, fontWeight: "800" },
  addrClear: { color: colors.dim, fontSize: 13, fontWeight: "600" },
  addrList: { maxHeight: 320 },
  addrRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  addrRowName: { color: colors.text, fontSize: 15, fontWeight: "600", flex: 1 },
  addrCheck: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  addrCheckOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  addrDone: {
    marginTop: 12,
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: "center",
  },
  addrDoneText: { color: colors.onAccent, fontSize: 15, fontWeight: "800" },
  mentionBar: { paddingHorizontal: 12, paddingTop: 8 },
  mentionChip: {
    backgroundColor: "rgba(139,124,255,0.15)",
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 10,
    marginRight: 6,
  },
  mentionText: { color: colors.a1, fontSize: 13, fontWeight: "600" },
  fileBar: { paddingHorizontal: 12, paddingTop: 8 },
  fileChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.panelStrong,
    borderRadius: 10,
    minHeight: 58,
    padding: 7,
    marginRight: 6,
    width: 220,
  },
  imageChip: { padding: 4 },
  fileThumb: { width: 72, height: 54, borderRadius: 7, backgroundColor: colors.panel },
  fileIcon: {
    width: 40, height: 42, borderRadius: 7, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(139,124,255,0.15)",
  },
  fileMeta: { flex: 1, minWidth: 0 },
  fileText: { color: colors.text, fontSize: 12.5, fontWeight: "600" },
  fileSize: { marginTop: 2, color: colors.faint, fontSize: 10.5 },
  fileRemove: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "flex-end", padding: 10, gap: 8 },
  colFocused: { paddingHorizontal: 12, paddingTop: 8 },
  pasteWrap: { flex: 1 },
  pasteWrapFocused: { alignSelf: "stretch" },
  iconBtn: { paddingBottom: 9 },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    maxHeight: 130,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 9,
  },
  /* The native paste wrapper owns horizontal flex. Let the inner
     multiline input contribute intrinsic height instead of nesting flex: 1
     inside an auto-height wrapper. */
  inputWrapped: { flex: 0 },
  /* Focused: the input sheds its pill and spans the full width; the actions
     move into the toolbar row below (Slack's expanded composer). */
  inputFocused: {
    color: colors.text,
    fontSize: 15.5,
    minHeight: 40,
    maxHeight: 150,
    paddingHorizontal: 4,
    paddingTop: 6,
    paddingBottom: 6,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 12,
    paddingTop: 2,
    paddingBottom: 8,
  },
  toolBtn: { padding: 2 },
  plusBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.panelStrong,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-end",
    marginBottom: 2,
  },
  plusText: { color: colors.dim, fontSize: 20, fontWeight: "600", lineHeight: 24 },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.sheet,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 16,
    gap: 4,
    paddingBottom: 34,
  },
  sheetBtn: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 13 },
  sheetText: { color: colors.text, fontSize: 15.5 },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  sendOff: { opacity: 0.4 },
  recDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.red,
    alignSelf: "center",
    marginLeft: 4,
  },
  recTime: {
    color: colors.text,
    fontSize: 15,
    fontVariant: ["tabular-nums"],
    alignSelf: "center",
    marginLeft: 8,
  },
  recCancel: { alignSelf: "center", paddingHorizontal: 12, paddingVertical: 8 },
  recCancelText: { color: colors.dim, fontSize: 14.5, fontWeight: "600" },
});
