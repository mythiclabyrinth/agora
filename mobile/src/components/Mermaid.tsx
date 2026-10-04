/* ```mermaid fences. Mermaid needs a JS/DOM runtime, so the bubble shows a
   compact card (diagram label + the first lines of the graph) and tapping
   renders it in a full-screen WebView whose shell loads the library from a
   CDN. Offline, or when the graph doesn't parse, the shell reports the
   error above the source instead of a blank page — the code is never lost. */

import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { GitBranch, X } from "lucide-react-native";
import { WebView } from "react-native-webview";
import { mono, themes, type AppTheme } from "../lib/theme";
import { createThemedStyles, useAppTheme } from "../lib/useTheme";
import { Icon } from "./Icon";

const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";

export function mermaidHtml(code: string, theme: AppTheme = themes.dark): string {
  const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
<style>
  body { margin: 0; background: ${theme.colors.bg}; min-height: 100vh;
         display: flex; align-items: center; justify-content: center; }
  #out svg { max-width: 100vw; height: auto; }
  #err { color: ${theme.colors.red}; font: 12px ui-monospace, monospace;
         padding: 16px; white-space: pre-wrap; overflow-wrap: anywhere; }
</style></head><body>
<pre id="src" style="display:none">${escaped}</pre><div id="out"></div>
<script src="${MERMAID_CDN}"></script>
<script>
(async () => {
  const src = document.getElementById("src").textContent;
  const out = document.getElementById("out");
  try {
    if (!window.mermaid) throw new Error("Could not load the diagram renderer (offline?)");
    mermaid.initialize({ startOnLoad: false, theme: "${theme.mode === "dark" ? "dark" : "default"}", securityLevel: "strict" });
    const { svg } = await mermaid.render("g1", src);
    out.innerHTML = svg;
  } catch (e) {
    const err = document.createElement("div");
    err.id = "err";
    err.textContent = String((e && e.message) || e) + "\\n\\n" + src;
    out.replaceChildren(err);
  }
})();
</script></body></html>`;
}

export function MermaidBlock({ code, maxWidth }: { code: string; maxWidth?: number }) {
  const theme = useAppTheme();
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Pressable
        style={[styles.card, maxWidth ? { maxWidth } : null]}
        onPress={() => setOpen(true)}
      >
        <View style={styles.head}>
          <Icon icon={GitBranch} size={13} color={colors.a2} />
          <Text style={styles.label}>Mermaid diagram</Text>
          <Text style={styles.view}>view</Text>
        </View>
        <Text style={styles.preview} numberOfLines={3}>
          {code}
        </Text>
      </Pressable>
      {open ? (
        <Modal animationType="slide" onRequestClose={() => setOpen(false)}>
          <View style={styles.modal}>
            <View style={styles.modalHead}>
              <Icon icon={GitBranch} size={15} color={colors.a2} />
              <Text style={styles.modalTitle}>Mermaid diagram</Text>
              <Pressable onPress={() => setOpen(false)} hitSlop={10}>
                <Icon icon={X} size={20} color={colors.dim} />
              </Pressable>
            </View>
            <WebView
              originWhitelist={["*"]}
              source={{ html: mermaidHtml(code, theme) }}
              style={styles.web}
              containerStyle={styles.web}
            />
          </View>
        </Modal>
      ) : null}
    </>
  );
}

const useStyles = createThemedStyles(({ colors }) => ({
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.panelStrong,
    padding: 10,
    gap: 6,
    alignSelf: "flex-start",
  },
  head: { flexDirection: "row", alignItems: "center", gap: 6 },
  label: { color: colors.text, fontSize: 12, fontWeight: "700", flex: 1 },
  view: { color: colors.a2, fontSize: 11.5, fontWeight: "600" },
  preview: { ...mono, color: colors.faint, fontSize: 11, lineHeight: 15 },
  modal: { flex: 1, backgroundColor: colors.bg, paddingTop: 54 },
  modalHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  modalTitle: { color: colors.text, fontSize: 14, fontWeight: "700", flex: 1 },
  web: { flex: 1, backgroundColor: colors.bg },
}));
