export interface ScrollAnchor { source: number; rendered: number }

/** Interpolate between corresponding source lines and rendered block edges. */
export function mapScroll(position: number, anchors: ScrollAnchor[], from: keyof ScrollAnchor): number {
  const to = from === "source" ? "rendered" : "source";
  const ordered: ScrollAnchor[] = [];
  for (const anchor of anchors) {
    const last = ordered.at(-1);
    if (!Number.isFinite(anchor.source) || !Number.isFinite(anchor.rendered)) continue;
    if (last && (anchor[from] <= last[from] || anchor[to] < last[to])) continue;
    ordered.push(anchor);
  }
  if (ordered.length === 0) return 0;
  if (position <= ordered[0][from]) return ordered[0][to];
  for (let i = 1; i < ordered.length; i++) {
    const start = ordered[i - 1], end = ordered[i];
    if (position <= end[from]) return start[to] + (position - start[from]) / (end[from] - start[from]) * (end[to] - start[to]);
  }
  return ordered.at(-1)![to];
}
