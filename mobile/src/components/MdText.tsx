import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Copy } from "lucide-react-native";
import { mdliteClipboardHtml, normalizeEChart, parseMd, type Block, type NormalizedEChart, type Span } from "@agora/core";
import { openLink } from "../lib/openLink";
import { mono, typography, weight } from "../lib/theme";
import { createThemedStyles, useAppTheme } from "../lib/useTheme";
import { columnWidths } from "../lib/tableLayout";
import { MermaidBlock } from "./Mermaid";
import { ChartModal, EChartBlock } from "./EChart";
import { Icon } from "./Icon";
import { toast, toastErr } from "./Toast";

function SpanText({ span }: { span: Span }) {
  const styles = useStyles();
  switch (span.kind) {
    case "bold":
      return <Text style={styles.bold}>{span.text}</Text>;
    case "italic":
      return <Text style={styles.italic}>{span.text}</Text>;
    case "code":
      return <Text style={styles.code}>{span.text}</Text>;
    case "link":
      return (
        <Text style={styles.link} onPress={(event) => {
          event.stopPropagation();
          void openLink(span.url);
        }} suppressHighlighting={false}>
          {span.text}
        </Text>
      );
    case "mention":
      return <Text style={styles.mention}>{span.text}</Text>;
    default:
      return <Text>{span.text}</Text>;
  }
}

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) => (
        <SpanText key={i} span={s} />
      ))}
    </>
  );
}

export { columnWidths } from "../lib/tableLayout";

