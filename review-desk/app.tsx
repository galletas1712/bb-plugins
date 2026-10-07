// Review pull requests, read GitHub conversations, and submit inline comments.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  Markdown,
  UrlLink,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  experimental_FileLink as FileLink,
  experimental_useCodeTheme as useCodeTheme,
} from "@get-bb/plugin-sdk/app";
import { FileDiff, type FileDiffMetadata, type SelectedLineRange } from "@pierre/diffs/react";
import { parsePatchFiles } from "@pierre/diffs";
import type { CommitInfo, FileEntry, Note, PendingComment, Review, ReviewSummary, StackView, rpcContract } from "./server";
import type { ChangedFile } from "./host-contract";
import type { GhThread, GhIssueComment, GhReview, GhEvent } from "./host-contract";
import { EditableBody } from "./components/editable-body";
import { MarkdownDiff } from "./components/markdown-diff";
import { diffStats } from "./lib/diff-stats";
import { orderThreadComments } from "./lib/thread-comments";
import { Button } from "@/components/ui/button";
import { PrMark, StatePill } from "./components/pr-status";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { commentSelection, placeAnnotations, type CommentAnchor } from "./diff-annotations";

type Contract = typeof rpcContract;

const PANEL_ID = "reviews";
const PANEL_PATH = "reviews";
const REVIEW_CHANGED = "review-changed";


interface DiffJump { path: string; line: number | null; side: "old" | "new" }
const TREE_KEY = "review-desk:file-tree";
const STACK_KEY = "review-desk:stack-sidebar";
const fileSelKey = (reviewId: string, scope = "pr") => `review-desk:diff-file:${reviewId}:${scope}`;

const SHIKI_THEMES = new Set([
  "andromeeda", "aurora-x", "ayu-dark", "catppuccin-frappe", "catppuccin-latte", "catppuccin-macchiato", "catppuccin-mocha", "dark-plus", "dracula", "dracula-soft",
  "everforest-dark", "everforest-light", "github-dark", "github-dark-default", "github-dark-dimmed", "github-dark-high-contrast", "github-light", "github-light-default",
  "github-light-high-contrast", "gruvbox-dark-hard", "gruvbox-dark-medium", "gruvbox-dark-soft", "gruvbox-light-hard", "gruvbox-light-medium", "gruvbox-light-soft", "houston",
  "kanagawa-dragon", "kanagawa-lotus", "kanagawa-wave", "laserwave", "light-plus", "material-theme", "material-theme-darker", "material-theme-lighter", "material-theme-ocean",
  "material-theme-palenight", "min-dark", "min-light", "monokai", "night-owl", "nord", "one-dark-pro", "one-light", "plastic", "poimandres", "red", "rose-pine", "rose-pine-dawn",
  "rose-pine-moon", "slack-dark", "slack-ochin", "snazzy-light", "solarized-dark", "solarized-light", "synthwave-84", "tokyo-night", "vesper", "vitesse-black", "vitesse-dark", "vitesse-light",
]);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function payloadReview(payload: unknown): { reviewId: string; what: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { reviewId?: unknown; what?: unknown };
  return typeof p.reviewId === "string" ? { reviewId: p.reviewId, what: typeof p.what === "string" ? p.what : "" } : null;
}

function confirmRemoveReview(multiple = false): boolean {
  return window.confirm(multiple
    ? "Remove this entire stack from Review Desk, including its local notes and pending comments? The pull requests stay on GitHub."
    : "Remove this review from Review Desk? The pull request stays on GitHub.");
}

function RemoveReviewButton({ onClick, label }: { onClick(): void; label: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="mr-1 h-7 w-7 shrink-0 px-0 text-muted-foreground hover:text-destructive"
      aria-label={label}
      title={label}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
    >
      <Icon name="Trash2" className="size-3.5" />
    </Button>
  );
}

function readStorage<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: unknown): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable; the feature degrades to per-surface defaults
  }
}

function timeAgo(iso: string | number): string {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const diff = Math.max(0, Date.now() - ms);
  const m = Math.round(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function settleDiffLine(container: HTMLElement | null, path: string, line: number | null): () => void {
  const wanted = line === null ? null : String(line);
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    const card = Array.from(container?.querySelectorAll<HTMLElement>("[data-review-file]") ?? []).find((element) => element.dataset.reviewFile === path);
    const host = card ? Array.from(card.querySelectorAll("*")).find((el) => el.shadowRoot !== null) : undefined;
    const cell = wanted !== null && host?.shadowRoot ? Array.from(host.shadowRoot.querySelectorAll("[data-line-number-content]")).find((el) => el.textContent?.trim() === wanted) : undefined;
    if (cell) {
      cell.scrollIntoView({ block: "center" });
      return;
    }
    card?.scrollIntoView({ block: "start" });
    if (++tries < 10) timer = setTimeout(tick, tries < 4 ? 300 : 600);
  };
  tick();
  return () => clearTimeout(timer);
}

function asFileEntry(file: ChangedFile): FileEntry {
  return { ...file, viewed: false, threadCount: 0, unresolvedCount: 0, pendingCount: 0 };
}

function parseReviewSubPath(subPath: string): { reviewId: string | null; commit: CommitTarget | null } {
  const [head, section, target] = subPath.split("/");
  return { reviewId: head !== "" ? head : null, commit: section === "commits" && target !== undefined ? parseCommitTarget(target) : null };
}

async function openSlice(
  rpc: ReturnType<typeof useRpc<Contract>>,
  navigate: ReturnType<typeof useBbNavigate>,
  owner: string,
  repo: string,
  entry: { number: number; reviewId: string | null },
): Promise<void> {
  if (entry.reviewId !== null) {
    navigate.toPluginPanel(PANEL_PATH, { subPath: entry.reviewId });
    return;
  }
  const { review } = await rpc.call("reviews_open", { ref: `${owner}/${repo}#${entry.number}` });
  navigate.toPluginPanel(PANEL_PATH, { subPath: review.id });
}

function splitPath(path: string): { name: string; dir: string } {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? { name: path, dir: "" } : { name: path.slice(idx + 1), dir: path.slice(0, idx) };
}

type FileTreeNode =
  | { kind: "dir"; name: string; path: string; children: FileTreeNode[] }
  | { kind: "file"; name: string; path: string; location: "old" | "new" | null; file: FileEntry };

function buildFileTree(files: FileEntry[]): FileTreeNode[] {
  const root: Extract<FileTreeNode, { kind: "dir" }> = { kind: "dir", name: "", path: "", children: [] };
  const dirs = new Map<string, Extract<FileTreeNode, { kind: "dir" }>>([["", root]]);
  const ensure = (dirPath: string): Extract<FileTreeNode, { kind: "dir" }> => {
    const existing = dirs.get(dirPath);
    if (existing !== undefined) return existing;
    const { name, dir } = splitPath(dirPath);
    const parent = ensure(dir);
    const node: Extract<FileTreeNode, { kind: "dir" }> = { kind: "dir", name: name || dirPath, path: dirPath, children: [] };
    parent.children.push(node);
    dirs.set(dirPath, node);
    return node;
  };
  for (const file of files) {
    const moved = file.status === "renamed" && file.oldPath !== null && file.oldPath !== file.path;
    for (const path of moved ? [file.oldPath!, file.path] : [file.path]) {
      const { name, dir } = splitPath(path);
      ensure(dir).children.push({ kind: "file", name, path, location: moved ? path === file.oldPath ? "old" : "new" : null, file });
    }
  }
  const sort = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => (a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
    for (const node of nodes) if (node.kind === "dir") sort(node.children);
  };
  sort(root.children);
  return root.children;
}

function filterFileTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return nodes;
  const walk = (list: FileTreeNode[]): FileTreeNode[] => {
    const out: FileTreeNode[] = [];
    for (const node of list) {
      if (node.kind === "file") {
        if (node.path.toLowerCase().includes(needle)) out.push(node);
        continue;
      }
      if (node.path.toLowerCase().includes(needle) || node.name.toLowerCase().includes(needle)) {
        out.push(node);
        continue;
      }
      const children = walk(node.children);
      if (children.length > 0) out.push({ ...node, children });
    }
    return out;
  };
  return walk(nodes);
}

function collectDirPaths(nodes: FileTreeNode[], into: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind === "dir") {
      into.push(node.path);
      collectDirPaths(node.children, into);
    }
  }
  return into;
}

interface ReviewDetail {
  review: Review;
  files: FileEntry[];
  pending: PendingComment[];
  threads: GhThread[];
  notes: Note[];
  seen: { prevHead: string | null; seenHead: string | null };
  stack: StackView | null;
  syncError: string | null;
}

/** A commit view target parsed from the sub-path: `sha`, or `from..to` meaning the commits from `from` through `to` inclusive. */
interface CommitTarget {
  to: string;
  from: string | null;
  inclusive: boolean;
}
function parseCommitTarget(text: string): CommitTarget | null {
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // keep the raw text
  }
  const m = /^([0-9a-f]{4,40})(?:\.\.([0-9a-f]{4,40}))?$/i.exec(decoded);
  if (m === null) return null;
  if (m[2] === undefined) return { to: m[1], from: null, inclusive: false };
  return { to: m[2], from: m[1], inclusive: true };
}
function commitPath(reviewId: string, target: CommitTarget): string {
  return `${reviewId}/commits/${target.from === null ? target.to : `${target.from}..${target.to}`}`;
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

function useNarrow(element: HTMLElement | null, breakpoint = 640): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    if (!element) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setNarrow(width < breakpoint);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, breakpoint]);
  return narrow;
}

function pathsEqual(left: string, right: string): boolean {
  const strip = (p: string) => p.replace(/^[ab]\//, "");
  return left === right || strip(left) === strip(right);
}

// An explicit choice overrides responsive defaults, including after navigation.
function useSidebar(key: string, narrow: boolean) {
  const [choice, setChoice] = useState<boolean | null>(() => {
    const stored = readStorage<unknown>(key);
    return typeof stored === "boolean" ? stored : null;
  });
  const open = choice ?? !narrow;
  const setOpen = (value: boolean) => { setChoice(value); writeStorage(key, value); };
  return { open, setOpen, toggle: () => setOpen(!open) };
}

function pickFileDiff(patch: string, path: string, oldPath: string | null): FileDiffMetadata | null {
  if (patch.trim() === "") return null;
  try {
    const files = parsePatchFiles(patch).flatMap((entry) => entry.files);
    const match = files.find((file) => {
      if (pathsEqual(file.name, path) || (file.prevName !== undefined && pathsEqual(file.prevName, path))) return true;
      if (oldPath === null) return false;
      return pathsEqual(file.name, oldPath) || (file.prevName !== undefined && pathsEqual(file.prevName, oldPath));
    });
    return match ?? (files.length === 1 ? files[0] : null);
  } catch {
    return null;
  }
}

function useRefreshFallback(refetch: () => void) {
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    const refreshVisible = () => { if (document.visibilityState !== "hidden") refetch(); };
    const timer = window.setInterval(refreshVisible, 15_000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [refetch]);
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previousConnection.current !== "connected") refetch();
    previousConnection.current = connection;
  }, [connection, refetch]);
}

function useReviews() {
  const rpc = useRpc<Contract>();
  const [reviews, setReviews] = useState<ReviewSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refetch = useCallback(() => {
    const request = ++generation.current;
    rpc.call("reviews_list").then(
      (result) => {
        if (request !== generation.current) return;
        setReviews(result.reviews);
        setError(result.discoveryError ?? null);
      },
      (cause: unknown) => { if (request === generation.current) setError(describeError(cause)); },
    );
  }, [rpc]);
  useEffect(() => { refetch(); return () => { generation.current++; }; }, [refetch]);
  useRefreshFallback(refetch);
  useRealtime(REVIEW_CHANGED, refetch);
  return { reviews, error, refetch };
}

