/* Message prose: mdliteDoc + @mention decoration. Mermaid marker divs render
   lazily after paint; ECharts fences leave slots in the HTML that charts are
   portaled into, so a chart inside a list item stays in its item. Quotes and
   code blocks carry copy buttons, handled by one delegated click. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { mdliteDoc, normalizeEChart, type NormalizedEChart } from "@agora/core";
import { copyMdBlock } from "../lib/copyMdBlock";
import { decorateMentions, type MentionIndex } from "../lib/mentions";
import { renderMermaid } from "../lib/mermaid";
import { ChartModal, EChartBlock } from "./EChartBlock";
import { useAppearance } from "../state/appearance";

type ChartPart = { source: string; chart: NormalizedEChart | null; error: string; validIndex: number };

export function MdText({ text, mentions }: { text: string; mentions?: MentionIndex }) {
  const theme = useAppearance(state => state.resolved);
  // Charts depend on the text alone, so a mentions map arriving later
  // re-decorates the prose without handing EChartBlock new chart objects.
  const doc = useMemo(() => mdliteDoc(text, { copy: true, charts: true }), [text]);
  const charts = useMemo(() => {
    let validIndex = 0;
    return doc.charts.map((source): ChartPart => {
      try {
        const chart = normalizeEChart(source);
        return { source, chart, error: "", validIndex: validIndex++ };
      } catch (error) {
        return { source, chart: null, error: (error as Error).message, validIndex: -1 };
      }
    });
  }, [doc]);
  const html = useMemo(() => mentions ? decorateMentions(doc.html, mentions) : doc.html, [doc, mentions]);
  const copies = doc.copies;
  const validCharts = charts.filter((part): part is ChartPart & { chart: NormalizedEChart } => part.chart !== null);
  const [activeChart, setActiveChart] = useState<number | null>(null);
  useEffect(() => setActiveChart(null), [text]);
  useEffect(() => {
    if (activeChart !== null && activeChart >= validCharts.length) setActiveChart(null);
  }, [activeChart, validCharts.length]);
  useEffect(() => {
    if (html.includes("md-mermaid")) void renderMermaid();
  }, [html, theme]);
  // The HTML is written here rather than via dangerouslySetInnerHTML: React
  // may rewrite that on any re-render, which would swap out the slots. Each
  // chart renders into a persistent host node that is moved into its slot
  // whenever the HTML is rewritten (mentions arriving, an edit), so charts
  // aren't torn down and re-initialised with the prose around them.
  const htmlRef = useRef<HTMLDivElement>(null);
  // One host per chart index, from a pool that only grows, so an edit that
  // adds or drops a chart keeps the hosts (and canvases) of the rest. Hosts
  // are created and attached to their slots here, and only then handed to
  // render, so a chart never mounts into a detached, unmeasurable node.
  const hostPool = useRef<HTMLDivElement[]>([]);
  const [hosts, setHosts] = useState<(HTMLDivElement | undefined)[]>([]);
  useLayoutEffect(() => {
    const el = htmlRef.current;
    if (!el) return;
    el.innerHTML = html;
    const pool = hostPool.current;
    while (pool.length < charts.length) {
      const host = document.createElement("div");
      host.className = "md-echarts-host";
      pool.push(host);
    }
    // Only hosts that actually landed in a slot are handed to render.
    const attached: (HTMLDivElement | undefined)[] = Array.from({ length: charts.length }, () => undefined);
    el.querySelectorAll<HTMLElement>(".md-echarts-slot").forEach(slot => {
      const index = Number(slot.dataset.chartIndex);
      const host = pool[index];
      if (host && index < charts.length) { slot.appendChild(host); attached[index] = host; }
    });
    setHosts(current => current.length === attached.length && current.every((h, i) => h === attached[i])
      ? current : attached);
  }, [html, charts.length]);
  return (
    <div>
      <div ref={htmlRef} className="md-text-segment"
        onClick={(event: MouseEvent<HTMLDivElement>) => {
          const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button.md-copy");
          const copyText = button ? copies[Number(button.dataset.copyIndex)] : undefined;
          if (!button || copyText === undefined) return;
          event.stopPropagation();
          void copyMdBlock(button, copyText);
        }} />
      {charts.map((part, index) => hosts[index] ? createPortal(
        <EChartBlock source={part.source} chart={part.chart} error={part.error}
          onExpand={part.chart ? () => setActiveChart(part.validIndex) : undefined} />,
        hosts[index]!, `${index}`) : null)}
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
