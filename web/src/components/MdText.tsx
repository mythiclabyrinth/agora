/* Message prose: mdliteHtml + @mention decoration. Mermaid marker divs render
   lazily after paint; ECharts fences become stable direct React children. */

import { useEffect, useMemo, useState } from "react";
import { mdliteHtml, normalizeEChart, type NormalizedEChart } from "@agora/core";
import { decorateMentions, type MentionIndex } from "../lib/mentions";
import { renderMermaid } from "../lib/mermaid";
import { ChartModal, EChartBlock } from "./EChartBlock";

type MdPart = { kind: "html"; text: string } | { kind: "echarts"; source: string };

function splitECharts(text: string): MdPart[] {
  const parts: MdPart[] = [];
  // Keep this fence grammar aligned with mdliteHtml. Non-ECharts fences remain
  // inside their prose segment so the shared renderer handles them normally.
  const fences = /```(\w*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of text.matchAll(fences)) {
    if (match[1].toLowerCase() !== "echarts") continue;
    if (match.index > cursor) parts.push({ kind: "html", text: text.slice(cursor, match.index) });
    parts.push({ kind: "echarts", source: match[2].replace(/\n$/, "") });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ kind: "html", text: text.slice(cursor) });
  return parts.length ? parts : [{ kind: "html", text }];
}

export function MdText({ text, mentions }: { text: string; mentions?: MentionIndex }) {
  const parts = useMemo(() => {
    let validIndex = 0;
    return splitECharts(text).map((part, partIndex) => {
      if (part.kind === "html") return {
        ...part,
        key: `html-${partIndex}-${part.text.slice(0, 24)}`,
        html: mentions ? decorateMentions(mdliteHtml(part.text), mentions) : mdliteHtml(part.text),
      };
      try {
        const chart = normalizeEChart(part.source);
        return { ...part, key: `chart-${partIndex}-${chart.title}`, chart, error: "", validIndex: validIndex++ };
      } catch (error) {
        return { ...part, key: `chart-${partIndex}-invalid`, chart: null as NormalizedEChart | null, error: (error as Error).message, validIndex: -1 };
      }
    });
  }, [text, mentions]);
  const validCharts = parts.filter((part): part is Extract<typeof part, { kind: "echarts" }> & { chart: NormalizedEChart } => part.kind === "echarts" && part.chart !== null);
  const [activeChart, setActiveChart] = useState<number | null>(null);
  useEffect(() => setActiveChart(null), [text]);
  useEffect(() => {
    if (activeChart !== null && activeChart >= validCharts.length) setActiveChart(null);
  }, [activeChart, validCharts.length]);
  const mermaidHtml = parts.flatMap(part => part.kind === "html" ? [part.html] : []).join("");
  useEffect(() => {
    if (mermaidHtml.includes("md-mermaid")) void renderMermaid();
  }, [mermaidHtml]);
  return (
    <div>
      {parts.map(part => part.kind === "echarts"
        ? <EChartBlock key={part.key} source={part.source} chart={part.chart} error={part.error}
            onExpand={part.chart ? () => setActiveChart(part.validIndex) : undefined} />
        : <div key={part.key} className="md-text-segment" dangerouslySetInnerHTML={{ __html: part.html }} />)}
      {activeChart !== null && validCharts[activeChart] ? (
        <ChartModal
          chart={validCharts[activeChart].chart}
          source={validCharts[activeChart].source}
          index={activeChart}
          total={validCharts.length}
          onPrevious={() => setActiveChart(current => current === null ? null : Math.max(0, current - 1))}
          onNext={() => setActiveChart(current => current === null ? null : Math.min(validCharts.length - 1, current + 1))}
          onClose={() => setActiveChart(null)}
        />
      ) : null}
    </div>
  );
}
