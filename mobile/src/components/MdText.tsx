import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { normalizeEChart, parseMd, type NormalizedEChart, type Span } from "@agora/core";
import { openLink } from "../lib/openLink";
import { colors, mono } from "../lib/theme";
import { MermaidBlock } from "./Mermaid";
import { ChartModal, EChartBlock } from "./EChart";

function SpanText({ span }: { span: Span }) {
  switch (span.kind) {
    case "bold":
      return <Text style={styles.bold}>{span.text}</Text>;
    case "italic":
      return <Text style={styles.italic}>{span.text}</Text>;
    case "code":
      return <Text style={styles.code}>{span.text}</Text>;
    case "link":
      return (
        <Text style={styles.link} onPress={() => void openLink(span.url)} suppressHighlighting={false}>
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

/* ---------------------------------------------------------- table columns
   RN has no table layout: each row is an independent flex row, so cells that
   size to their own content drift out of column alignment row by row. Fix
   the width of every column up front, estimated from the content it holds:

   - a column is sized to fit its widest *typical* value (and its header),
   - a rare outlier — a value far wider than the column's 75th percentile —
     does not drag the whole column wide; it wraps inside the column and the
     row grows taller instead,
   - everything is clamped to [MIN_COL, MAX_COL] so degenerate content can't
     produce absurd columns. */

const MIN_COL = 80;
const MAX_COL = 260;
const CELL_HPAD = 20; // styles.cell paddingHorizontal * 2
const CHAR_W = 8; // ~average glyph width of the system font at fontSize 13.5

function estimateWidth(spans: Span[]): number {
  const chars = spans.reduce((n, s) => n + s.text.length, 0);
  return chars * CHAR_W + CELL_HPAD;
}

export function columnWidths(head: Span[][], rows: Span[][][]): number[] {
  const cols = Math.max(head.length, ...rows.map((r) => r.length), 0);
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    const ests = rows
      .map((r) => (r[c] ? estimateWidth(r[c]) : 0))
      .filter((w) => w > 0)
      .sort((a, b) => a - b);
    const headerEst = head[c] ? estimateWidth(head[c]) : 0;
    const p75 = ests.length ? ests[Math.max(0, Math.ceil(ests.length * 0.75) - 1)] : 0;
    // Widest value that still counts as typical; anything beyond wraps.
    const typicalMax = Math.min(ests.length ? ests[ests.length - 1] : 0, p75 * 1.5);
    // Headers get full weight — a wrapped header reads worse than a slightly
    // wide column of short values.
    const target = Math.max(typicalMax, headerEst, MIN_COL);
    widths.push(Math.ceil(Math.min(target, MAX_COL)));
  }
  return widths;
}

export function MdText({ text, onLongPress }: { text: string; onLongPress?: () => void }) {
  const blocks = React.useMemo(() => {
    let validIndex = 0;
    return parseMd(text).map((block, blockIndex) => {
      if (block.kind !== "codeblock" || block.lang !== "echarts") return { block, key: `${block.kind}-${blockIndex}` };
      try {
        const chart = normalizeEChart(block.text);
        return { block, key: `chart-${blockIndex}-${chart.title}`, chart, error: "", validIndex: validIndex++ };
      } catch (error) {
        return { block, key: `chart-${blockIndex}-invalid`, chart: null as NormalizedEChart | null, error: (error as Error).message, validIndex: -1 };
      }
    });
  }, [text]);
  const validCharts = blocks.filter((entry): entry is typeof entry & { chart: NormalizedEChart; validIndex: number } => "chart" in entry && entry.chart !== null);
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
  return (
    <View
      style={styles.root}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {blocks.map((entry, i) => {
        const b = entry.block;
        switch (b.kind) {
          case "codeblock":
            if (b.lang === "mermaid") {
              return <MermaidBlock key={i} code={b.text} maxWidth={width} />;
            }
            if (b.lang === "echarts") {
              return <EChartBlock key={entry.key} code={b.text} chart={"chart" in entry ? entry.chart ?? null : null}
                error={"error" in entry ? entry.error : ""} maxWidth={width}
                onExpand={typeof entry.validIndex === "number" && entry.validIndex >= 0 ? () => setActiveChart(entry.validIndex!) : undefined} />;
            }
            return (
              <ScrollView
                key={i}
                horizontal
                showsHorizontalScrollIndicator
                style={[styles.pre, width ? { maxWidth: width } : null]}
              >
                <Text style={styles.preText}>{b.text}</Text>
              </ScrollView>
            );
          case "heading":
            return (
              <Text key={i} style={[styles.para, styles.bold]} onLongPress={onLongPress}>
                <Spans spans={b.spans} />
              </Text>
            );
          case "table": {
            const cols = columnWidths(b.head, b.rows);
            return (
              <ScrollView
                key={i}
                horizontal
                nestedScrollEnabled
                showsHorizontalScrollIndicator
                style={[styles.tableWrap, width ? { maxWidth: width } : null]}
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
            return (
              <Text key={i} style={styles.para} selectable onLongPress={onLongPress}>
                <Spans spans={b.spans} />
              </Text>
            );
        }
      })}
      {activeChart !== null && validCharts[activeChart] ? (
        <ChartModal key={validCharts[activeChart].key} chart={validCharts[activeChart].chart}
          index={activeChart} total={validCharts.length}
          onPrevious={() => setActiveChart(current => current === null ? null : Math.max(0, current - 1))}
          onNext={() => setActiveChart(current => current === null ? null : Math.min(validCharts.length - 1, current + 1))}
          onClose={() => setActiveChart(null)} />
      ) : null}
    </View>
  );
}

function alignStyle(a: "" | "left" | "center" | "right") {
  return a ? { textAlign: a as "left" | "center" | "right" } : null;
}

const styles = StyleSheet.create({
  root: { gap: 6 },
  para: { color: colors.text, fontSize: 15, lineHeight: 21 },
  bold: { fontWeight: "700", color: colors.text },
  italic: { fontStyle: "italic" },
  code: {
    ...mono,
    fontSize: 13,
    color: colors.a2,
    backgroundColor: colors.panelStrong,
  },
  link: { color: colors.a2, fontWeight: "500", textDecorationLine: "underline" },
  mention: {
    color: "#b3a8ff",
    fontWeight: "600",
    backgroundColor: "rgba(139,124,255,0.18)",
  },
  pre: {
    backgroundColor: colors.panelStrong,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  preText: { ...mono, fontSize: 13, color: colors.text, padding: 10 },
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
    fontSize: 13.5,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
});