function useReview(reviewId: string | null) {
  const rpc = useRpc<Contract>();
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const activeReview = useRef(reviewId);
  activeReview.current = reviewId;
  const refetch = useCallback(() => {
    if (reviewId === null || activeReview.current !== reviewId) return;
    const request = ++generation.current;
    rpc.call("reviews_get", { reviewId }).then(
      (result) => {
        if (request !== generation.current) return;
        setDetail(result);
        setError(null);
      },
      (cause: unknown) => { if (request === generation.current) setError(describeError(cause)); },
    );
  }, [rpc, reviewId]);
  useEffect(() => {
    setDetail(null);
    setError(null);
    refetch();
    return () => { generation.current++; };
  }, [refetch]);
  useRealtime(REVIEW_CHANGED, (payload) => {
    const p = payloadReview(payload);
    if (p === null || p.reviewId !== reviewId) return;
    if (p.what === "removed" || p.what === "closed") {
      generation.current++;
      setDetail(null);
      setError(p.what);
      return;
    }
    refetch();
  });
  useRefreshFallback(refetch);
  return { rpc, detail, error, refetch };
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function EmptyState({ children }: { children: ReactNode }) {
  return <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{children}</div>;
}

function SyncNotice({ reviewId, message, onRefresh }: { reviewId: string; message: string | null; onRefresh(): void }) {
  const rpc = useRpc<Contract>();
  const [busy, setBusy] = useState(false);
  if (!message) return null;
  return <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 text-sm">
    <span className="min-w-0 flex-1 break-words">GitHub refresh failed: {message}</span>
    <Button variant="outline" size="sm" disabled={busy} onClick={async () => {
      setBusy(true);
      try { await rpc.call("reviews_sync", { reviewId }); onRefresh(); }
      catch (cause) { toast.error(describeError(cause)); }
      finally { setBusy(false); }
    }}>{busy ? "Refreshing…" : "Retry"}</Button>
  </div>;
}

function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="inline-flex shrink-0 gap-1 font-mono text-xs tabular-nums" aria-label={`Diff: ${additions} additions, ${deletions} deletions`}><span className="text-emerald-600 dark:text-emerald-400">+{additions.toLocaleString()}</span><span className="text-red-600 dark:text-red-400">−{deletions.toLocaleString()}</span></span>;
}

function CountBadge({ count, title }: { count: number; title: string }) {
  if (count <= 0) return null;
  return <span className="rounded-full bg-foreground/10 px-1.5 text-[10px] tabular-nums" title={title}>{count}</span>;
}

function LayerMark({ position, size, className, title }: { position: number; size: number; className?: string; title?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 tabular-nums", className)} title={title ?? `Layer ${position} of ${size}`}>
      <Icon name="Layers" className="size-3.5" />
      {position}/{size}
    </span>
  );
}



function reviewStateTone(state: string): string {
  switch (state) {
    case "APPROVED": return "text-primary";
    case "CHANGES_REQUESTED": return "text-destructive";
    default: return "text-muted-foreground";
  }
}



// ---------------------------------------------------------------------------
// Annotations inside the diff
// ---------------------------------------------------------------------------

type Anno =
  | { kind: "thread"; thread: GhThread }
  | { kind: "pending"; pending: PendingComment }
  | { kind: "note"; note: Note }
  | { kind: "composer"; path: string; line: number; startLine: number | null; side: "LEFT" | "RIGHT"; initial: string };

interface AnnoActions {
  editComment(id: string, body: string, expectedBody: string): Promise<{ body: string }>;
  refreshThreads(): void;
  reply(commentId: number, body: string): Promise<void>;
  resolve(threadId: string, resolve: boolean): Promise<void>;
  savePending(input: { path: string; line: number; startLine: number | null; side: "LEFT" | "RIGHT"; body: string }): Promise<void>;
  /** Same shape, but the comment stays a private note. */
  savePrivate(input: { path: string; line: number; startLine: number | null; side: "LEFT" | "RIGHT"; body: string }): Promise<void>;
  updatePending(id: string, body: string): Promise<void>;
  deletePending(id: string): Promise<void>;
  closeComposer(): void;
  promoteNote(id: string): Promise<void>;
  deleteNote(id: string): Promise<void>;
}

function NoteCard({ note, actions }: { note: Note; actions: Pick<AnnoActions, "promoteNote" | "deleteNote"> }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (cause) { toast.error(describeError(cause)); } finally { setBusy(false); }
  };
  return (
    <div className="my-2 rounded-lg border border-dashed border-border bg-card text-sm">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <span className="font-medium">Private note</span>
        {note.state === "stale" ? <span className="text-muted-foreground">Earlier version</span> : null}
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="sm" disabled={busy || note.state === "stale"} onClick={() => void run(() => actions.promoteNote(note.id))}>Add to review</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => actions.deleteNote(note.id))}>Delete</Button>
        </div>
      </div>
      <CommentBody body={note.body} className="px-3 py-2" />
    </div>
  );
}

function TextArea({ value, onChange, rows, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; rows: number; placeholder?: string; autoFocus?: boolean }) {
  return (
    <textarea
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      placeholder={placeholder}
      className="w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

// Annotations are slotted into Pierre's diff container and inherit its
// monospace font and `white-space: pre`, which is why comment bodies used to
// run off the right edge. These classes reset that and tame Markdown output.
const PROSE = cn(
  "font-sans text-[13px] leading-relaxed whitespace-normal text-foreground [overflow-wrap:anywhere] min-w-0 max-w-full",
  "[&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_h1]:my-2 [&_h1]:text-sm [&_h2]:my-2 [&_h2]:text-sm [&_h3]:my-1.5 [&_h3]:text-[13px] [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:text-muted-foreground",
  "[&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre [&_pre]:rounded-md [&_pre]:text-[12px] [&_code]:text-[12px] [&_:not(pre)>code]:whitespace-pre-wrap [&_:not(pre)>code]:[overflow-wrap:anywhere]",
  "[&_table]:my-1.5 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:text-[12px] [&_img]:max-w-full [&_a]:underline [&_a]:decoration-border [&_hr]:my-2",
);

function AuthorChip({ login, when }: { login: string; when?: string }) {
  return <span className="flex min-w-0 items-baseline gap-3 text-xs">
    <span className="truncate font-medium text-foreground">{login}</span>
    {when ? <time dateTime={when} className="text-muted-foreground">{timeAgo(when)}</time> : null}
  </span>;
}

/** GitHub comment Markdown: HTML comments dropped, `<details>` rendered as real collapsibles. */
function CommentBody({ body, className }: { body: string; className?: string }) {
  const cleaned = body.replace(/<!--[\s\S]*?-->/g, "");
  if (cleaned.trim() === "") return <p className={cn("text-xs text-muted-foreground", className)}>No message.</p>;
  const parts: ReactNode[] = [];
  const re = /<details[^>]*>\s*(?:<summary[^>]*>([\s\S]*?)<\/summary>)?([\s\S]*?)<\/details>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(cleaned)) !== null) {
    if (m.index > last) parts.push(<Markdown key={`t${i}`} content={cleaned.slice(last, m.index)} />);
    parts.push(
      <details key={`d${i}`} className="my-1.5 rounded-md border border-border/70 bg-background/60 px-2 py-1">
        <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">{(m[1] ?? "Details").replace(/<[^>]+>/g, "").trim() || "Details"}</summary>
        <div className="pt-1"><Markdown content={m[2].trim()} /></div>
      </details>,
    );
    last = m.index + m[0].length;
    i++;
  }
  if (last < cleaned.length) parts.push(<Markdown key={`t${i}`} content={cleaned.slice(last)} />);
  return <div className={cn(PROSE, className)}>{parts}</div>;
}

function CommentDetails({ header, children }: { header: ReactNode; children: ReactNode }) {
  return <details open className="min-w-0">
    <summary className="cursor-pointer text-xs text-muted-foreground"><span className="inline-flex flex-wrap items-center gap-3 align-middle">{header}</span></summary>
    <div className="pt-3">{children}</div>
  </details>;
}

function ThreadCard({ thread, actions }: { thread: GhThread; actions: Pick<AnnoActions, "reply" | "resolve" | "editComment" | "refreshThreads"> }) {
  const [open, setOpen] = useState(!thread.isResolved && !thread.isOutdated);
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setOpen(!thread.isResolved && !thread.isOutdated); if (thread.isResolved) setReply(null); }, [thread.id, thread.isResolved, thread.isOutdated]);
  const comments = useMemo(() => orderThreadComments(thread.comments), [thread.comments]);
  const first = comments[0]?.comment;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (cause) { toast.error(describeError(cause)); } finally { setBusy(false); }
  };
  return (
    <div className="my-2 min-w-0 rounded-lg border border-border bg-card text-sm">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{first?.author ?? "Review thread"}</span>
          {thread.isResolved ? <span className="text-xs text-muted-foreground">Resolved</span> : null}
          {thread.isOutdated ? <span className="text-xs text-muted-foreground">Earlier version</span> : null}
        </button>
        {first?.url ? <UrlLink href={first.url} className="text-xs text-muted-foreground hover:underline">GitHub</UrlLink> : null}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => actions.resolve(thread.id, !thread.isResolved))}>{thread.isResolved ? "Reopen" : "Resolve"}</Button>
      </div>
      {open ? <>
        <div className="divide-y divide-border border-t border-border">
          {comments.map(({ comment, depth }) => <div key={comment.id} className={cn("px-3 py-3", depth > 0 && "ml-4 border-l-2 border-border")}>
            <CommentDetails header={<><AuthorChip login={comment.author} when={comment.createdAt} />{depth > 0 ? <span>Reply</span> : null}</>}>
              <EditableBody body={comment.body} canEdit={comment.canEdit} label={`comment by ${comment.author}`} renderBody={(body) => <CommentBody body={body} />} onSave={(body, expectedBody) => actions.editComment(comment.id, body, expectedBody)} onCancel={actions.refreshThreads} />
            </CommentDetails>
          </div>)}
        </div>
        {reply === null ? <div className="border-t border-border px-3 py-1"><Button variant="ghost" size="sm" disabled={!first?.databaseId} onClick={() => setReply("")}>Reply</Button></div> : (
          <form className="space-y-2 border-t border-border p-3" onSubmit={(event) => {
            event.preventDefault();
            const commentId = first?.databaseId;
            if (!commentId || reply.trim() === "") return;
            void run(async () => { await actions.reply(commentId, reply.trim()); setReply(null); });
          }}>
            <TextArea value={reply} onChange={setReply} rows={3} placeholder="Reply on GitHub…" autoFocus />
            <div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={() => setReply(null)}>Cancel</Button><Button type="submit" size="sm" disabled={busy || reply.trim() === ""}>Reply</Button></div>
          </form>
        )}
      </> : null}
    </div>
  );
}

