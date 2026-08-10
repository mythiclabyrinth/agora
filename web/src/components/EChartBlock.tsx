import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NormalizedEChart } from "@agora/core";
import type { EChartsType } from "echarts";
import { Icon } from "../lib/icons";

function ChartCanvas({ chart, source, expanded = false }: { chart: NormalizedEChart; source: string; expanded?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const instance = useRef<EChartsType | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let observer: ResizeObserver | undefined;
    void import("echarts").then(echarts => {
      if (cancelled || !ref.current) return;
      const rendered = echarts.init(ref.current, undefined, { renderer: "canvas" });
      instance.current = rendered;
      rendered.setOption(chart.option);
      observer = new ResizeObserver(() => rendered.resize());
      observer.observe(ref.current);
      // A modal's first layout follows its mount; resize once more after paint.
      if (expanded) requestAnimationFrame(() => rendered.resize());
    }).catch(() => { if (!cancelled) setLoadError(true); });
    return () => {
      cancelled = true;
      observer?.disconnect();
      instance.current?.dispose();
      instance.current = null;
    };
  }, [chart, expanded]);

  if (loadError) return <div className="ago-chart-load-error">Could not load the chart renderer.<pre>{source}</pre></div>;
  // Expanded charts fill the dialog body (CSS-driven) instead of keeping the
  // inline pixel height, which would leave the rest of the modal empty.
  return (
    <div
      ref={ref}
      className={expanded ? "ago-chart-canvas expanded" : "ago-chart-canvas"}
      style={expanded ? undefined : { height: chart.height }}
      role="img"
      aria-label={chart.title}
    />
  );
}

export function ChartModal({ chart, source, index, total, onPrevious, onNext, onClose }: {
  chart: NormalizedEChart; source: string; index: number; total: number;
  onPrevious: () => void; onNext: () => void; onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const onPreviousRef = useRef(onPrevious);
  const onNextRef = useRef(onNext);
  onCloseRef.current = onClose;
  onPreviousRef.current = onPrevious;
  onNextRef.current = onNext;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
      if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (event.key === "ArrowLeft") onPreviousRef.current();
        if (event.key === "ArrowRight") onNextRef.current();
      }
      if (event.key === "Tab") {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        if (!controls.length) return;
        const current = controls.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.shiftKey
          ? (current <= 0 ? controls.length - 1 : current - 1)
          : (current === controls.length - 1 ? 0 : current + 1);
        event.preventDefault();
        controls[next]?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, []);

  return createPortal(
    <div className="ago-chart-overlay" role="dialog" aria-modal="true" aria-label={chart.title}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="ago-chart-modal">
        <header>
          <strong>{chart.title}</strong>
          <button ref={closeRef} type="button" aria-label="Close chart" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <div className="ago-chart-scroll expanded">
          <div className="ago-chart-stage" style={{ width: chart.width ?? "100%", minWidth: "100%" }}>
            <ChartCanvas chart={chart} source={source} expanded />
          </div>
        </div>
        {total > 1 ? (
          <div className="ago-media-navigation ago-chart-navigation">
            <button type="button" disabled={index === 0} aria-label="Previous chart" onClick={onPrevious}>
              <Icon name="chevron-left" /> Previous
            </button>
            <span aria-live="polite" aria-atomic="true">Chart {index + 1} of {total}</span>
            <button type="button" disabled={index === total - 1} aria-label="Next chart" onClick={onNext}>
              Next <Icon name="chevron-right" />
            </button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export function EChartBlock({ source, chart, error = "", onExpand }: {
  source: string; chart: NormalizedEChart | null; error?: string; onExpand?: () => void;
}) {
  if (!chart) {
    return (
      <div className="ago-chart-error" role="alert">
        <strong>Could not render ECharts chart</strong>
        <span>{error}</span>
        <pre>{source}</pre>
      </div>
    );
  }
  return (
    <div className="ago-chart-block">
      <div className="ago-chart-head">
        <span>{chart.title}</span>
        <button type="button" onClick={onExpand} aria-label={`Expand chart: ${chart.title}`}>
          <Icon name="maximize-2" /> expand
        </button>
      </div>
      <div className="ago-chart-scroll">
        <div className="ago-chart-stage" style={{ width: chart.width ?? "100%", minWidth: "100%" }}>
          <ChartCanvas chart={chart} source={source} />
        </div>
      </div>
    </div>
  );
}
