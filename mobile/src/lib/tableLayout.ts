/* Shared markdown / interactive-table column sizing for React Native.
   RN has no table layout: each row is an independent flex row, so cells that
   size to their own content drift out of column alignment. Fix every column
   width up front from a 75th-percentile content estimate, clamped to
   [MIN_COL, MAX_COL], so a rare wide value wraps and grows the row instead
   of dragging the column out. */

import type { Span } from "@agora/core";

export const MIN_COL = 80;
export const MAX_COL = 260;
export const ACTION_COL = 112;
/** Space between neighboring interactive-table field borders. Kept outside
    the input so header, editable, and locked cells share one outer width. */
export const INTERACTIVE_COL_GUTTER = 4;
const CELL_HPAD = 20; // cell paddingHorizontal * 2
const CHAR_W = 8; // ~average glyph width of the system font at fontSize 13.5

export function estimateWidthFromChars(chars: number): number {
  return chars * CHAR_W + CELL_HPAD;
}

/** Turn a content estimate (or agent-supplied width) into the outer width of
    an interactive column, including its visible inter-field gutters. */
export function interactiveColumnWidth(estimated: number, explicit?: number): number {
  if (typeof explicit === "number" && explicit > 0) {
    return Math.ceil(
      Math.min(Math.max(explicit + INTERACTIVE_COL_GUTTER * 2, MIN_COL), MAX_COL),
    );
  }
  return Math.ceil(Math.min(Math.max(estimated + INTERACTIVE_COL_GUTTER * 2, MIN_COL), MAX_COL));
}

export function estimateWidth(spans: Span[]): number {
  const chars = spans.reduce((n, s) => n + s.text.length, 0);
  return estimateWidthFromChars(chars);
}

function clampCol(target: number): number {
  return Math.ceil(Math.min(Math.max(target, MIN_COL), MAX_COL));
}

function widthFromEstimates(ests: number[], headerEst: number): number {
  const sorted = ests.filter((w) => w > 0).sort((a, b) => a - b);
  const p75 = sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * 0.75) - 1)] : 0;
  // Widest value that still counts as typical; anything beyond wraps.
  const typicalMax = Math.min(sorted.length ? sorted[sorted.length - 1] : 0, p75 * 1.5);
  // Headers get full weight — a wrapped header reads worse than a slightly
  // wide column of short values.
  return clampCol(Math.max(typicalMax, headerEst, MIN_COL));
}

export function columnWidths(head: Span[][], rows: Span[][][]): number[] {
  const cols = Math.max(head.length, ...rows.map((r) => r.length), 0);
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    const ests = rows.map((r) => (r[c] ? estimateWidth(r[c]) : 0));
    const headerEst = head[c] ? estimateWidth(head[c]) : 0;
    widths.push(widthFromEstimates(ests, headerEst));
  }
  return widths;
}

/** Same estimator for plain-string interactive table cells / headers. */
export function columnWidthsFromStrings(head: string[], rows: string[][]): number[] {
  const cols = Math.max(head.length, ...rows.map((r) => r.length), 0);
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    const ests = rows.map((r) => (r[c] != null ? estimateWidthFromChars(String(r[c]).length) : 0));
    const headerEst = head[c] != null ? estimateWidthFromChars(String(head[c]).length) : 0;
    widths.push(widthFromEstimates(ests, headerEst));
  }
  return widths;
}