function ThreadGroup({ label, threads, actions, onJump }: { label: string; threads: GhThread[]; actions: Pick<AnnoActions, "reply" | "resolve" | "editComment" | "refreshThreads">; onJump?: JumpFn }) {
  if (threads.length === 0) return null;
  return <details className="min-w-0 text-sm">
    <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">{label} threads ({threads.length})</summary>
    <div className="mt-3 space-y-3">
      {threads.map((thread) => {
        const line = thread.isOutdated ? thread.originalLine : thread.line;
        const location = thread.path + (line === null ? "" : ":" + line);
        return <div key={thread.id}>
          {onJump ? <button type="button" className="break-all text-left font-mono text-xs text-muted-foreground hover:underline" onClick={() => onJump(thread.path, thread.isOutdated ? null : thread.line, thread.side === "LEFT" ? "old" : "new")}>{location}</button>
            : <p className="break-all font-mono text-xs text-muted-foreground">{location}</p>}
          <ThreadCard thread={thread} actions={actions} />
        </div>;
      })}
    </div>
  </details>;
}

function PendingCard({ pending, actions }: { pending: PendingComment; actions: AnnoActions }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="my-1.5 rounded-lg border border-dashed border-foreground/40 bg-card font-sans text-xs shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="font-medium">Pending comment</span>
        {pending.stale ? (
          <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground" title="This line is gone from the current diff">stale</span>
        ) : null}
        <span className="ml-auto flex gap-1">
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setEditing((e) => (e === null ? pending.body : null))}>Edit</Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-destructive" onClick={() => void actions.deletePending(pending.id)}>Delete</Button>
        </span>
      </div>
      {editing === null ? (
        <CommentBody body={pending.body} className="px-3 py-2" />
      ) : (
        <form className="flex flex-col gap-1.5 px-3 py-2" onSubmit={async (e: FormEvent) => { e.preventDefault(); if (editing.trim() === "") return; await actions.updatePending(pending.id, editing.trim()); setEditing(null); }}>
          <TextArea value={editing} onChange={setEditing} rows={4} autoFocus />
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="submit" size="sm" className="h-7">Save</Button>
          </div>
        </form>
      )}
    </div>
  );
}

function ComposerCard({ anno, actions }: { anno: Extract<Anno, { kind: "composer" }>; actions: AnnoActions }) {
  const [body, setBody] = useState(anno.initial);
  const [busy, setBusy] = useState(false);
  const [isPrivate, setPrivate] = useState(false);
  const input = () => ({ path: anno.path, line: anno.line, startLine: anno.startLine, side: anno.side, body: body.trim() });
  return (
    <form className={cn("my-1.5 flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2 font-sans text-xs shadow-sm", isPrivate ? "border-dashed border-amber-500/60" : "border-foreground/50")} onSubmit={async (e: FormEvent) => { e.preventDefault(); if (body.trim() === "") return; setBusy(true); try { await (isPrivate ? actions.savePrivate(input()) : actions.savePending(input())); actions.closeComposer(); } catch (cause) { toast.error(describeError(cause)); } finally { setBusy(false); } }}>
      <div className="text-muted-foreground">
        {isPrivate ? "Private note" : "Comment"} on line{anno.startLine !== null && anno.startLine !== anno.line ? `s ${anno.startLine}–${anno.line}` : ` ${anno.line}`} ({anno.side === "LEFT" ? "base" : "head"}).{" "}
        {isPrivate ? "Only you see it here, until you promote it." : "Stays pending until you submit the review."}
      </div>
      <TextArea value={body} onChange={setBody} rows={4} placeholder={isPrivate ? "Note to self (Markdown)…" : "Write the comment (Markdown)…"} autoFocus />
      <div className="flex flex-wrap items-center gap-1.5">
        <label className="inline-flex items-center gap-1.5 text-muted-foreground"><input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} />Keep private</label>
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={actions.closeComposer}>Cancel</Button>
        <Button type="submit" size="sm" className="h-7" disabled={busy || body.trim() === ""}>{isPrivate ? "Add note" : "Add to review"}</Button>
      </div>
    </form>
  );
}

function Annotation({ anno, actions }: { anno: Anno; actions: AnnoActions }) {
  // The wrapper undoes the diff container's monospace + pre inheritance for everything inside.
  const card = (() => {
    switch (anno.kind) {
      case "thread": return <ThreadCard thread={anno.thread} actions={actions} />;
      case "pending": return <PendingCard pending={anno.pending} actions={actions} />;
      case "note": return <NoteCard note={anno.note} actions={actions} />;
      case "composer": return <ComposerCard anno={anno} actions={actions} />;
    }
  })();
  return <div className="min-w-0 max-w-full whitespace-normal font-sans [tab-size:4]">{card}</div>;
}

// ---------------------------------------------------------------------------
// File card
// ---------------------------------------------------------------------------

interface Selection {
  path: string;
  range: SelectedLineRange;
}

/** Where a file card's diff comes from: the PR (base..head) or an arbitrary commit range. */
type DiffSource = { kind: "pr" } | { kind: "range"; base: string; head: string };

interface FileCardProps {
  review: Review;
  file: FileEntry;
  source?: DiffSource;
  threads: GhThread[];
  pending: PendingComment[];
  notes: Note[];
  composer: Extract<Anno, { kind: "composer" }> | null;
  selection: Selection | null;
  onSelect(selection: Selection | null): void;
  onOpenComposer(path: string, range: SelectedLineRange): void;
  diffStyle: "unified" | "split";
  theme: { dark: string; light: string; mode: "dark" | "light" };
  actions: AnnoActions;
  rpc: ReturnType<typeof useRpc<Contract>>;
}

function FileCard({ review, file, source = { kind: "pr" }, threads, pending, notes, composer, selection, onSelect, onOpenComposer, diffStyle, theme, actions, rpc }: FileCardProps) {
  const inCommit = source.kind === "range";
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"source" | "rendered">("source");
  const [contents, setContents] = useState<{ oldContent: string; newContent: string } | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [sourceLine, setSourceLine] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const markdown = /\.(md|markdown)$/i.test(file.path) && !file.binary;
  const base = source.kind === "range" ? source.base : null;
  const head = source.kind === "range" ? source.head : review.headSha;
  useEffect(() => {
    setPatch(null);
    setError(null);
    if (file.binary) return;
    let cancelled = false;
    const request = base === null
      ? rpc.call("review_patch", { reviewId: review.id, path: file.path })
      : rpc.call("commit_patch", { reviewId: review.id, base, head, path: file.path, oldPath: file.oldPath });
    request.then((result) => { if (!cancelled) setPatch(result.patch); }, (cause: unknown) => { if (!cancelled) setError(describeError(cause)); });
    return () => { cancelled = true; };
  }, [file.binary, file.path, file.oldPath, review.id, review.baseSha, rpc, base, head]);
  const fileDiff = useMemo(() => patch === null ? null : pickFileDiff(patch, file.path, file.oldPath), [patch, file.path, file.oldPath]);
  const outdatedThreads = threads.filter((thread) => thread.isOutdated);
  const resolvedThreads = threads.filter((thread) => thread.isResolved && !thread.isOutdated);
  const annotations = useMemo(() => {
    const comments: CommentAnchor<Anno>[] = [
      ...threads.filter((thread) => !thread.isOutdated && !thread.isResolved).map((thread): CommentAnchor<Anno> => ({ side: thread.side, line: thread.line, detached: thread.subjectType === "FILE", metadata: { kind: "thread", thread } })),
      ...pending.map((pending): CommentAnchor<Anno> => ({ side: pending.side, line: pending.line, detached: pending.stale, metadata: { kind: "pending", pending } })),
      ...notes.map((note): CommentAnchor<Anno> => ({ side: note.side, line: note.line, detached: note.state === "stale", metadata: { kind: "note", note } })),
    ];
    if (composer) comments.push({ side: composer.side, line: composer.line, metadata: composer });
    return placeAnnotations(fileDiff, comments);
  }, [fileDiff, threads, pending, notes, composer]);
  const selected = selection?.path === file.path ? selection.range : null;
  const loadContents = useCallback(async () => {
    const [oldSide, newSide] = await Promise.all([
      rpc.call("commit_file", { reviewId: review.id, sha: base ?? review.baseSha, path: file.oldPath ?? file.path }),
      rpc.call("commit_file", { reviewId: review.id, sha: head, path: file.path }),
    ]);
    return { oldContent: oldSide.content ?? "", newContent: newSide.content ?? "" };
  }, [rpc, review.id, review.baseSha, file.path, file.oldPath, base, head]);
  const loadDiffFiles = useCallback(async (meta: FileDiffMetadata) => {
    const { oldContent, newContent } = await loadContents();
    return { oldFile: { name: meta.prevName ?? meta.name, contents: oldContent }, newFile: { name: meta.name, contents: newContent } };
  }, [loadContents]);
  useEffect(() => {
    setContents(null);
    setContentError(null);
    if (!markdown || mode !== "rendered") return;
    let cancelled = false;
    loadContents().then((result) => { if (!cancelled) setContents(result); }, (cause: unknown) => { if (!cancelled) setContentError(describeError(cause)); });
    return () => { cancelled = true; };
  }, [loadContents, markdown, mode]);
  useEffect(() => {
    if (mode !== "source" || sourceLine === null) return;
    let cancel: (() => void) | undefined;
    const timer = window.setTimeout(() => { cancel = settleDiffLine(ref.current?.parentElement ?? null, file.path, sourceLine); }, 250);
    return () => { window.clearTimeout(timer); cancel?.(); };
  }, [mode, sourceLine, file.path]);
  return <div ref={ref} data-review-file={file.path} className="min-w-0 scroll-mt-3 rounded-lg border border-border bg-card">
    {markdown ? <div className="flex items-center gap-1 border-b border-border px-3 py-2" role="group" aria-label="Markdown diff view">
      {(["source", "rendered"] as const).map((view) => <Button key={view} type="button" variant={mode === view ? "outline" : "ghost"} size="sm" className="h-7 text-xs" aria-pressed={mode === view} onClick={() => setMode(view)}>{view === "source" ? "Source" : "Rendered"}</Button>)}
    </div> : null}
    {selected ? <div className="flex items-center gap-3 border-b border-border px-3 py-2 text-xs">
      <span className="font-mono text-muted-foreground">Line {Math.min(selected.start, selected.end)}{selected.start !== selected.end ? "–" + Math.max(selected.start, selected.end) : ""}</span>
      <Button type="button" size="sm" onClick={() => onOpenComposer(file.path, selected)}>{inCommit ? "Comment at head" : "Comment"}</Button>
      <button type="button" className="ml-auto p-1 text-muted-foreground" onClick={() => onSelect(null)} aria-label="Clear selection"><Icon name="X" className="size-4" /></button>
    </div> : null}
    {annotations.detached.length > 0 || outdatedThreads.length > 0 || resolvedThreads.length > 0 ? <div className="space-y-3 border-b border-border p-3">
      {annotations.detached.map((anno, index) => <div key={annotationKey(anno, index)}>
        <p className="text-xs text-muted-foreground">{annotationLocation(anno)}</p>
        <Annotation anno={anno} actions={actions} />
      </div>)}
      <ThreadGroup label="Resolved" threads={resolvedThreads} actions={actions} />
      <ThreadGroup label="Outdated" threads={outdatedThreads} actions={actions} />
    </div> : null}
    {file.binary ? <p className="p-3 text-sm text-muted-foreground">Binary file.</p>
      : markdown && mode === "rendered" ? contentError !== null ? <p role="alert" className="p-3 text-sm text-destructive">{contentError}</p>
        : contents === null ? <p className="p-3 text-sm text-muted-foreground">Loading rendered diff…</p>
        : <MarkdownDiff {...contents} diffStyle={diffStyle} className={PROSE} onSource={(side, block) => { setMode("source"); setSourceLine(block.startLine); onSelect({ path: file.path, range: { start: block.startLine, end: block.endLine, side } }); }} />
      : error ? <p role="alert" className="p-3 text-sm text-destructive">{error}</p>
      : patch === null ? <p className="p-3 text-sm text-muted-foreground">Loading diff…</p>
      : fileDiff === null ? <p className="p-3 text-sm text-muted-foreground">No textual diff.</p>
      : <FileDiff<Anno[]>
          fileDiff={fileDiff}
          options={{ diffStyle, theme: { dark: theme.dark, light: theme.light }, themeType: theme.mode,
            disableFileHeader: true, enableLineSelection: true, controlledSelection: true,
            lineHoverHighlight: "both", enableGutterUtility: true,
            onLineSelected: (range) => onSelect(range === null ? null : { path: file.path, range }),
            onGutterUtilityClick: (range) => onOpenComposer(file.path, range),
            loadDiffFiles, hunkSeparators: "line-info", overflow: "scroll" }}
          selectedLines={selected}
          lineAnnotations={annotations.inline}
          renderAnnotation={(annotation) => <div className="w-full min-w-0 whitespace-normal px-3 py-1 font-sans">
            {annotation.metadata.map((anno, index) => <Annotation key={annotationKey(anno, index)} anno={anno} actions={actions} />)}
          </div>}
        />}
  </div>;
}