export function MdText({ text, onLongPress, onPress, onPressIn }: {
  text: string;
  onLongPress?: () => void;
  onPress?: () => void;
  onPressIn?: () => void;
}) {
  const styles = useStyles();
  // Charts can sit inside list items too, so number them in document order
  // across the whole tree; the modal pages through them in that order.
  // Quoted fences stay source, matching web.
  const { blocks, charts } = React.useMemo(() => {
    const parsed = parseMd(text);
    const found = new Map<Block, ChartEntry>();
    let validIndex = 0;
    const walk = (list: Block[], inQuote: boolean) => {
      for (const block of list) {
        if (block.kind === "quote") walk(block.blocks, true);
        else if (block.kind === "list") block.items.forEach(item => walk(item, inQuote));
        else if (block.kind === "codeblock" && block.lang === "echarts" && !inQuote) {
          try {
            const chart = normalizeEChart(block.text);
            found.set(block, { key: `chart-${found.size}-${chart.title}`, chart, error: "", validIndex: validIndex++ });
          } catch (error) {
            found.set(block, { key: `chart-${found.size}-invalid`, chart: null, error: (error as Error).message, validIndex: -1 });
          }
        }
      }
    };
    walk(parsed, false);
    return { blocks: parsed, charts: found };
  }, [text]);
  const validCharts = [...charts.values()].filter((entry): entry is ChartEntry & { chart: NormalizedEChart } => entry.chart !== null);
  const [activeChart, setActiveChart] = React.useState<number | null>(null);
  React.useEffect(() => setActiveChart(null), [text]);
  React.useEffect(() => {
    if (activeChart !== null && activeChart >= validCharts.length) setActiveChart(null);
  }, [activeChart, validCharts.length]);
  // A horizontal ScrollView only scrolls when its own frame is narrower than
  // its content. Inside a shrink-to-fit bubble nothing hands it a definite
  // width, so it grows to content width and the bubble just clips it. Measure
  // the width the bubble actually gives this block (align-items:stretch makes
  // it the bubble's inner width) and cap the table to that — then a wide table
  // overflows the frame and scrolls. Undefined until first layout.
  const [width, setWidth] = React.useState<number>();
  const para = (spans: Span[], key: React.Key, bold = false) => (
    <Text key={key} style={bold ? [styles.para, styles.bold] : styles.para} selectable={!bold}
      onPress={onPress} onPressIn={onPressIn} onLongPress={onLongPress}>
      <Spans spans={spans} />
    </Text>
  );
  // Quotes and list items re-render their children at a narrower cap, so a
  // nested code block or table still gets a definite width to scroll in.
  const renderBlock = (b: Block, key: React.Key, maxWidth: number | undefined, listDepth: number): React.ReactNode => {
    switch (b.kind) {
      case "codeblock": {
        if (b.lang === "mermaid") return <MermaidBlock key={key} code={b.text} maxWidth={maxWidth} />;
        const entry = charts.get(b);
        if (entry) {
          return <EChartBlock key={entry.key} code={b.text} chart={entry.chart} error={entry.error} maxWidth={maxWidth}
            onExpand={entry.validIndex >= 0 ? () => setActiveChart(entry.validIndex) : undefined} />;
        }
        // Quoted chart source shows as code without its own copy button, as on web.
        return <CodeBlock key={key} code={b.text} maxWidth={maxWidth} copyable={b.lang !== "echarts"} />;
      }
      case "heading":
        return para(b.spans, key, true);
      case "quote":
        return (
          // Not a Pressable (a responder here would fight the horizontal scroll
          // of quoted code and tables); box-none lets touches on the padding
          // fall through to the bubble's press backdrop instead.
          <View key={key} style={styles.quote} pointerEvents="box-none">
            {b.blocks.map((child, i) => renderBlock(child, i, inset(maxWidth, QUOTE_INSET), listDepth))}
            <CopyButton label="Copy quote" style={styles.copyCorner}
              copy={() => Clipboard.setStringAsync(mdliteClipboardHtml(b.source), { inputFormat: Clipboard.StringFormat.HTML })} />
          </View>
        );
      case "list": {
        const markerWidth = listMarkerWidth(b);
        return (
          <View key={key} style={styles.list} pointerEvents="box-none">
            {b.items.map((item, i) => (
              <View key={i} style={styles.li} pointerEvents="box-none">
                <Text style={[styles.marker, { minWidth: markerWidth }]}
                  onPress={onPress} onPressIn={onPressIn} onLongPress={onLongPress}>
                  {b.ordered ? `${b.start + i}.` : listDepth % 2 ? "◦" : "•"}
                </Text>
                <View style={styles.liBody} pointerEvents="box-none">
                  {item.map((child, j) => renderBlock(child, j, inset(maxWidth, markerWidth), listDepth + 1))}
                </View>
              </View>
            ))}
          </View>
        );
      }
      case "table": {
        const cols = columnWidths(b.head, b.rows);
        return (
          <ScrollView
            key={key}
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator
            style={[styles.tableWrap, maxWidth ? { maxWidth } : null]}
          >
            <View>
              <View style={[styles.tr, styles.thead]}>
                {b.head.map((cell, c) => (
                  <Text
                    key={c}
                    style={[styles.cell, styles.bold, { width: cols[c] }, alignStyle(b.aligns[c])]}
                  >
                    <Spans spans={cell} />
                  </Text>
                ))}
              </View>
              {b.rows.map((row, r) => (
                <View key={r} style={styles.tr}>
                  {row.map((cell, c) => (
                    <Text
                      key={c}
                      style={[styles.cell, { width: cols[c] }, alignStyle(b.aligns[c])]}
                    >
                      <Spans spans={cell} />
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        );
      }
      default:
        return para(b.spans, key);
    }
  };
  return (
    <View
      style={styles.root}
      // box-none down the whole container chain (root, quote, list, item):
      // a touch on padding or a gap falls through to the bubble's press
      // backdrop, a sibling of this root, instead of dying here.
      pointerEvents="box-none"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {blocks.map((block, i) => renderBlock(block, i, width, 0))}
      {activeChart !== null && validCharts[activeChart] ? (
        <ChartModal chart={validCharts[activeChart].chart}
          index={activeChart} total={validCharts.length}
          onPrevious={() => setActiveChart(current => current === null ? null : Math.max(0, current - 1))}
          onNext={() => setActiveChart(current => current === null ? null : Math.min(validCharts.length - 1, current + 1))}
          onClose={() => setActiveChart(null)} />
      ) : null}
    </View>
  );
}

type ChartEntry = { key: string; chart: NormalizedEChart | null; error: string; validIndex: number };

// Horizontal space a quote takes from its children: border + left padding +
// the right padding that keeps text clear of its copy button.
const QUOTE_INSET = 3 + 10 + 34;

/** Marker column for a list: wide enough for its longest ordinal ("10.", "100."). */
function listMarkerWidth(list: Extract<Block, { kind: "list" }>): number {
  if (!list.ordered) return 20;
  const digits = String(list.start + list.items.length - 1).length;
  return 14 + digits * 9;
}

function inset(width: number | undefined, by: number) {
  // Floor above 0: callers treat 0 as "no cap", which would let a deeply
  // nested block overflow the bubble instead of scrolling.
  return width === undefined ? undefined : Math.max(40, width - by);
}

function CopyButton({ label, copy, style }: { label: string; copy: () => Promise<unknown>; style?: object }) {
  const styles = useStyles();
  const { colors } = useAppTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={10}
      style={({ pressed }) => [styles.copy, style, pressed ? styles.copyPressed : null]}
      onPress={async (event) => {
        event.stopPropagation();
        try {
          if ((await copy()) === false) throw new Error("The clipboard didn't accept the text");
          toast("Copied.");
        }
        catch (error) { toastErr("Copy failed", error); }
      }}>
      <Icon icon={Copy} size={13} color={colors.dim} />
    </Pressable>
  );
}

/** A horizontally scrolling code block with a small copy button pinned over
    its top-right corner. The scroll content ends with enough padding that
    the last characters of the longest line can scroll clear of the button. */
function CodeBlock({ code, maxWidth, copyable = true }: { code: string; maxWidth?: number; copyable?: boolean }) {
  const styles = useStyles();
  return (
    <View style={[styles.codeWrap, maxWidth ? { maxWidth } : null]}>
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator
        style={[styles.pre, maxWidth ? { maxWidth } : null]}
        contentContainerStyle={copyable ? styles.preContent : null}
      >
        <Text style={styles.preText}>{code}</Text>
      </ScrollView>
      {copyable ? <CopyButton label="Copy code" style={styles.copyCorner} copy={() => Clipboard.setStringAsync(code)} /> : null}
    </View>
  );
}

function alignStyle(a: "" | "left" | "center" | "right") {
  return a ? { textAlign: a as "left" | "center" | "right" } : null;
}

const useStyles = createThemedStyles(({ colors }) => ({
  root: { gap: 6 },
  para: { color: colors.text, ...typography.message },
  bold: { fontWeight: weight.bold, color: colors.text },
  italic: { fontStyle: "italic" },
  code: {
    ...mono,
    fontSize: typography.meta.fontSize,
    color: colors.a2,
    backgroundColor: colors.panelStrong,
  },
  link: { color: colors.a2, fontWeight: weight.medium, textDecorationLine: "underline" },
  mention: {
    color: colors.accentText,
    fontWeight: weight.semibold,
    backgroundColor: colors.accentSoft,
  },
  pre: {
    backgroundColor: colors.panelStrong,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  preText: { ...mono, fontSize: typography.meta.fontSize, color: colors.text, padding: 10 },
  // 24px button + 4px inset + a little air.
  preContent: { paddingRight: 30 },
  codeWrap: { position: "relative" },
  copy: {
    width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center",
    backgroundColor: colors.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    opacity: 0.9,
  },
  copyPressed: { opacity: 0.5 },
  copyCorner: { position: "absolute", top: 4, right: 4 },
  quote: {
    gap: 6,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    backgroundColor: colors.panelStrong,
    borderTopRightRadius: 8,
    borderBottomRightRadius: 8,
    paddingVertical: 8,
    paddingLeft: 10,
    // Keeps the first line of text clear of the copy button.
    paddingRight: QUOTE_INSET - 3 - 10,
  },
  list: { gap: 4 },
  li: { flexDirection: "row" },
  // minWidth, not width: at large OS font scales the ordinal grows the column.
  marker: { color: colors.dim, paddingRight: 4, ...typography.message },
  liBody: { flex: 1, gap: 4 },
  tableWrap: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    borderRadius: 8,
    // flex-start so a wide table fills the measured cap (see maxWidth applied
    // inline) instead of stretching to whatever the text above happens to be.
    alignSelf: "flex-start",
  },
  thead: { backgroundColor: colors.panelStrong },
  tr: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  // Width is fixed per column (see columnWidths) so rows stay aligned; a
  // value wider than its column wraps, growing the row.
  cell: {
    color: colors.text,
    fontSize: typography.bodySm.fontSize,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
}));
