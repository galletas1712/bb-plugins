import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CodeView, type CodeViewHandle, type CodeViewProps } from "@pierre/diffs/react";
import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { MarkdownDiff } from "./markdown-diff";
import { mapScroll, type ScrollAnchor } from "../lib/scroll-map";

export type MarkdownView = "source" | "rendered" | "paired";
export interface SourceTarget { side: "additions" | "deletions"; start: number; end: number }
interface Props<T> {
  fileDiff: FileDiffMetadata | null;
  annotations: DiffLineAnnotation<T>[];
  options: CodeViewProps<T, undefined>["options"];
  selected: SelectedLineRange | null;
  onSelect(range: SelectedLineRange | null): void;
  renderAnnotation: CodeViewProps<T, undefined>["renderAnnotation"];
  mode: MarkdownView;
  onMode(mode: MarkdownView): void;
  contents: { oldContent: string; newContent: string } | null;
  contentError: string | null;
  prose: string;
  target?: SourceTarget | null;
  header?: ReactNode;
}
const panelStorage = {
  getItem(key: string) { try { return window.localStorage.getItem(key); } catch { return null; } },
  setItem(key: string, value: string) { try { window.localStorage.setItem(key, value); } catch { /* Storage is optional. */ } },
};

/** Own the two scroll surfaces and their correspondence, including annotation heights. */
export function DiffViewer<T>({ fileDiff, annotations, options, selected, onSelect, renderAnnotation, mode, onMode, contents, contentError, prose, target, header }: Props<T>) {
  const code = useRef<CodeViewHandle<T, undefined>>(null);
  const [sourceElement, setSourceElement] = useState<HTMLDivElement | null>(null);
  const mountSource = useCallback((element: HTMLDivElement | null) => { if (element) element.tabIndex = 0; setSourceElement(element); }, []);
  const preview = useRef<HTMLDivElement>(null);
  const previewContent = useRef<HTMLDivElement>(null);
  const active = useRef<"source" | "rendered">("source");
  const frame = useRef(0);
  const syncRef = useRef<() => void>(() => undefined);
  const [jump, setJump] = useState<SourceTarget | null>(null);
  const appliedJump = useRef<SourceTarget | null>(null);
  const location = useRef<{ lineNumber: number; side: "additions" | "deletions" } | null>(null);
  const previousMode = useRef(mode);
  const restoring = useRef(false);
  const revealSource = useRef(false);
  if (previousMode.current !== mode) { previousMode.current = mode; restoring.current = true; revealSource.current = true; }
  const measured = useRef<{ key: string; anchors: ScrollAnchor[] } | null>(null);
  const version = useRef(0);
  const items = useMemo(() => fileDiff ? [{ id: "file", type: "diff" as const, fileDiff, annotations, version: ++version.current }] : [], [fileDiff, annotations]);
  const layout = useDefaultLayout({ id: "review-desk:markdown-panels", panelIds: ["source", "rendered"], storage: panelStorage });

  const synchronize = useCallback(() => {
    if (mode !== "paired") return;
    const viewer = code.current?.getInstance();
    const rendered = preview.current;
    const item = viewer?.getRenderedItems().find((item) => item.type === "diff");
    if (!viewer || !rendered || !item || item.type !== "diff") return;
    const key = [version.current, viewer.getScrollHeight(), rendered.scrollHeight, sourceElement?.clientWidth, rendered.clientWidth].join(":");
    let anchors = measured.current?.key === key ? measured.current.anchors : null;
    if (anchors === null) {
      const itemTop = viewer.getTopForItem(item.id) ?? 0;
      const previewTop = rendered.getBoundingClientRect().top;
      anchors = [{ source: 0, rendered: 0 }];
      for (const block of Array.from(rendered.querySelectorAll<HTMLElement>("[data-source-start]"))) {
        const side = block.dataset.sourceSide === "deletions" ? "deletions" : "additions";
        const start = item.instance.getLinePosition(Number(block.dataset.sourceStart), side);
        const end = item.instance.getLinePosition(Number(block.dataset.sourceEnd), side);
        if (!start || !end) continue;
        const rect = block.getBoundingClientRect();
        anchors.push({ source: itemTop + start.top, rendered: rect.top - previewTop + rendered.scrollTop });
        anchors.push({ source: itemTop + end.top + end.height, rendered: rect.bottom - previewTop + rendered.scrollTop });
      }
      anchors.push({ source: viewer.getScrollHeight(), rendered: rendered.scrollHeight });
      measured.current = { key, anchors };
    }
    const from = active.current;
    const top = mapScroll(from === "source" ? viewer.getScrollTop() : rendered.scrollTop, anchors, from);
    if (from === "source") {
      if (Math.abs(rendered.scrollTop - Math.min(top, Math.max(0, rendered.scrollHeight - rendered.clientHeight))) > 1) rendered.scrollTop = top;
    } else if (Math.abs(viewer.getScrollTop() - Math.min(top, Math.max(0, viewer.getScrollHeight() - viewer.getHeight()))) > 1) {
      viewer.scrollTo({ type: "position", position: top, behavior: "instant" });
    }
  }, [mode, sourceElement]);
  syncRef.current = synchronize;
  const scheduleSync = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => syncRef.current());
  }, []);
  useEffect(() => {
    if (!sourceElement || !previewContent.current || mode !== "paired") return;
    const observer = new ResizeObserver(() => { measured.current = null; scheduleSync(); });
    observer.observe(sourceElement);
    observer.observe(previewContent.current);
    scheduleSync();
    return () => { observer.disconnect(); cancelAnimationFrame(frame.current); };
  }, [sourceElement, mode, contents, scheduleSync]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useEffect(() => {
    if ((jump ?? target) && (jump ?? target) !== appliedJump.current) return;
    const saved = location.current;
    const frame = requestAnimationFrame(() => {
      if (saved && mode !== "rendered") code.current?.scrollTo({ type: "line", id: "file", ...saved, align: "start", behavior: "instant" });
      else if (saved && preview.current) {
        const blocks = Array.from(preview.current.querySelectorAll<HTMLElement>("[data-source-start]"));
        const block = blocks.find((block) => block.dataset.sourceSide === saved.side && Number(block.dataset.sourceEnd) >= saved.lineNumber) ?? blocks.at(-1);
        if (block) preview.current.scrollTop += block.getBoundingClientRect().top - preview.current.getBoundingClientRect().top;
      }
      restoring.current = false;
      scheduleSync();
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, contents, scheduleSync]);
  useEffect(() => {
    const next = jump ?? target;
    if (mode === "rendered" || !next || next === appliedJump.current) return;
    appliedJump.current = next;
    active.current = "source";
    code.current?.scrollTo({ type: "range", id: "file", range: { start: next.start, end: next.end, side: next.side }, align: "start", behavior: "instant" });
    restoring.current = false;
  }, [jump, target, mode, fileDiff]);

  const source = <div className="h-full min-h-0" aria-label="Source diff" onWheelCapture={() => { active.current = "source"; }} onPointerDownCapture={() => { active.current = "source"; }} onKeyDownCapture={() => { active.current = "source"; }}>
    {fileDiff ? <CodeView<T>
      ref={code} containerRef={mountSource} className="h-full overflow-auto" style={{ height: "100%" }} items={items}
      options={{ ...options, diffIndicators: "none", diffStyle: mode === "paired" ? "unified" : options?.diffStyle,
        expandUnchanged: mode === "paired" || revealSource.current || jump !== null || target != null, onPostRender: scheduleSync, stickyHeaders: false,
        itemMetrics: { paddingTop: 0 }, unsafeCSS: "[data-code] { padding-top: 0; }",
        layout: { paddingTop: 0, paddingBottom: 0, gap: 0 } }}
      selectedLines={selected ? { id: "file", range: selected } : null}
      onSelectedLinesChange={(selection) => onSelect(selection?.range ?? null)}
      renderAnnotation={renderAnnotation}
      renderCodeViewHeader={header ? () => header : undefined}
      onScroll={(top, viewer) => {
        const item = viewer.getRenderedItems().find((item) => item.type === "diff");
        if (!restoring.current && item?.type === "diff") {
          const anchor = item.instance.getNumericScrollAnchor(top - (viewer.getTopForItem(item.id) ?? 0));
          if (anchor) location.current = { lineNumber: anchor.lineNumber, side: anchor.side === "deletions" ? "deletions" : "additions" };
        }
        if (active.current === "source") scheduleSync();
      }}
    /> : <div className="overflow-y-auto p-3">{header}<p className="text-sm text-muted-foreground">No textual diff.</p></div>}
  </div>;
  const rendered = <div ref={preview} tabIndex={0} className="h-full overflow-y-auto" aria-label="Rendered preview" onWheelCapture={() => { active.current = "rendered"; }} onPointerDownCapture={() => { active.current = "rendered"; }} onKeyDownCapture={() => { active.current = "rendered"; }} onScroll={() => {
    if (!restoring.current && mode === "rendered" && preview.current) {
      const top = preview.current.getBoundingClientRect().top;
      const block = Array.from(preview.current.querySelectorAll<HTMLElement>("[data-source-start]")).find((block) => block.getBoundingClientRect().bottom > top);
      if (block) location.current = { lineNumber: Number(block.dataset.sourceStart), side: block.dataset.sourceSide === "deletions" ? "deletions" : "additions" };
    }
    if (active.current === "rendered") scheduleSync();
  }}>
    <div ref={previewContent}>
      {mode === "rendered" ? header : null}
      {contentError ? <p role="alert" className="p-3 text-sm text-destructive">{contentError}</p> : contents === null ? <p className="p-3 text-sm text-muted-foreground">Loading rendered diff…</p> : <MarkdownDiff {...contents} diffStyle={mode === "paired" ? "unified" : options?.diffStyle ?? "unified"} className={prose} onSource={(side, block) => {
        const range = { side, start: block.startLine, end: block.endLine };
        setJump(range); onSelect(range);
        if (mode === "rendered") onMode("source");
      }} />}
    </div>
  </div>;
  if (mode === "source") return source;
  if (mode === "rendered") return rendered;
  return <Group {...layout} orientation="horizontal" className="h-full min-h-0" aria-label="Source and rendered Markdown" onLayoutChange={() => scheduleSync()}>
    <Panel id="source" defaultSize="50%" minSize="25%">{source}</Panel>
    <Separator aria-label="Resize source and rendered panes" className="w-1 border-x border-border bg-muted/40 hover:bg-blue-500/40 focus-visible:bg-blue-500/40" />
    <Panel id="rendered" defaultSize="50%" minSize="25%">{rendered}</Panel>
  </Group>;
}