function annotationKey(anno: Anno, index: number): string {
  return anno.kind === "thread" ? anno.thread.id : anno.kind === "pending" ? anno.pending.id : anno.kind === "note" ? anno.note.id : "composer-" + index;
}

function annotationLocation(anno: Anno): string {
  if (anno.kind === "thread") {
    const thread = anno.thread;
    if (thread.subjectType === "FILE") return "File comment";
    const line = thread.isOutdated ? thread.originalLine : thread.line;
    return (thread.isOutdated ? "Earlier version" : "Outside the displayed changes") + (line === null ? "" : " — line " + line);
  }
  const entry = anno.kind === "pending" ? anno.pending : anno.kind === "note" ? anno.note : anno;
  return "Outside the displayed changes — line " + entry.line;
}

// ---------------------------------------------------------------------------
// Review page
// ---------------------------------------------------------------------------

function Description({ reviewId, body }: { reviewId: string; body: string }) {
  const rpc = useRpc<Contract>();
  const [description, setDescription] = useState<{ body: string; canEdit: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    rpc.call("review_description", { reviewId }).then(
      (result) => { if (!cancelled) setDescription(result); },
      (cause: unknown) => { if (!cancelled) setError(describeError(cause)); },
    );
    return () => { cancelled = true; };
  }, [rpc, reviewId, body, revision]);
  return <div>
    {error !== null ? <div role="alert" className="mb-2 flex items-center gap-2 text-xs text-destructive">{error}<Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setRevision((value) => value + 1)}>Retry</Button></div> : null}
    <EditableBody body={description?.body ?? body} canEdit={description?.canEdit ?? false} label="PR description" allowEmpty renderBody={(content) => <DescriptionPreview body={content} />} onCancel={() => setRevision((value) => value + 1)} onSave={async (content, expectedBody) => {
      const result = await rpc.call("review_edit_body", { reviewId, target: { kind: "description" }, body: content, expectedBody });
      setDescription((current) => current === null ? null : { ...current, body: result.body });
      toast.success("Description updated");
      return result;
    }} />
  </div>;
}

function DescriptionPreview({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    setOverflowing(el.scrollHeight > el.clientHeight + 8);
  }, [body]);
  if (body.trim() === "") return <p className="text-sm text-muted-foreground">No description.</p>;
  return (
    <div>
      <div ref={ref} className={cn("relative text-sm", !open && "max-h-72 overflow-hidden")}>
        <Markdown content={body} />
        {!open && overflowing ? <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent" /> : null}
      </div>
      {overflowing || open ? (
        <div className="mt-2 flex justify-center">
          <Button variant="outline" size="sm" className="h-7 rounded-full text-xs" onClick={() => setOpen((v) => !v)}>
            {open ? "Show less" : "Read more"}<Icon name={open ? "ChevronUp" : "ChevronDown"} className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Discussion({ reviewId, threads, onJump, onRefresh }: { reviewId: string; threads: GhThread[]; onJump: JumpFn; onRefresh(): void }) {
  const rpc = useRpc<Contract>();
  const [conversation, setConversation] = useState<{ comments: GhIssueComment[]; reviews: GhReview[]; events?: GhEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback((refresh = false) => {
    const request = ++generation.current;
    rpc.call("review_conversation", { reviewId, refresh }).then(
      (result) => { if (request === generation.current) { setConversation(result); setError(null); } },
      (cause: unknown) => { if (request === generation.current) setError(describeError(cause)); },
    );
  }, [rpc, reviewId]);
  useEffect(() => { load(); return () => { generation.current++; }; }, [load]);
  useRealtime(REVIEW_CHANGED, (payload) => { if (payloadReview(payload)?.reviewId === reviewId) load(); });
  const actions = {
    editComment: async (id: string, body: string, expectedBody: string) => { const result = await rpc.call("review_edit_body", { reviewId, target: { kind: "inline", id }, body, expectedBody }); onRefresh(); toast.success("Comment updated"); return result; },
    refreshThreads: () => { void rpc.call("review_threads_refresh", { reviewId }).then(onRefresh, (cause: unknown) => toast.error(describeError(cause))); },
    reply: async (commentId: number, body: string) => { await rpc.call("thread_reply", { reviewId, commentId, body }); onRefresh(); },
    resolve: async (threadId: string, resolve: boolean) => { await rpc.call("thread_resolve", { reviewId, threadId, resolve }); onRefresh(); },
  };
  if (error !== null) return <p role="alert" className="text-sm text-destructive">{error} <button type="button" className="underline" onClick={() => load(true)}>Retry</button></p>;
  if (conversation === null) return <EmptyState>Loading conversation…</EmptyState>;
  const outdatedThreads = threads.filter((thread) => thread.isOutdated);
  const resolvedThreads = threads.filter((thread) => thread.isResolved && !thread.isOutdated);
  type Item = { key: string; when: string; author: string; body: string; state?: string; url: string; thread?: GhThread; event?: string; target?: { kind: "review" | "comment"; id: string }; canEdit?: boolean };
  const items: Item[] = [
    ...conversation.reviews.map((r) => ({ key: "review-" + r.id, author: r.author, when: r.submittedAt ?? "", body: r.body, state: r.state, url: r.url, canEdit: r.canEdit, target: r.nodeId ? { kind: "review" as const, id: r.nodeId } : undefined })),
    ...conversation.comments.map((c) => ({ key: "comment-" + c.id, author: c.author, when: c.createdAt, body: c.body, url: c.url, canEdit: c.canEdit, target: c.nodeId ? { kind: "comment" as const, id: c.nodeId } : undefined })),
    ...threads.filter((thread) => !thread.isOutdated && !thread.isResolved).map((thread) => ({ key: "thread-" + thread.id, author: "", when: orderThreadComments(thread.comments)[0]?.comment.createdAt ?? "", body: "", url: "", thread })),
    ...(conversation.events ?? []).map((event) => ({ key: "event-" + event.id, author: event.actor ?? "", when: event.createdAt ?? "", body: event.details, url: event.url ?? "", event: event.event })),
  ];
  items.sort((a, b) => (Date.parse(a.when) || 0) - (Date.parse(b.when) || 0));
  return <div className="space-y-5">
    {items.length === 0 && threads.length === 0 ? <EmptyState>No conversation yet.</EmptyState> : null}
    {items.map((item) => item.thread ? <div key={item.key}>
      <button type="button" className="break-all text-left font-mono text-xs text-muted-foreground hover:underline" onClick={() => onJump(item.thread!.path, item.thread!.isOutdated ? null : item.thread!.line, item.thread!.side === "LEFT" ? "old" : "new")}>{item.thread.path}{item.thread.line !== null ? ":" + item.thread.line : ""}</button>
      <ThreadCard thread={item.thread} actions={actions} />
    </div> : item.event ? <div key={item.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {item.author ? <span className="font-medium text-foreground">{item.author}</span> : null}
      <span className="min-w-0 whitespace-pre-wrap break-words">{item.event.replace(/_/g, " ")}{item.body ? ": " + item.body : ""}</span>
      {item.when ? <time dateTime={item.when} className="ml-auto shrink-0">{timeAgo(item.when)}</time> : null}
      {item.url ? <UrlLink href={item.url} className="hover:underline">GitHub</UrlLink> : null}
    </div> : <article key={item.key} className="border-b border-border pb-5 last:border-0">
      <CommentDetails header={<>
        <AuthorChip login={item.author} when={item.when} />
        {item.state ? <span className={cn("text-xs", reviewStateTone(item.state))}>{item.state.replace(/_/g, " ").toLowerCase()}</span> : null}
        <UrlLink href={item.url} className="text-muted-foreground hover:underline">GitHub</UrlLink>
      </>}>
      <EditableBody body={item.body} canEdit={Boolean(item.canEdit && item.target)} label={`comment by ${item.author}`} renderBody={(body) => <CommentBody body={body} />} onCancel={() => load(true)} onSave={async (body, expectedBody) => {
        const result = await rpc.call("review_edit_body", { reviewId, target: item.target!, body, expectedBody });
        setConversation((current) => current === null ? null : { ...current, comments: current.comments.map((comment) => comment.nodeId === item.target?.id ? { ...comment, body: result.body } : comment), reviews: current.reviews.map((review) => review.nodeId === item.target?.id ? { ...review, body: result.body } : review) });
        toast.success("Comment updated"); return result;
      }} />
      </CommentDetails>
    </article>)}
    <ThreadGroup label="Resolved" threads={resolvedThreads} actions={actions} onJump={onJump} />
    <ThreadGroup label="Outdated" threads={outdatedThreads} actions={actions} onJump={onJump} />
  </div>;
}

/** The commit last opened per review; a later shift-click diffs from it. Survives leaving and returning to the tab. */
const lastCommitOpened = new Map<string, string>();

function Commits({ review, seen, onOpen }: { review: Review; seen: { prevHead: string | null; seenHead: string | null }; onOpen: (target: CommitTarget) => void }) {
  const [anchor, setAnchorState] = useState<string | null>(() => lastCommitOpened.get(review.id) ?? null);
  const setAnchor = (sha: string) => {
    lastCommitOpened.set(review.id, sha);
    setAnchorState(sha);
  };
  if (review.commits.length === 0) return <p className="text-sm text-muted-foreground">No commits.</p>;
  const ordered = review.commits; // oldest first, as GitHub lists them
  const prevIndex = seen.prevHead === null ? -1 : ordered.findIndex((c) => c.sha === seen.prevHead);
  const newCount = prevIndex === -1 ? 0 : ordered.length - 1 - prevIndex;
  const click = (sha: string, shift: boolean) => {
    if (shift && anchor !== null && anchor !== sha) {
      const a = ordered.findIndex((c) => c.sha === anchor);
      const b = ordered.findIndex((c) => c.sha === sha);
      const [from, to] = a < b ? [anchor, sha] : [sha, anchor];
      onOpen({ from, to, inclusive: true });
      return;
    }
    setAnchor(sha);
    onOpen({ to: sha, from: null, inclusive: false });
  };
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Shift-click to compare a range.</span>
        {newCount > 0 && seen.prevHead !== null ? (
          <Button variant="outline" size="sm" className="ml-auto h-6 text-xs" onClick={() => onOpen({ from: ordered[prevIndex + 1].sha, to: ordered[ordered.length - 1].sha, inclusive: true })}>
            Review {newCount} new commit{newCount === 1 ? "" : "s"}
          </Button>
        ) : seen.prevHead !== null && prevIndex === -1 ? <span className="ml-auto">History was rewritten since you last looked; the old head is not in this list.</span> : null}
      </div>
      <ul className="divide-y divide-border/60 rounded-lg border border-border">
        {[...ordered].reverse().map((c, i) => {
          const index = ordered.length - 1 - i;
          const isNew = prevIndex !== -1 && index > prevIndex;
          return (
            <li key={c.sha}>
              {prevIndex !== -1 && index === prevIndex && newCount > 0 ? (
                <div className="flex items-center gap-2 bg-primary/5 px-3 py-1 text-[11px] text-primary"><span className="h-px flex-1 bg-primary/40" />you last looked here<span className="h-px flex-1 bg-primary/40" /></div>
              ) : null}
              <button type="button" onClick={(e) => click(c.sha, e.shiftKey)} className={cn("flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-state-hover", anchor === c.sha && "bg-state-active")} title="Open this commit's diff">
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{shortSha(c.sha)}</span>
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                {isNew ? <span className="shrink-0 rounded-full border border-primary/40 bg-primary/10 px-1.5 text-[10px] text-primary">new</span> : null}
                <span className="shrink-0 text-xs text-muted-foreground"><span>{c.author}</span><span className="ml-3">{timeAgo(c.date)}</span></span>
                <UrlLink href={`${review.url.replace(/\/pull\/\d+$/, "")}/commit/${c.sha}`} className="shrink-0 text-muted-foreground hover:text-foreground" title="Open on GitHub" onClick={(e) => e.stopPropagation()}><Icon name="ExternalLink" className="size-3.5" /></UrlLink>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commit view: one commit or a range of the PR as a diff, read-only. Comments, threads, and notes belong to the
// PR head diff and are not shown here.
// ---------------------------------------------------------------------------

interface CommitData {
  base: string;
  head: string;
  info: CommitInfo;
  commits: CommitInfo[];
  files: ChangedFile[];
}

function CommitView({ reviewId, review, target, rpc, onNavigate, onOpenDiff }: {
  reviewId: string;
  review: Review;
  target: CommitTarget;
  rpc: ReturnType<typeof useRpc<Contract>>;
  onNavigate(target: CommitTarget | null): void;
  onOpenDiff(): void;
}) {
  const [data, setData] = useState<CommitData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMessage, setShowMessage] = useState(false);
  const key = commitPath(reviewId, target);
  useEffect(() => {
    setData(null);
    setError(null);
    let cancelled = false;
    rpc.call("commit_get", { reviewId, to: target.to, ...(target.from === null ? {} : { from: target.from, inclusive: target.inclusive }) }).then(
      (result) => { if (!cancelled) setData(result); },
      (cause: unknown) => { if (!cancelled) setError(describeError(cause)); },
    );
    return () => { cancelled = true; };
  }, [rpc, reviewId, key, target.to, target.from, target.inclusive]);

  if (error) return <div className="p-6"><p role="alert" className="text-sm text-destructive">{error}</p></div>;
  if (data === null) return <div className="p-6"><EmptyState>Loading commit…</EmptyState></div>;

  const list = review.commits;
  const index = list.findIndex((c) => c.sha === data.head);
  const single = target.from === null;
  const prev = single && index > 0 ? list[index - 1] : null;
  const next = single && index !== -1 && index < list.length - 1 ? list[index + 1] : null;
  const additions = data.files.reduce((n, f) => n + f.additions, 0);
  const deletions = data.files.reduce((n, f) => n + f.deletions, 0);
  const repoUrl = review.url.replace(/\/pull\/\d+$/, "");

  return (
    <div className="mx-auto w-full max-w-5xl px-6 pb-16 pt-6">
      <button type="button" onClick={() => onNavigate(null)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><Icon name="ChevronLeft" className="size-3.5" />Back to the pull request</button>
      <Button variant="outline" size="sm" className="ml-3" onClick={onOpenDiff}>View changes</Button>
      <div className="mt-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {single ? (
            <span className="rounded-md border border-border bg-background px-1.5 py-0.5 font-mono">{shortSha(data.head)}</span>
          ) : (
            <span className="rounded-md border border-border bg-background px-1.5 py-0.5 font-mono" title={`diff ${data.base.slice(0, 10)}..${data.head.slice(0, 10)}`}>{shortSha(target.from ?? data.base)}..{shortSha(data.head)}</span>
          )}
          {single && index !== -1 ? <span className="text-muted-foreground">commit {index + 1} of {list.length}</span> : <span className="text-muted-foreground">{data.commits.length} commit{data.commits.length === 1 ? "" : "s"}</span>}
          <span className="text-muted-foreground">{data.files.length} files <span className="text-primary">+{additions}</span> <span className="text-destructive">-{deletions}</span></span>
          <span className="ml-auto flex items-center gap-1">
            {single ? (
              <>
                <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={prev === null} onClick={() => prev && onNavigate({ to: prev.sha, from: null, inclusive: false })} title="Older commit"><Icon name="ChevronLeft" className="size-3.5" />Older</Button>
                <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={next === null} onClick={() => next && onNavigate({ to: next.sha, from: null, inclusive: false })} title="Newer commit">Newer<Icon name="ChevronRight" className="size-3.5" /></Button>
              </>
            ) : null}
            <UrlLink href={single ? `${repoUrl}/commit/${data.head}` : `${repoUrl}/compare/${data.base}...${data.head}`} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground"><Icon name="ExternalLink" className="size-3.5" />GitHub</UrlLink>
          </span>
        </div>
        <h2 className="mt-2 text-lg font-semibold leading-tight">{single ? data.info.title : `${data.commits.length} commits`}</h2>
        {single ? (
          <>
            <div className="mt-1 text-xs text-muted-foreground">{data.info.author} {timeAgo(data.info.date)}{data.info.parents.length > 1 ? " merge commit, diffed against its first parent" : ""}</div>
            {data.info.body ? (
              <div className="mt-2">
                <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowMessage((v) => !v)}>{showMessage ? "Hide message" : "Read the full message"}</button>
                {showMessage ? <div className={cn(PROSE, "mt-1 rounded-md border border-border/60 bg-background/60 p-3 text-sm")}><Markdown content={data.info.body} /></div> : null}
              </div>
            ) : null}
          </>
        ) : (
          <ul className="mt-2 divide-y divide-border/60 rounded-md border border-border/60 text-xs">
            {[...data.commits].reverse().map((c) => (
              <li key={c.sha} className="flex items-center gap-3 px-3 py-1.5">
                <button type="button" onClick={() => onNavigate({ to: c.sha, from: null, inclusive: false })} className="shrink-0 font-mono text-muted-foreground hover:underline">{shortSha(c.sha)}</button>
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                <span className="shrink-0 text-muted-foreground">{c.author} {timeAgo(c.date)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

type JumpFn = (path: string, line: number | null, side: "old" | "new") => void;

function StackSelector({ review, stack, narrow, opening, onOpen, onClose }: {
  review: Review;
  stack: StackView;
  narrow: boolean;
  onClose(): void;
  opening: number | null;
  onOpen(entry: StackView["entries"][number]): void;
}) {
  const currentButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { currentButton.current?.scrollIntoView({ block: "nearest" }); }, [review.number, stack.entries.length]);
  return <aside aria-label="Pull request stack" className={cn("flex min-h-0 w-52 shrink-0 flex-col border-r border-border bg-card", narrow && "absolute inset-y-0 left-0 z-40 shadow-lg")}>
    <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3 text-xs" title={`Base branch: ${stack.baseRefName}`}>
      <h2 className="font-medium">Stack{stack.number === null ? "" : " #" + stack.number}</h2>
      <Button variant="ghost" size="sm" className="h-6 w-6 px-0" aria-label="Hide stack sidebar" onClick={onClose}><Icon name="X" className="size-3.5" /></Button>
    </div>
    <div className="border-b border-border px-3 py-2"><DiffStat {...diffStats(stack.entries)} /></div>
    <nav aria-label="Pull requests in stack" className="min-h-0 flex-1 overflow-y-auto p-1.5">
      <ol className="space-y-1">{stack.entries.map((entry) => {
        const current = entry.number === review.number;
        return <li key={entry.number}>
          <button ref={current ? currentButton : undefined} type="button" disabled={opening !== null}
            aria-current={current ? "page" : undefined}
            onClick={() => { if (!current) onOpen(entry); }}
            className={cn("flex w-full items-start gap-2 rounded-md px-2 py-2.5 text-left text-xs", current ? "bg-state-active" : "hover:bg-state-hover", (entry.merged || entry.state !== "OPEN") && !current && "text-muted-foreground")}
            title={entry.title}>
            <span className="mt-0.5 shrink-0">{opening === entry.number ? <Icon name="Loading" className="size-3.5 animate-spin" aria-label="Opening pull request" /> : <PrMark state={entry.state} reviewDecision={entry.reviewDecision} isDraft={entry.isDraft} merged={entry.merged} />}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="font-mono text-muted-foreground">#{entry.number}</span>
              </span>
              <span className="mt-0.5 line-clamp-2 break-words leading-relaxed">{entry.title}</span>
              <DiffStat additions={entry.additions} deletions={entry.deletions} />
            </span>
            <CountBadge count={entry.pendingCount} title={`${entry.pendingCount} pending comments`} />
          </button>
        </li>;
      })}</ol>
    </nav>
  </aside>;
}

type Tab = "conversation" | "commits" | "changes";

function ReviewView({ reviewId, commit }: { reviewId: string; commit: CommitTarget | null }) {
  const { rpc, detail, error, refetch } = useReview(reviewId);
  const navigate = useBbNavigate();
  const [tab, setTab] = useState<Tab>(commit ? "commits" : "changes");
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const narrowStack = useNarrow(container, 960);
  const stackSidebar = useSidebar(STACK_KEY, narrowStack);
  const [diffJump, setDiffJump] = useState<DiffJump | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewOpened, setReviewOpened] = useState(false);
  const reviewDialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [openingSlice, setOpeningSlice] = useState<number | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); refetch(); } catch (cause) { toast.error(describeError(cause)); } finally { setBusy(false); }
  };
  useEffect(() => { rpc.call("review_seen", { reviewId }).then(refetch, () => undefined); }, [rpc, reviewId, refetch]);
  useEffect(() => {
    if (error === "closed" || error === "removed") navigate.toPluginPanel(PANEL_PATH);
  }, [error, navigate]);
  useEffect(() => {
    const dialog = reviewDialog.current;
    if (!dialog) return;
    if (reviewOpen && !dialog.open) dialog.showModal();
    else if (!reviewOpen && dialog.open) dialog.close();
  }, [reviewOpen]);
  const openStackEntry = useCallback(async (entry: StackView["entries"][number]) => {
    if (detail === null || openingSlice !== null || entry.number === detail.review.number) return;
    setOpeningSlice(entry.number);
    try { await openSlice(rpc, navigate, detail.review.owner, detail.review.repo, entry); }
    catch (cause) { toast.error(describeError(cause)); }
    finally { setOpeningSlice(null); }
  }, [detail, rpc, navigate, openingSlice]);
  useEffect(() => {
    const stack = detail?.stack;
    if (!stack || reviewOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (!["[", "]"].includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const next = stack.entries.find((entry) => entry.position === stack.currentPosition + (event.key === "[" ? -1 : 1));
      if (next) { event.preventDefault(); void openStackEntry(next); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail?.stack, openStackEntry, reviewOpen]);
  const openCommit = (target: CommitTarget | null) => {
    setTab("commits");
    navigate.toPluginPanel(PANEL_PATH, { subPath: target === null ? reviewId : commitPath(reviewId, target) });
  };
  const openPrDiff = (jump?: DiffJump) => {
    if (commit) navigate.toPluginPanel(PANEL_PATH, { subPath: reviewId });
    setTab("changes");
    setDiffJump(jump ?? null);
    setReviewOpen(false);
  };
  if (detail === null) return <div className="p-6">{error === null ? <EmptyState>Loading review…</EmptyState> : <div role="alert" className="space-y-3 text-sm">
    <p className="text-destructive">{error}</p><Button variant="outline" size="sm" onClick={refetch}>Retry</Button>
  </div>}</div>;
  const { review, threads, pending, stack } = detail;
  const diffProps = { detail, rpc, refetch, commit, onOpenPrDiff: openPrDiff };
  const content = <div className="flex h-full min-h-0 flex-col">
    <div className={cn("min-h-0 flex-1", tab !== "changes" && "hidden")}>
      <DiffPane {...diffProps} jump={diffJump} />
    </div>
    {tab !== "changes" ? <div className="min-h-0 flex-1 overflow-y-auto">
      {tab === "commits" && commit ? <CommitView reviewId={reviewId} review={review} target={commit} rpc={rpc} onNavigate={openCommit} onOpenDiff={() => setTab("changes")} /> : <div className="mx-auto max-w-4xl space-y-6 px-5 py-6">
        {tab === "commits" ? <Commits review={review} seen={detail.seen} onOpen={openCommit} /> : <>
          <section className="border-b border-border pb-6"><Description key={reviewId} reviewId={reviewId} body={review.body} /></section>
          <Discussion reviewId={reviewId} threads={threads} onRefresh={refetch} onJump={(path, line, side) => openPrDiff({ path, line, side })} />
        </>}
      </div>}
    </div> : null}
  </div>;
  return <div ref={setContainer} aria-label="Pull request review" className="flex h-full min-h-0 flex-col">
    <header className="shrink-0 space-y-3 border-b border-border px-5 py-4">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => navigate.toPluginPanel(PANEL_PATH)}><Icon name="ChevronLeft" className="size-3.5" />Reviews</button>
        <span className="text-muted-foreground">{review.owner}/{review.repo} #{review.number}</span>
        <StatePill state={review.state} reviewDecision={review.reviewDecision} isDraft={review.isDraft} />
        <DiffStat additions={review.additions} deletions={review.deletions} />
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={() => { setReviewOpened(true); setReviewOpen(true); }}>Submit review{pending.length > 0 ? " (" + pending.length + ")" : ""}</Button>
          <details className="relative">
            <summary className="flex cursor-pointer list-none rounded p-2 hover:bg-state-hover" aria-label="Review actions"><Icon name="MoreHorizontal" className="size-4" /></summary>
            <div className="absolute right-0 z-30 mt-2 w-48 rounded-md border border-border bg-card p-1 shadow-lg">
              <button type="button" disabled={busy} className="w-full rounded px-3 py-2 text-left hover:bg-state-hover" onClick={() => void run(() => rpc.call("reviews_sync", { reviewId }))}>Refresh from GitHub</button>
              <button type="button" disabled={busy} className="w-full rounded px-3 py-2 text-left hover:bg-state-hover" onClick={() => void run(() => rpc.call("review_set_draft", { reviewId, draft: !review.isDraft }))}>{review.isDraft ? "Mark ready" : "Convert to draft"}</button>
              <button type="button" disabled={busy} className="w-full rounded px-3 py-2 text-left text-destructive hover:bg-state-hover" onClick={() => { if (confirmRemoveReview(stack !== null)) void run(async () => { await rpc.call("reviews_remove", { reviewId }); navigate.toPluginPanel(PANEL_PATH); }); }}>{stack ? "Remove stack" : "Remove review"}</button>
            </div>
          </details>
        </div>
      </div>
      <h1 className="text-xl font-semibold leading-tight"><UrlLink href={review.url} className="hover:underline">{review.title}</UrlLink></h1>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {review.author ? <span>{review.author}</span> : null}
        <span className="font-mono">{review.headRefName} → {review.baseRefName}</span>
      </div>
      <nav className="flex flex-wrap items-center gap-1" aria-label="Pull request">
        {stack ? <Button variant={stackSidebar.open ? "secondary" : "ghost"} size="sm" aria-label={stackSidebar.open ? "Hide stack sidebar" : "Show stack sidebar"} aria-pressed={stackSidebar.open} onClick={stackSidebar.toggle}><Icon name="Layers" className="size-3.5" />Stack</Button> : null}
        <Button variant={tab === "conversation" ? "secondary" : "ghost"} size="sm" onClick={() => setTab("conversation")}>Conversation</Button>
        <Button variant={tab === "changes" ? "secondary" : "ghost"} size="sm" onClick={() => setTab("changes")}>Changes</Button>
        <Button variant={tab === "commits" ? "secondary" : "ghost"} size="sm" onClick={() => setTab("commits")}>Commits</Button>
      </nav>
    </header>
    {error ? <div role="alert" className="flex items-center gap-3 border-b border-border px-4 py-3 text-sm">
      <span className="min-w-0 flex-1 break-words">Couldn’t refresh this review: {error}</span>
      <Button variant="outline" size="sm" onClick={refetch}>Retry</Button>
    </div> : <SyncNotice reviewId={reviewId} message={detail.syncError} onRefresh={refetch} />}
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {stack && stackSidebar.open ? <>
        {narrowStack ? <button type="button" className="absolute inset-0 z-30 bg-background/60" aria-label="Close stack sidebar" onClick={() => stackSidebar.setOpen(false)} /> : null}
        <StackSelector review={review} stack={stack} narrow={narrowStack} opening={openingSlice} onOpen={(entry) => void openStackEntry(entry)} onClose={() => stackSidebar.setOpen(false)} />
      </> : null}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{content}</div>
    </div>
    <dialog ref={reviewDialog} aria-label="Submit review" className="m-auto max-h-[85vh] w-[min(40rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/40" onCancel={() => setReviewOpen(false)} onClose={() => setReviewOpen(false)}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="font-semibold">Review #{review.number}</h2>
        <Button variant="ghost" size="sm" className="h-7 w-7 px-0" aria-label="Close review" onClick={() => setReviewOpen(false)}><Icon name="X" className="size-4" /></Button>
      </div>
      {reviewOpened ? <ReviewForm reviewId={reviewId} detail={detail} rpc={rpc} refetch={refetch} onJump={(path, line, side) => openPrDiff({ path, line, side })} onSubmitted={() => setReviewOpen(false)} /> : null}
    </dialog>
  </div>;
}

// ---------------------------------------------------------------------------
// Review document panes
// ---------------------------------------------------------------------------

function FileTreeRows({
  nodes,
  selected,
  onSelect,
  open,
  toggle,
  forceOpen,
  depth,
}: {
  nodes: FileTreeNode[];
  selected: string | null;
  onSelect(path: string): void;
  open: Set<string>;
  toggle(path: string): void;
  forceOpen: boolean;
  depth: number;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === "dir") {
          const expanded = forceOpen || open.has(node.path);
          return (
            <li key={node.path === "" ? "/" : node.path}>
              <button
                type="button"
                onClick={() => toggle(node.path)}
                className="flex w-full items-center gap-1 py-0.5 pr-2 text-left hover:bg-state-hover"
                style={{ paddingLeft: 8 + depth * 12 }}
                title={node.path}
              >
                <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3 shrink-0 text-muted-foreground" />
                <Icon name={expanded ? "FolderOpen" : "Folder"} className="size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{node.name}</span>
              </button>
              {expanded ? (
                <ul>
                  <FileTreeRows nodes={node.children} selected={selected} onSelect={onSelect} open={open} toggle={toggle} forceOpen={forceOpen} depth={depth + 1} />
                </ul>
              ) : null}
            </li>
          );
        }
        const active = selected === node.file.path;
        const deleted = node.location === "old" || node.file.status === "deleted";
        const added = node.location === "new" || node.file.status === "added" || node.file.status === "copied";
        return (
          <li key={node.path}>
            <button
              type="button"
              onClick={() => onSelect(node.file.path)}
              className={cn("flex w-full items-center gap-1 py-0.5 pr-2 text-left hover:bg-state-hover", active && "bg-state-hover")}
              style={{ paddingLeft: 20 + depth * 12 }}
              title={node.location === null ? node.path : `${node.file.oldPath} → ${node.file.path}`}
            >
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              {deleted || added ? <span className={cn("shrink-0 font-mono text-[10px] font-semibold", deleted ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400")} aria-label={deleted ? "Deleted" : "Added"} title={deleted ? "Deleted" : "Added"}>{deleted ? "D" : "U"}</span> : null}
              {node.file.unresolvedCount > 0 ? <Icon name="MessageSquare" className="size-3 shrink-0 text-muted-foreground" aria-label={`${node.file.unresolvedCount} unresolved threads`} /> : null}
              {node.location !== "old" ? <DiffStat additions={node.file.additions} deletions={node.file.deletions} /> : null}
            </button>
          </li>
        );
      })}
    </>
  );
}

function FileTree({
  files,
  selected,
  onSelect,
  filter,
}: {
  files: FileEntry[];
  selected: string | null;
  onSelect(path: string): void;
  filter: string;
}) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const shown = useMemo(() => filterFileTree(tree, filter), [tree, filter]);
  const pathsKey = files.map((f) => f.path).join("\n");
  const [open, setOpen] = useState<Set<string>>(() => new Set(collectDirPaths(tree)));
  useEffect(() => {
    setOpen(new Set(collectDirPaths(tree)));
  }, [pathsKey]);
  const toggle = (path: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  if (shown.length === 0) return <p className="px-2 py-3 text-[11px] text-muted-foreground">No files match.</p>;
  return (
    <ul className="py-1 text-xs">
      <FileTreeRows nodes={shown} selected={selected} onSelect={onSelect} open={open} toggle={toggle} forceOpen={filter.trim() !== ""} depth={0} />
    </ul>
  );
}

function DiffPane({ detail, rpc, refetch, commit, jump, onOpenPrDiff }: {
  detail: ReviewDetail;
  rpc: ReturnType<typeof useRpc<Contract>>;
  refetch(): void;
  commit: CommitTarget | null;
  jump: DiffJump | null;
  onOpenPrDiff(jump?: DiffJump): void;
}) {
  const reviewId = detail.review.id;
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const codeTheme = useCodeTheme();
  const narrow = useNarrow(container);
  const scope = commit === null ? "pr" : `${commit.from ?? ""}..${commit.to}`;

  const { open: showTree, setOpen: setShowTree, toggle: toggleTree } = useSidebar(TREE_KEY, narrow);
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const [selection, setSelectionState] = useState<Selection | null>(null);
  const [composer, setComposer] = useState<Extract<Anno, { kind: "composer" }> | null>(null);
  const appliedJump = useRef<DiffJump | null>(null);
  const scrolledJump = useRef<DiffJump | null>(null);
  const [commitData, setCommitData] = useState<CommitData | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);

  useEffect(() => {
    setPicked(readStorage<string>(fileSelKey(reviewId, scope)));
    setFilter("");
    setComposer(null);
    setCommitData(null);
    setCommitError(null);
  }, [reviewId, scope]);

  useEffect(() => {
    if (commit === null) {
      setCommitData(null);
      setCommitError(null);
      return;
    }
    setCommitData(null);
    setCommitError(null);
    let cancelled = false;
    rpc.call("commit_get", { reviewId, to: commit.to, ...(commit.from === null ? {} : { from: commit.from, inclusive: commit.inclusive }) }).then(
      (result) => { if (!cancelled) setCommitData(result); },
      (cause: unknown) => { if (!cancelled) setCommitError(describeError(cause)); },
    );
    return () => { cancelled = true; };
  }, [rpc, reviewId, commit?.to, commit?.from, commit?.inclusive]);

  const setSelection = setSelectionState;

  const theme = useMemo(() => {
    const known = SHIKI_THEMES.has(codeTheme.name);
    return {
      dark: known && codeTheme.mode === "dark" ? codeTheme.name : "github-dark",
      light: known && codeTheme.mode === "light" ? codeTheme.name : "github-light",
      mode: codeTheme.mode,
    };
  }, [codeTheme.name, codeTheme.mode]);

  const actions = useMemo<AnnoActions>(() => ({
    editComment: async (id, body, expectedBody) => { const result = await rpc.call("review_edit_body", { reviewId, target: { kind: "inline", id }, body, expectedBody }); refetch(); toast.success("Comment updated"); return result; },
    refreshThreads: () => { void rpc.call("review_threads_refresh", { reviewId }).then(() => refetch(), (cause: unknown) => toast.error(describeError(cause))); },
    reply: async (commentId, body) => { if (reviewId === null) return; await rpc.call("thread_reply", { reviewId, commentId, body }); refetch(); toast.success("Reply posted"); },
    resolve: async (threadId, resolve) => { if (reviewId === null) return; await rpc.call("thread_resolve", { reviewId, threadId, resolve }); refetch(); },
    savePending: async (input) => { if (reviewId === null) return; await rpc.call("pending_add", { reviewId, ...input }); refetch(); },
    savePrivate: async (input) => { if (reviewId === null) return; await rpc.call("note_add", { reviewId, ...input }); refetch(); },
    updatePending: async (id, body) => { await rpc.call("pending_update", { id, body }); refetch(); },
    deletePending: async (id) => { await rpc.call("pending_delete", { id }); refetch(); },
    closeComposer: () => setComposer(null),
    promoteNote: async (id) => { await rpc.call("note_promote", { id }); refetch(); toast.success("Now a pending comment; it posts with your review"); },
    deleteNote: async (id) => { await rpc.call("note_delete", { id }); refetch(); },
  }), [rpc, reviewId, refetch]);

  const jumpPath = jump === null ? null : detail.files.find((file) => file.path === jump.path || file.oldPath === jump.path)?.path ?? jump.path;
  useEffect(() => {
    if (jump !== null && jumpPath !== null && commit === null && appliedJump.current !== jump) {
      appliedJump.current = jump;
      setPicked(jumpPath);
      writeStorage(fileSelKey(reviewId, scope), jumpPath);
    }
  }, [jump, jumpPath, reviewId, scope]);

  const files: FileEntry[] = commit === null ? detail.files : (commitData?.files ?? []).map(asFileEntry);
  const selectedPath = files.some((f) => f.path === picked) ? picked : (files[0]?.path ?? null);
  const selectedFile = files.find((f) => f.path === selectedPath) ?? null;

  useEffect(() => {
    if (!container || !jump || jumpPath === null || commit !== null || selectedPath !== jumpPath || scrolledJump.current === jump) return;
    let cancel: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      scrolledJump.current = jump;
      cancel = settleDiffLine(container, jumpPath, jump.line);
    }, 250);
    return () => { window.clearTimeout(timer); cancel?.(); };
  }, [container, jump, jumpPath, scope, selectedPath]);

  const selectFile = (path: string) => {
    setPicked(path);
    writeStorage(fileSelKey(reviewId, scope), path);
  };

  if (commit !== null && (commitError !== null || commitData === null)) return <div className="h-full p-4">
    {commitError !== null ? <p role="alert" className="text-sm text-destructive">{commitError}</p> : <EmptyState>Loading commit…</EmptyState>}
  </div>;

  const { review, threads, pending, notes } = detail;
  const inCommit = commit !== null;
  const file = selectedFile;
  const livePaths = new Set(files.flatMap((entry) => entry.oldPath === null ? [entry.path] : [entry.path, entry.oldPath]));
  const lostPending = inCommit ? [] : pending.filter((p) => !livePaths.has(p.path));
  const pendingOnFile = (path: string) => {
    if (inCommit) return [];
    const entry = files.find((file) => file.path === path);
    return pending.filter((p) => p.path === path || (entry?.oldPath !== undefined && p.path === entry.oldPath));
  };
  const notesForFile = (path: string) => notes.filter((note) => (note.path === path || note.path === files.find((entry) => entry.path === path)?.oldPath) && (note.state === "open" || note.state === "stale"));
  const source: DiffSource | undefined = inCommit && commitData !== null ? { kind: "range", base: commitData.base, head: commitData.head } : undefined;

  const tree = showTree ? (
    <aside aria-label="Changed files" className={cn(
      "flex flex-col border-r border-border bg-card",
      narrow ? "absolute inset-y-0 left-0 z-30 w-[min(18rem,85%)] shadow-lg" : "w-60 shrink-0",
    )}>
      <div className="flex items-center gap-1 border-b border-border p-2">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files…" className="h-7 min-w-0 flex-1 text-xs" aria-label="Filter files" />
        {narrow ? (
          <Button variant="ghost" size="sm" className="h-7 w-7 shrink-0 px-0" onClick={() => setShowTree(false)} aria-label="Close file list">
            <Icon name="X" className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <FileTree files={files} selected={selectedPath} onSelect={selectFile} filter={filter} />
      </div>
    </aside>
  ) : null;

  return (
    <div ref={setContainer} className="relative flex h-full min-h-0 text-xs" aria-label="File diff">
      {narrow && showTree ? <button type="button" className="absolute inset-0 z-20 bg-background/60" aria-label="Close file list" onClick={() => setShowTree(false)} /> : null}
      {tree}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {commit ? <div className="flex items-center gap-3 border-b border-border px-3 py-2 text-xs">
          <span className="font-mono">{commit.from ? shortSha(commit.from) + "…" : ""}{shortSha(commit.to)}</span>
          <button type="button" className="text-muted-foreground hover:underline" onClick={() => onOpenPrDiff()}>All PR changes</button>
        </div> : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-2 py-1.5">
          <div className="flex min-w-0 flex-1 basis-48 items-center gap-2">
            <Button
              variant={showTree ? "outline" : "ghost"}
              size="sm"
              className="h-7 w-7 shrink-0 px-0"
              onClick={toggleTree}
              aria-pressed={showTree}
              aria-label={showTree ? "Hide file list" : "Show file list"}
              title={showTree ? "Hide file list" : "Show file list"}
            >
              <Icon name="PanelLeft" className="size-3.5" />
            </Button>
            <span className="min-w-0 flex-1 truncate font-mono" title={selectedPath ?? undefined}>{selectedPath ?? "No files"}</span>
          </div>
          {file ? <div className="ml-auto flex items-center gap-3">
            <span className="font-mono"><span className="text-primary">+{file.additions}</span> <span className="text-destructive">−{file.deletions}</span></span>
            <select value={diffStyle} onChange={(e) => setDiffStyle(e.target.value as "unified" | "split")} className="h-7 rounded-md border border-input bg-background px-1.5 text-xs" aria-label="Diff style">
              <option value="unified">Unified</option>
              <option value="split">Split</option>
            </select>
            <FileLink target={{ kind: "host", hostId: review.hostId, path: review.worktree + "/" + file.path }} className="text-muted-foreground hover:underline">Open file</FileLink>
          </div> : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {lostPending.length > 0 ? (
            <div className="mb-2 space-y-1 rounded-lg border border-dashed border-foreground/40 p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Pending comments on files that left this diff</span>
                <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs text-destructive" onClick={() => void rpc.call("pending_clear", { reviewId, staleOnly: true }).then((r) => { refetch(); toast.success(`Removed ${r.removed} stale comment${r.removed === 1 ? "" : "s"}`); }, (cause: unknown) => toast.error(describeError(cause)))}>Remove stale</Button>
              </div>
              <ul className="space-y-1">
                {lostPending.map((p) => (
                  <PendingListItem
                    key={p.id}
                    pending={p}
                    onJump={() => selectFile(p.path)}
                    onDelete={() => void rpc.call("pending_delete", { id: p.id }).then(() => refetch(), (cause: unknown) => toast.error(describeError(cause)))}
                  />
                ))}
              </ul>
            </div>
          ) : null}
          {file === null ? <EmptyState>No files in this diff.</EmptyState> : (
            <FileCard
              key={`${reviewId}:${scope}:${file.path}:${jumpPath === file.path && jump ? `${jump.line}:${jump.side}` : ""}`}
              review={review}
              file={file}
              source={source}
              threads={inCommit ? [] : threads.filter((thread) => thread.path === file.path || thread.path === file.oldPath)}
              pending={pendingOnFile(file.path)}
              notes={inCommit ? [] : notesForFile(file.path)}
              composer={inCommit || composer?.path !== file.path ? null : composer}
              selection={selection}
              onSelect={setSelection}
              onOpenComposer={(path, range) => {
                const anchor = commentSelection(range);
                if (anchor === null) {
                  toast.error("Select lines on one side of the diff to comment.");
                  return;
                }
                if (inCommit) {
                  onOpenPrDiff({ path, line: anchor.line, side: anchor.side === "LEFT" ? "old" : "new" });
                  return;
                }
                setComposer({ kind: "composer", path, ...anchor, initial: "" });
              }}
              diffStyle={diffStyle}
              theme={theme}
              actions={actions}
              rpc={rpc}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PendingListItem({ pending, onJump, onDelete }: { pending: PendingComment; onJump(): void; onDelete(): void }) {
  const { name } = splitPath(pending.path);
  const line = `${pending.startLine !== null && pending.startLine !== pending.line ? `${pending.startLine}-` : ""}${pending.line}`;
  return (
    <li className="flex items-start gap-2 rounded-md border border-dashed border-foreground/40 px-2 py-1">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={onJump} className="font-mono hover:underline">{name}:{line}</button>
          {pending.stale ? <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground" title="This line is gone from the current diff">stale</span> : null}
        </div>
        <div className="truncate text-muted-foreground">{pending.body.split("\n")[0]}</div>
      </div>
      <Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-xs text-destructive" onClick={onDelete}>Delete</Button>
    </li>
  );
}

function ReviewForm({ reviewId, detail, rpc, refetch, onJump, onSubmitted }: {
  reviewId: string;
  detail: ReviewDetail;
  rpc: ReturnType<typeof useRpc<Contract>>;
  refetch(): void;
  onJump: JumpFn;
  onSubmitted(): void;
}) {
  const [event, setEvent] = useState<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setBody(""); setEvent("COMMENT"); }, [reviewId]);
  const { review, pending, notes } = detail;
  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); refetch(); } catch (cause) { toast.error(describeError(cause)); }
  };
  const ok = (check: Review["checks"][number]) => ["success", "skipped", "neutral"].includes((check.conclusion ?? "").toLowerCase());
  const passed = review.checks.filter(ok).length;
  const activeNotes = notes.filter((note) => note.state === "open" || note.state === "stale");
  const cannotSubmit = busy || (event === "COMMENT" && body.trim() === "" && pending.every((comment) => comment.stale)) || (event === "REQUEST_CHANGES" && body.trim() === "");
  return <div className="h-full space-y-6 overflow-y-auto p-4 text-sm">
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Your review</h2>
        {pending.some((comment) => comment.stale) ? <Button variant="ghost" size="sm" onClick={() => void run(() => rpc.call("pending_clear", { reviewId, staleOnly: true }))}>Remove stale comments</Button> : null}
      </div>
      {pending.length > 0 ? <ul className="space-y-2">{pending.map((comment) => <PendingListItem key={comment.id} pending={comment}
        onJump={() => onJump(comment.path, comment.line, comment.side === "LEFT" ? "old" : "new")}
        onDelete={() => void run(() => rpc.call("pending_delete", { id: comment.id }))} />)}</ul> : null}
      <form className="space-y-3" onSubmit={async (submitEvent: FormEvent) => {
        submitEvent.preventDefault();
        if (cannotSubmit) return;
        setBusy(true);
        try {
          const result = await rpc.call("review_submit", { reviewId, event, body });
          setBody(""); refetch();
          onSubmitted();
          toast.success(result.dropped > 0 ? "Review submitted. " + result.dropped + " stale comments remain pending." : "Review submitted to GitHub");
        } catch (cause) { toast.error(describeError(cause)); } finally { setBusy(false); }
      }}>
        <fieldset disabled={busy} className="space-y-3">
        <TextArea value={body} onChange={setBody} rows={5} placeholder="Write your review…" />
        <fieldset className="space-y-2"><legend className="sr-only">Review decision</legend>
          {(["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const).map((value) => <label key={value} className="flex items-center gap-2 text-sm">
            <input type="radio" name="review-decision" checked={event === value} onChange={() => setEvent(value)} />
            {value === "COMMENT" ? "Comment" : value === "APPROVE" ? "Approve" : "Request changes"}
          </label>)}
        </fieldset>
        <Button type="submit" disabled={cannotSubmit}>{busy ? "Submitting…" : "Submit review"}</Button>
        </fieldset>
      </form>
    </section>
    {activeNotes.length > 0 ? <details className="border-t border-border pt-4"><summary className="cursor-pointer font-medium">Private notes ({activeNotes.length})</summary>
      <div className="mt-3 space-y-4">{activeNotes.map((note) => <div key={note.id}>
        <button type="button" className="break-all font-mono text-xs text-muted-foreground hover:underline" onClick={() => onJump(note.path, note.line, note.side === "LEFT" ? "old" : "new")}>{note.path}:{note.line}</button>
        <NoteCard note={note} actions={{ promoteNote: async (id) => { await rpc.call("note_promote", { id }); refetch(); }, deleteNote: async (id) => { await rpc.call("note_delete", { id }); refetch(); } }} />
      </div>)}</div>
    </details> : null}
    {review.checks.length > 0 ? <details className="border-t border-border pt-4"><summary className="cursor-pointer font-medium">Checks ({passed}/{review.checks.length})</summary>
      <ul className="mt-3 space-y-2">{review.checks.map((check, index) => <li key={index} className="flex items-start gap-3 text-xs">
        {check.url ? <UrlLink href={check.url} className="min-w-0 flex-1 break-words hover:underline">{check.name}</UrlLink> : <span className="min-w-0 flex-1 break-words">{check.name}</span>}
        <span className={cn("shrink-0", ok(check) ? "text-muted-foreground" : "text-foreground")}>{(check.conclusion ?? check.status).toLowerCase().replace(/_/g, " ")}</span>
      </li>)}</ul>
    </details> : null}
    {review.reviewers.length > 0 ? <details className="border-t border-border pt-4"><summary className="cursor-pointer font-medium">Reviewers</summary>
      <ul className="mt-3 space-y-2">{review.reviewers.map((reviewer) => <li key={reviewer.login} className="flex items-center justify-between gap-3 text-xs"><span>{reviewer.login}</span><span className="text-muted-foreground">{reviewer.state.replace(/_/g, " ").toLowerCase()}</span></li>)}</ul>
    </details> : null}
    {review.assignees.length > 0 || review.labels.length > 0 ? <details className="border-t border-border pt-4"><summary className="cursor-pointer font-medium">Details</summary>
      <dl className="mt-3 space-y-2 text-xs">{review.assignees.length > 0 ? <div><dt className="text-muted-foreground">Assignees</dt><dd>{review.assignees.join(", ")}</dd></div> : null}{review.labels.length > 0 ? <div><dt className="text-muted-foreground">Labels</dt><dd>{review.labels.join(", ")}</dd></div> : null}</dl>
    </details> : null}
  </div>;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function groupReviews(reviews: ReviewSummary[]): { key: string; stack: ReviewSummary["stack"]; items: ReviewSummary[] }[] {
  const groups: { key: string; stack: ReviewSummary["stack"]; items: ReviewSummary[] }[] = [];
  const seen = new Set<ReviewSummary>();
  for (const review of reviews) {
    if (seen.has(review)) continue;
    if (review.stack === null) {
      seen.add(review);
      groups.push({ key: `${review.owner}/${review.repo}#${review.number}`, stack: null, items: [review] });
      continue;
    }
    const items = reviews.filter((other) => other.stack?.key === review.stack?.key).sort((a, b) => (a.stack?.position ?? 0) - (b.stack?.position ?? 0));
    for (const item of items) seen.add(item);
    groups.push({ key: review.stack.key, stack: review.stack, items });
  }
  return groups;
}

function ReviewsPage({ subPath }: { subPath: string }) {
  const { reviews, error, refetch } = useReviews();
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const [ref, setRef] = useState("");
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const { reviewId, commit } = parseReviewSubPath(subPath);
  if (reviewId !== null) return <ReviewView key={reviewId} reviewId={reviewId} commit={commit} />;
  const drop = async (review: ReviewSummary) => {
    if (!confirmRemoveReview(review.stack !== null)) return;
    try {
      if (review.stack) await rpc.call("stacks_remove", { key: review.stack.key });
      else if (review.id) await rpc.call("reviews_remove", { reviewId: review.id });
      else await rpc.call("reviews_remove", { owner: review.owner, repo: review.repo, number: review.number });
      refetch();
      toast.success("Removed from Review Desk");
    } catch (cause) { toast.error(describeError(cause)); }
  };
  const openSummary = async (summary: ReviewSummary) => {
    if (summary.id) { navigate.toPluginPanel(PANEL_PATH, { subPath: summary.id }); return; }
    setOpening(true);
    setOpenError(null);
    try {
      const { review } = await rpc.call("reviews_open", { ref: `${summary.owner}/${summary.repo}#${summary.number}` });
      refetch();
      navigate.toPluginPanel(PANEL_PATH, { subPath: review.id });
    } catch (cause) { setOpenError(describeError(cause)); }
    finally { setOpening(false); }
  };
  const open = async (e: FormEvent) => {
    e.preventDefault();
    if (ref.trim() === "") return;
    setOpening(true);
    setOpenError(null);
    try {
      const { review } = await rpc.call("reviews_open", { ref: ref.trim() });
      setRef("");
      refetch();
      navigate.toPluginPanel(PANEL_PATH, { subPath: review.id });
    } catch (cause) {
      setOpenError(describeError(cause));
    } finally {
      setOpening(false);
    }
  };
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-6 py-12">
        <h1 className="text-2xl font-semibold tracking-tight">Reviews</h1>
        <form onSubmit={open} className="mt-6 flex items-center gap-2">
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="owner/repo#123 or owner/repo/stack/7" className="h-10" aria-label="Pull request" />
          <Button type="submit" className="h-10" disabled={opening || ref.trim() === ""}>
            {opening ? <Icon name="Loading" className="size-4 animate-spin" /> : <Icon name="GitPullRequest" className="size-4" />}
            {opening ? "Fetching…" : "Open"}
          </Button>
        </form>
        {openError ? <p className="mt-2 text-sm text-destructive">{openError}</p> : null}
        <div className="mt-10">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Pull requests</div>
          {error ? <p className="mb-3 text-sm text-destructive">{error}</p> : null}
          {reviews === null ? <p className="text-sm text-muted-foreground">Loading…</p> : reviews.length === 0 ? <EmptyState>No reviews yet.</EmptyState> : (
            <ul className="space-y-3">
              {groupReviews(reviews).map((group) => {
                if (group.stack === null) {
                  const r = group.items[0];
                  if (r === undefined) return null;
                  return (
                    <li key={group.key} className="overflow-hidden rounded-lg border border-border">
                      <div className="flex items-center">
                        <button type="button" disabled={opening} onClick={() => void openSummary(r)} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left hover:bg-state-hover">
                          <PrMark state={r.state} reviewDecision={r.reviewDecision} isDraft={r.isDraft} className="size-4" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{r.title}</span>
                            <span className="flex items-center gap-2 truncate text-xs text-muted-foreground">
                              <span className="truncate">{r.owner}/{r.repo} #{r.number}</span>
                              <DiffStat additions={r.additions} deletions={r.deletions} />
                              <CountBadge count={r.pendingCount} title={`${r.pendingCount} pending`} />
                            </span>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(r.updatedAt)}</span>
                        </button>
                        <RemoveReviewButton label="Remove review" onClick={() => void drop(r)} />
                      </div>
                    </li>
                  );
                }
                const stackInfo = group.stack;
                const latest = [...group.items].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? group.items[0];
                if (latest === undefined) return null;
                const layers = [...group.items].sort((a, b) => (a.stack?.position ?? 0) - (b.stack?.position ?? 0));
                return (
                  <li key={group.key} className="overflow-hidden rounded-lg border border-border">
                    <div className="flex items-center">
                      <button type="button" disabled={opening} onClick={() => void openSummary(latest)} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left hover:bg-state-hover">
                        <PrMark state={latest.state} isDraft={latest.isDraft} reviewDecision={latest.reviewDecision} className="size-4" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{latest.title}</span>
                          <span className="flex items-center gap-2 truncate text-xs text-muted-foreground">
                            <span className="truncate">{latest.owner}/{latest.repo}</span>
                            {stackInfo.number !== null ? <span className="font-mono" title={`GitHub stack #${stackInfo.number}`}>#{stackInfo.number}</span> : null}
                            <span className="inline-flex items-center gap-1" title={`${stackInfo.size} pull requests in stack`}><Icon name="Layers" className="size-3.5" />{stackInfo.size} PRs</span>
                            <DiffStat {...diffStats(group.items)} />
                            <CountBadge count={group.items.reduce((n, r) => n + r.pendingCount, 0)} title="Pending comments" />
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(latest.updatedAt)}</span>
                      </button>
                      <RemoveReviewButton label="Remove stack reviews" onClick={() => void drop(latest)} />
                    </div>
                    <ul className="divide-y divide-border/60 border-t border-border/60">
                      {layers.map((r) => (
                        <li key={r.number}>
                          <div className="flex items-center">
                            <button type="button" disabled={opening} onClick={() => void openSummary(r)} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-1.5 pl-11 text-left hover:bg-state-hover">
                              <span className="w-8 shrink-0 font-mono text-[11px] text-muted-foreground">{r.stack?.position}/{stackInfo.size}</span>
                              <span className="w-12 shrink-0 font-mono text-xs">#{r.number}</span>
                              <span className="min-w-0 flex-1 truncate text-xs">{r.title}</span>
                              <DiffStat additions={r.additions} deletions={r.deletions} />
                              <PrMark state={r.state} reviewDecision={r.reviewDecision} isDraft={r.isDraft} />
                              <CountBadge count={r.pendingCount} title={`${r.pendingCount} pending`} />
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: PANEL_ID,
    title: "Reviews",
    icon: "GitPullRequest",
    path: PANEL_PATH,
    component: ReviewsPage,
  });
});
