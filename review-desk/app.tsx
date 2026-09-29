// bb-plugin-review-desk — frontend entry.
//
// A PR review page: state, title, author and branches, then Brief /
// Description / Discussion / Commits. The diff lives in a right-pane Diff
// tab with a hideable file tree and one file at a time. Info, Chat, and
// Codemap share that pane. Stacked GitHub PRs open every layer as its own
// review.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  Markdown,
  ThreadChat,
  UrlLink,
  useBbNavigate,
  useComposer,
  useComposerView,
  useRealtime,
  useRpc,
  experimental_FileLink as FileLink,
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_useAppPanel as useAppPanel,
  experimental_useCodeTheme as useCodeTheme,
  experimental_useFixedTabTarget as useFixedTabTarget,
  type ExperimentalPluginFixedTabReference,
  type JsonValue,
  type NewThreadRequest,
  type PluginComposerMention,
} from "@get-bb/plugin-sdk/app";
import { FileDiff, type DiffLineAnnotation, type FileDiffMetadata, type SelectedLineRange } from "@pierre/diffs/react";
import { parsePatchFiles } from "@pierre/diffs";
import type { BriefState, CodemapState, CommitInfo, FileEntry, Note, NoteKind, PendingComment, ProviderOption, Review, ReviewSummary, Seat, SelectionRef, StackView, rpcContract } from "./server";
import type { ChangedFile } from "./host-contract";
import type { Codemap, GhThread } from "./host-contract";
import type { Brief, BriefEvidence, ClaimVerdict } from "./brief-spec";
import type { Evidence as SlopEvidence, SlopReport } from "./slop";
import { MENTION_PROVIDER_ID, encodeMentionRef, mentionLabel, type MentionRef } from "./mention-ref";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Contract = typeof rpcContract;

const PANEL_ID = "reviews";
const PANEL_PATH = "reviews";
const REVIEW_CHANGED = "review-changed";
const PROVIDER_KEY = "review-desk:provider";
const selectionKey = (reviewId: string) => `review-desk:selection:${reviewId}`;
const stackRailKey = (owner: string, repo: string, stack: StackView) =>
  `review-desk:stack-rail:${owner}/${repo}/${stack.number ?? stack.entries[0]?.number ?? 0}`;

// ---------------------------------------------------------------------------
// Code pills
//
// A pill is a bb @-mention that our server resolves to code when the message
// is sent. The diff page cannot write into a composer directly (it lives in
// the nav panel; the composer lives in the Chat tab), so it queues the pill
// per review and the composer banner, mounted inside the composer, drains the
// queue with `useComposer().insertMention`.
// ---------------------------------------------------------------------------

interface Attach { mention: PluginComposerMention; text?: string }
const ATTACH_EVENT = "review-desk:attach";
const SELECTION_EVENT = "review-desk:selection";
const pendingAttaches = new Map<string, Attach[]>();

function pill(ref: MentionRef): PluginComposerMention {
  return { provider: MENTION_PROVIDER_ID, id: encodeMentionRef(ref), label: mentionLabel(ref) };
}

function selectionPill(reviewId: string, sel: SelectionRef): PluginComposerMention {
  return pill({ kind: "range", reviewId, path: sel.path, startLine: sel.startLine, endLine: sel.endLine, side: sel.side });
}

function queueAttach(reviewId: string, attach: Attach): void {
  pendingAttaches.set(reviewId, [...(pendingAttaches.get(reviewId) ?? []), attach]);
  window.dispatchEvent(new CustomEvent(ATTACH_EVENT, { detail: { reviewId } }));
}

function drainAttaches(reviewId: string): Attach[] {
  const list = pendingAttaches.get(reviewId) ?? [];
  pendingAttaches.delete(reviewId);
  return list;
}

/** Review whose "new chat" composer is on screen; that composer scope has no thread id yet. */
let composingReview: string | null = null;
const composingListeners = new Set<() => void>();
function setComposingReview(reviewId: string | null): void {
  if (composingReview === reviewId) return;
  composingReview = reviewId;
  for (const listener of composingListeners) listener();
}
function useComposingReview(): string | null {
  return useSyncExternalStore(
    (listener) => {
      composingListeners.add(listener);
      return () => composingListeners.delete(listener);
    },
    () => composingReview,
  );
}

const seatLookups = new Map<string, Promise<string | null>>();
function lookupSeatReview(rpc: ReturnType<typeof useRpc<Contract>>, threadId: string): Promise<string | null> {
  let promise = seatLookups.get(threadId);
  if (promise === undefined) {
    promise = rpc.call("seat_lookup", { threadId }).then((r) => r.seat?.reviewId ?? null, () => null);
    seatLookups.set(threadId, promise);
    // Not a seat today may be one later (reset spawns a new thread id, so
    // negative answers are only cached briefly).
    void promise.then((id) => { if (id === null) setTimeout(() => seatLookups.delete(threadId), 5000); });
  }
  return promise;
}

/** The diff selection for a review, shared through storage and kept live by an event. */
function useSelectionRef(reviewId: string | null): SelectionRef | null {
  const read = () => (reviewId === null ? null : readStorage<SelectionRef>(selectionKey(reviewId)));
  const [selection, setSelection] = useState<SelectionRef | null>(read);
  useEffect(() => {
    setSelection(read());
    const onChange = (e: Event) => {
      if ((e as CustomEvent<{ reviewId: string }>).detail.reviewId === reviewId) setSelection(read());
    };
    window.addEventListener(SELECTION_EVENT, onChange);
    return () => window.removeEventListener(SELECTION_EVENT, onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId]);
  return selection;
}

interface ReviewTarget {
  reviewId: string;
  [key: string]: JsonValue;
}
function isReviewTarget(value: JsonValue): value is ReviewTarget {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>).reviewId === "string";
}
const INFO_TAB: ExperimentalPluginFixedTabReference<ReviewTarget> = { panelId: PANEL_ID, id: "info", experimental_target: { validate: isReviewTarget } };
const CHAT_TAB: ExperimentalPluginFixedTabReference<ReviewTarget> = { panelId: PANEL_ID, id: "chat", experimental_target: { validate: isReviewTarget } };
const CODEMAP_TAB: ExperimentalPluginFixedTabReference<ReviewTarget> = { panelId: PANEL_ID, id: "codemap", experimental_target: { validate: isReviewTarget } };
const DIFF_TAB: ExperimentalPluginFixedTabReference<ReviewTarget> = { panelId: PANEL_ID, id: "diff", experimental_target: { validate: isReviewTarget } };
const TREE_KEY = "review-desk:file-tree";
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
    ? "Remove these reviews from Review Desk? The pull requests stay on GitHub."
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

function fileAnchorId(path: string): string {
  return `rd-file-${path.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function settleDiffLine(path: string, line: number | null): void {
  const wanted = line === null ? null : String(line);
  let tries = 0;
  const tick = () => {
    const card = document.getElementById(fileAnchorId(path));
    const host = card ? Array.from(card.querySelectorAll("*")).find((el) => el.shadowRoot !== null) : undefined;
    const cell = wanted !== null && host?.shadowRoot ? Array.from(host.shadowRoot.querySelectorAll("[data-line-number-content]")).find((el) => el.textContent?.trim() === wanted) : undefined;
    if (cell) {
      cell.scrollIntoView({ block: "center" });
      return;
    }
    card?.scrollIntoView({ block: "start" });
    if (++tries < 10) setTimeout(tick, tries < 4 ? 300 : 600);
  };
  tick();
}

function commitFields(commit?: CommitTarget | null): Record<string, JsonValue> {
  if (commit === undefined || commit === null) return {};
  return commit.from === null
    ? { commitTo: commit.to, inclusive: commit.inclusive }
    : { commitTo: commit.to, commitFrom: commit.from, inclusive: commit.inclusive };
}

function openDiff(panel: ReturnType<typeof useAppPanel>, reviewId: string, jump?: { path: string; line: number | null; side: "old" | "new" }, commit?: CommitTarget | null): void {
  const extra = commitFields(commit);
  panel.openFixedTab({
    surface: { kind: "current" },
    tab: DIFF_TAB,
    target: jump === undefined
      ? { reviewId, ...extra }
      : { reviewId, path: jump.path, ...(jump.line === null ? {} : { line: jump.line }), side: jump.side, ...extra },
  });
}

function jumpFromTarget(target: ReviewTarget): { path: string; line: number | null; side: "old" | "new" } | null {
  if (typeof target.path !== "string" || target.path === "") return null;
  return {
    path: target.path,
    line: typeof target.line === "number" ? target.line : null,
    side: target.side === "old" ? "old" : "new",
  };
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

function alsoInSlices(path: string, stack: StackView | null, current: number): StackView["entries"] {
  if (stack === null) return [];
  return stack.entries.filter((e) => e.number !== current && e.files.includes(path));
}

function splitPath(path: string): { name: string; dir: string } {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? { name: path, dir: "" } : { name: path.slice(idx + 1), dir: path.slice(0, idx) };
}

type FileTreeNode =
  | { kind: "dir"; name: string; path: string; children: FileTreeNode[] }
  | { kind: "file"; name: string; file: FileEntry };

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
    const { name, dir } = splitPath(file.path);
    ensure(dir).children.push({ kind: "file", name, file });
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
        if (node.file.path.toLowerCase().includes(needle)) out.push(node);
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

function groupByPath<T extends { path: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const list = map.get(item.path);
    if (list === undefined) map.set(item.path, [item]);
    else list.push(item);
  }
  return map;
}

interface ReviewDetail {
  review: Review;
  files: FileEntry[];
  pending: PendingComment[];
  threads: GhThread[];
  seats: Seat[];
  notes: Note[];
  notesRunning: boolean;
  notesError: string | null;
  seen: { prevHead: string | null; seenHead: string | null };
  chatProjectId: string;
  stack: StackView | null;
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

/** A jump requested from another view (the commit view) to run once the PR diff is on screen. */
let pendingJump: { reviewId: string; path: string; line: number | null; side: "old" | "new" } | null = null;

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

function useNarrow(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia("(max-width: 767px)");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(max-width: 767px)").matches,
    () => false,
  );
}

function pathsEqual(left: string, right: string): boolean {
  const strip = (p: string) => p.replace(/^[ab]\//, "");
  return left === right || strip(left) === strip(right);
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

function lineInFileDiff(fileDiff: FileDiffMetadata, side: "deletions" | "additions", line: number): boolean {
  return fileDiff.hunks.some((hunk) => {
    const start = side === "additions" ? hunk.additionStart : hunk.deletionStart;
    const count = side === "additions" ? hunk.additionCount : hunk.deletionCount;
    return line >= start && line < start + count;
  });
}

function annotationLine(fileDiff: FileDiffMetadata | null, side: "deletions" | "additions", line: number): number {
  if (fileDiff === null) return line;
  return lineInFileDiff(fileDiff, side, line) ? line : 0;
}

function useReviews() {
  const rpc = useRpc<Contract>();
  const [reviews, setReviews] = useState<ReviewSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("reviews_list").then(
      (result) => {
        setReviews(result.reviews);
        setError(null);
      },
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(REVIEW_CHANGED, refetch);
  return { reviews, error, refetch };
}

function useReview(reviewId: string | null) {
  const rpc = useRpc<Contract>();
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    if (reviewId === null) return;
    rpc.call("reviews_get", { reviewId }).then(
      (result) => {
        setDetail(result);
        setError(null);
      },
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc, reviewId]);
  useEffect(() => {
    setDetail(null);
    setError(null);
    refetch();
  }, [refetch]);
  useRealtime(REVIEW_CHANGED, (payload) => {
    const p = payloadReview(payload);
    if (p === null || p.reviewId !== reviewId) return;
    if (p.what === "removed" || p.what === "closed") {
      setDetail(null);
      setError(p.what);
      return;
    }
    refetch();
  });
  return { rpc, detail, error, refetch };
}

function useCodemap(reviewId: string | null, enabled: boolean) {
  const rpc = useRpc<Contract>();
  const [state, setState] = useState<CodemapState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    (refresh = false) => {
      if (reviewId === null || !enabled) return;
      rpc.call("codemap_get", { reviewId, refresh }).then(
        (result) => {
          setState(result);
          setError(null);
        },
        (cause: unknown) => setError(describeError(cause)),
      );
    },
    [rpc, reviewId, enabled],
  );
  useEffect(() => {
    load();
  }, [load]);
  useRealtime(REVIEW_CHANGED, (payload) => {
    const p = payloadReview(payload);
    if (p !== null && p.reviewId === reviewId && p.what === "codemap") load();
  });
  useEffect(() => {
    if (state?.status !== "building") return;
    const timer = setInterval(() => load(), 4000);
    return () => clearInterval(timer);
  }, [state?.status, load]);
  return { state, error, refresh: () => load(true) };
}

function useBrief(reviewId: string | null) {
  const rpc = useRpc<Contract>();
  const [state, setState] = useState<BriefState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    (refresh = false) => {
      if (reviewId === null) return;
      rpc.call("brief_get", { reviewId, refresh }).then(
        (result) => {
          setState(result);
          setError(null);
        },
        (cause: unknown) => setError(describeError(cause)),
      );
    },
    [rpc, reviewId],
  );
  useEffect(() => {
    setState(null);
    load();
  }, [load]);
  useRealtime(REVIEW_CHANGED, (payload) => {
    const p = payloadReview(payload);
    if (p !== null && p.reviewId === reviewId && (p.what === "brief" || p.what === "synced" || p.what === "codemap")) load();
  });
  const busy = state !== null && (state.signalsStatus === "computing" || state.briefStatus === "writing");
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => load(), 6000);
    return () => clearInterval(timer);
  }, [busy, load]);
  const setModel = useCallback((model: string) => {
    if (reviewId === null) return;
    rpc.call("helper_set_model", { model }).then(
      (r) => setState((s) => (s === null ? s : { ...s, helperModel: r.model })),
      (cause: unknown) => toast.error(describeError(cause)),
    );
  }, [rpc, reviewId]);
  return { state, error, refresh: () => load(true), setModel };
}

function useProviders() {
  const rpc = useRpc<Contract>();
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [defaultProvider, setDefaultProvider] = useState<string>("");
  useEffect(() => {
    rpc.call("context_providers").then(
      (r) => {
        setProviders(r.providers.filter((p) => p.available));
        setDefaultProvider(r.defaultProvider);
      },
      () => setProviders([]),
    );
  }, [rpc]);
  return { providers, defaultProvider };
}

/** The provider used for "Ask" from the diff and preselected in Chat; shared through storage. */
function useChatProvider(providers: ProviderOption[], fallback: string): [string, (id: string) => void] {
  const [providerId, setProviderId] = useState<string>(() => readStorage<string>(PROVIDER_KEY) ?? "");
  useEffect(() => {
    if (providerId !== "" && providers.some((p) => p.id === providerId)) return;
    const next = providers.find((p) => p.id === fallback)?.id ?? providers[0]?.id ?? "";
    if (next !== "") setProviderId(next);
  }, [providers, fallback, providerId]);
  const set = (id: string) => {
    setProviderId(id);
    writeStorage(PROVIDER_KEY, id);
  };
  return [providerId, set];
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function EmptyState({ children }: { children: ReactNode }) {
  return <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{children}</div>;
}

function StatePill({ state, isDraft }: { state: string; isDraft: boolean }) {
  const label = isDraft ? "Draft" : state === "OPEN" ? "Open" : state === "MERGED" ? "Merged" : state === "CLOSED" ? "Closed" : state.toLowerCase();
  const tone = isDraft ? "border-border text-muted-foreground" : state === "OPEN" ? "border-primary/40 bg-primary/10 text-primary" : state === "MERGED" ? "border-foreground/30 bg-foreground/10 text-foreground" : "border-destructive/40 bg-destructive/10 text-destructive";
  return <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", tone)}><Icon name={prStatusIcon(state, { isDraft })} className="size-3" />{label}</span>;
}

function DraftToggle({ review, busy, onToggle }: { review: Review; busy?: boolean; onToggle(draft: boolean): void }) {
  if (review.state !== "OPEN") return null;
  return (
    <Button
      type="button"
      variant={review.isDraft ? "default" : "outline"}
      size="sm"
      className="h-7 px-2 text-xs"
      disabled={busy === true}
      onClick={() => onToggle(!review.isDraft)}
      title={review.isDraft ? "Mark ready for review on GitHub" : "Convert to draft on GitHub"}
    >
      <Icon name={review.isDraft ? "GitPullRequest" : "GitPullRequestDraft"} className="size-3.5" />
      {review.isDraft ? "Mark ready" : "Mark draft"}
    </Button>
  );
}

function prStatusIcon(state: string, opts?: { isDraft?: boolean; merged?: boolean }): Extract<IconName, "GitMerge" | "GitPullRequestDraft" | "GitPullRequestClosed" | "GitPullRequest"> {
  if (opts?.merged || state === "MERGED") return "GitMerge";
  if (opts?.isDraft) return "GitPullRequestDraft";
  if (state !== "OPEN") return "GitPullRequestClosed";
  return "GitPullRequest";
}

function prStatusTone(state: string, opts?: { isDraft?: boolean; merged?: boolean }): string {
  return state === "OPEN" && !opts?.isDraft && !opts?.merged ? "text-primary" : "text-muted-foreground";
}

function PrMark({ state, isDraft, merged, className }: { state: string; isDraft?: boolean; merged?: boolean; className?: string }) {
  const title = merged || state === "MERGED" ? "Merged" : isDraft ? "Draft" : state === "OPEN" ? "Open" : state;
  return (
    <span title={title} className="inline-flex shrink-0">
      <Icon name={prStatusIcon(state, { isDraft, merged })} className={cn("size-3.5", prStatusTone(state, { isDraft, merged }), className)} />
    </span>
  );
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

function Progress({ value, total, className }: { value: number; total: number; className?: string }) {
  const pct = total === 0 ? 0 : Math.round((value / total) * 100);
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-full bg-border", className)} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={total}>
      <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
    </div>
  );
}

function reviewStateTone(state: string): string {
  switch (state) {
    case "APPROVED": return "text-primary";
    case "CHANGES_REQUESTED": return "text-destructive";
    default: return "text-muted-foreground";
  }
}
function reviewStateIcon(state: string): "Check" | "CircleX" | "MessageSquare" | "Clock" {
  switch (state) {
    case "APPROVED": return "Check";
    case "CHANGES_REQUESTED": return "CircleX";
    case "REQUESTED": case "PENDING": return "Clock";
    default: return "MessageSquare";
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
  /** The PR author's login, to color their comments. */
  prAuthor: string | null;
  reply(commentId: number, body: string): Promise<void>;
  resolve(threadId: string, resolve: boolean): Promise<void>;
  savePending(input: { path: string; line: number; startLine: number | null; side: "LEFT" | "RIGHT"; body: string }): Promise<void>;
  /** Same shape, but the comment stays a private note. */
  savePrivate(input: { path: string; line: number; startLine: number | null; side: "LEFT" | "RIGHT"; body: string }): Promise<void>;
  updatePending(id: string, body: string): Promise<void>;
  deletePending(id: string): Promise<void>;
  closeComposer(): void;
  setNoteState(id: string, state: "open" | "dismissed"): Promise<void>;
  promoteNote(id: string): Promise<void>;
  deleteNote(id: string): Promise<void>;
  noteToChat(note: Note): void;
  noteToCouncil(text: string): void;
}

const NOTE_KIND_STYLE: Record<NoteKind, { label: string; className: string }> = {
  slop: { label: "slop", className: "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  cleanup: { label: "cleanup", className: "border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  risk: { label: "risk", className: "border-destructive/50 bg-destructive/10 text-destructive" },
  question: { label: "question", className: "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300" },
};

function NoteCard({ note, actions }: { note: Note; actions: AnnoActions }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (cause) {
      toast.error(describeError(cause));
    } finally {
      setBusy(false);
    }
  };
  const kind = NOTE_KIND_STYLE[note.kind];
  const source = note.source === "signal" ? "from a signal" : note.source === "helper" ? "from the helper" : "yours";
  if (note.state === "dismissed" || note.state === "promoted") {
    return (
      <div className="my-1 flex items-center gap-2 rounded-md border border-dashed border-border/70 px-3 py-1 font-sans text-xs text-muted-foreground">
        <span className="rounded-full border border-border px-1.5 text-[10px]">{note.state}</span>
        <span className="min-w-0 truncate">{note.title || note.body.split("\n")[0]}</span>
        {note.state === "dismissed" ? <Button variant="ghost" size="sm" className="ml-auto h-5 px-1.5 text-[11px]" disabled={busy} onClick={() => void run(() => actions.setNoteState(note.id, "open"))}>Restore</Button> : null}
        <Button variant="ghost" size="sm" className={cn("h-5 px-1.5 text-[11px] text-destructive", note.state !== "dismissed" && "ml-auto")} disabled={busy} onClick={() => void run(() => actions.deleteNote(note.id))}>Delete</Button>
      </div>
    );
  }
  return (
    <div className={cn("my-1.5 rounded-lg border border-dashed bg-amber-500/[0.04] font-sans text-xs shadow-sm", note.state === "stale" ? "border-border" : "border-amber-500/60")}>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-amber-500/20 px-3 py-1.5">
        <span className="rounded-full border border-amber-500/60 bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-800 dark:text-amber-200" title="Only you can see this. Promote it to make it a real comment.">private</span>
        <span className={cn("rounded-full border px-1.5 text-[10px] font-medium", kind.className)}>{kind.label}</span>
        {note.severity !== "low" ? <span className={cn("rounded-full border px-1.5 text-[10px]", note.severity === "high" ? "border-destructive/50 text-destructive" : "border-border text-muted-foreground")}>{note.severity}</span> : null}
        {note.state === "stale" ? <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground" title="The line this note was written against is gone after a push">stale</span> : null}
        <span className="text-muted-foreground">{source}</span>
        <span className="ml-auto flex flex-wrap items-center gap-0.5">
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={() => actions.noteToChat(note)} title="Put these lines and the note into the chat">Ask</Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={() => actions.noteToCouncil(`${note.path}:${note.line}\n\n${note.title}\n${note.body}`)} title="Send to a Roundtable room">Council</Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={() => void run(() => actions.promoteNote(note.id))} title="Make this a pending GitHub comment">Promote</Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={() => void run(() => actions.setNoteState(note.id, "dismissed"))}>Dismiss</Button>
          {note.state === "stale" ? <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-destructive" disabled={busy} onClick={() => void run(() => actions.deleteNote(note.id))}>Delete</Button> : null}
        </span>
      </div>
      <div className="px-3 py-2">
        {note.title ? <div className="mb-0.5 font-medium text-foreground">{note.title}</div> : null}
        {note.body ? <CommentBody body={note.body} /> : null}
        {note.suggestion ? (
          <pre className="mt-1.5 overflow-x-auto rounded-md border border-primary/30 bg-primary/5 p-2 text-[12px] leading-relaxed"><code>{note.suggestion}</code></pre>
        ) : null}
      </div>
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

const BOT_LOGINS = new Set(["coderabbitai", "github-actions", "copilot", "copilot-pull-request-reviewer", "dependabot", "codecov", "greptile", "greptile-apps", "cursor", "devin-ai-integration", "sourcery-ai", "ellipsis-dev", "gemini-code-assist", "claude", "codex", "renovate", "sonarcloud", "graphite-app"]);
function isBot(login: string): boolean {
  return /\[bot\]$/i.test(login) || BOT_LOGINS.has(login.toLowerCase().replace(/\[bot\]$/i, ""));
}

const SEVERITIES: { test: RegExp; label: string; className: string }[] = [
  { test: /\b(critical|blocker|p0)\b/i, label: "critical", className: "border-destructive/50 bg-destructive/10 text-destructive" },
  { test: /\b(major|p1|high|important)\b/i, label: "major", className: "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  { test: /\b(minor|p2|medium|suggestion)\b/i, label: "minor", className: "border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  { test: /\b(nit|nitpick|p3|low|trivial|style)\b/i, label: "nit", className: "border-border bg-muted text-muted-foreground" },
];
/** Severity and finding id from the first line of a comment, e.g. "**R1-19 · Major — …**". */
function commentTags(body: string): { severity: { label: string; className: string } | null; id: string | null } {
  const head = body.split("\n")[0].slice(0, 160);
  const severity = SEVERITIES.find((s) => s.test.test(head)) ?? null;
  const id = /\b([A-Z]{1,3}\d*-\d{1,3})\b/.exec(head)?.[1] ?? null;
  return { severity: severity ? { label: severity.label, className: severity.className } : null, id };
}

function AuthorChip({ login, prAuthor, when }: { login: string; prAuthor: string | null; when?: string }) {
  const bot = isBot(login);
  const author = prAuthor !== null && login.toLowerCase() === prAuthor.toLowerCase();
  const tone = bot ? "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300" : author ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-foreground/5 text-foreground";
  const name = login.replace(/\[bot\]$/i, "");
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 font-sans text-xs">
      <span className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold uppercase", tone)}>{name[0] ?? "?"}</span>
      <span className="truncate font-medium text-foreground">{name}</span>
      {bot ? <span className="rounded-full border border-violet-500/40 px-1.5 text-[10px] text-violet-700 dark:text-violet-300">bot</span> : author ? <span className="rounded-full border border-primary/40 px-1.5 text-[10px] text-primary">author</span> : null}
      {when ? <span className="text-muted-foreground">· {timeAgo(when)}</span> : null}
    </span>
  );
}

/** GitHub comment Markdown: HTML comments dropped, `<details>` rendered as real collapsibles. */
function CommentBody({ body, className }: { body: string; className?: string }) {
  const cleaned = body.replace(/<!--[\s\S]*?-->/g, "");
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

function ThreadCard({ thread, actions }: { thread: GhThread; actions: AnnoActions }) {
  const [open, setOpen] = useState(!thread.isResolved);
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = thread.comments[0];
  const tags = first ? commentTags(first.body) : { severity: null, id: null };
  const preview = (first?.body ?? "").split("\n").find((line) => line.trim() !== "") ?? "";
  useEffect(() => {
    setOpen(!thread.isResolved);
    if (thread.isResolved) setReply(null);
  }, [thread.isResolved]);
  return (
    <div className={cn("my-1.5 rounded-lg border bg-card font-sans text-xs shadow-sm", thread.isResolved ? "border-border/60 opacity-70" : "border-border")}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" />
          <Icon name="Github" className="size-3.5 shrink-0 text-muted-foreground" />
          {first ? <AuthorChip login={first.author} prAuthor={actions.prAuthor} /> : <span className="font-medium">thread</span>}
          {thread.comments.length > 1 ? <span className="text-muted-foreground">+{thread.comments.length - 1}</span> : null}
          {tags.id ? <span className="rounded-full border border-border px-1.5 font-mono text-[10px]">{tags.id}</span> : null}
          {tags.severity ? <span className={cn("rounded-full border px-1.5 text-[10px] font-medium", tags.severity.className)}>{tags.severity.label}</span> : null}
          {thread.isResolved ? <span className="inline-flex items-center gap-0.5 rounded-full border border-primary/40 px-1.5 text-[10px] text-primary"><Icon name="Check" className="size-3" />resolved</span> : null}
          {thread.isOutdated ? <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">outdated</span> : null}
          {!open && preview !== "" ? <span className="min-w-0 truncate text-muted-foreground">{preview}</span> : null}
        </button>
        <span className="ml-auto flex items-center gap-1">
          {first?.url ? <UrlLink href={first.url} className="text-muted-foreground hover:text-foreground" title="Open on GitHub"><Icon name="ExternalLink" className="size-3.5" /></UrlLink> : null}
          {open ? <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setReply((r) => (r === null ? "" : null))}>Reply</Button> : null}
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={async () => { setBusy(true); try { await actions.resolve(thread.id, !thread.isResolved); } finally { setBusy(false); } }}>
            {thread.isResolved ? "Unresolve" : "Resolve"}
          </Button>
        </span>
      </div>
      {open ? (
        <>
          <div className="divide-y divide-border/60 border-t border-border/60">
            {thread.comments.map((c, index) => (
              <div key={c.id} className="px-3 py-2">
                {index > 0 ? <div className="mb-1"><AuthorChip login={c.author} prAuthor={actions.prAuthor} when={c.createdAt} /></div> : <div className="mb-1 text-muted-foreground">{timeAgo(c.createdAt)}</div>}
                <CommentBody body={c.body} />
              </div>
            ))}
          </div>
          {reply !== null ? (
            <form className="flex flex-col gap-1.5 border-t border-border/60 px-3 py-2" onSubmit={async (e: FormEvent) => { e.preventDefault(); const target = first?.databaseId; if (!target || reply.trim() === "") return; setBusy(true); try { await actions.reply(target, reply.trim()); setReply(null); } finally { setBusy(false); } }}>
              <TextArea value={reply} onChange={setReply} rows={3} placeholder="Reply on GitHub…" autoFocus />
              <div className="flex justify-end gap-1.5">
                <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setReply(null)}>Cancel</Button>
                <Button type="submit" size="sm" className="h-7" disabled={busy || reply.trim() === ""}>Reply</Button>
              </div>
            </form>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function PendingCard({ pending, actions }: { pending: PendingComment; actions: AnnoActions }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="my-1.5 rounded-lg border border-dashed border-foreground/40 bg-card font-sans text-xs shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <Icon name="Edit" className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Pending comment</span>
        {pending.stale ? (
          <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground" title="This line is gone from the current diff">stale</span>
        ) : (
          <span className="text-muted-foreground">posts with your review</span>
        )}
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
      <div className="flex items-center gap-1.5">
        <label className="inline-flex items-center gap-1.5 text-muted-foreground"><input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} />Keep private</label>
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={actions.closeComposer}>Cancel</Button>
        <Button type="submit" size="sm" className="h-7" disabled={busy || body.trim() === ""}>{isPrivate ? "Add note" : "Add pending comment"}</Button>
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

function toSelectionRef(selection: Selection): SelectionRef {
  return {
    path: selection.path,
    startLine: Math.min(selection.range.start, selection.range.end),
    endLine: Math.max(selection.range.start, selection.range.end),
    side: (selection.range.side ?? "additions") === "deletions" ? "old" : "new",
  };
}

/** Where a file card's diff comes from: the PR (base..head) or an arbitrary commit range. */
type DiffSource = { kind: "pr" } | { kind: "range"; base: string; head: string };

interface FileCardProps {
  review: Review;
  file: FileEntry;
  /** Commit view: no GitHub threads, notes, viewed marks, or comment composer. */
  source?: DiffSource;
  threads: GhThread[];
  pending: PendingComment[];
  notes: Note[];
  composer: Extract<Anno, { kind: "composer" }> | null;
  selection: Selection | null;
  onSelect(selection: Selection | null): void;
  onOpenComposer(path: string, range: SelectedLineRange): void;
  expanded: boolean;
  onToggle(): void;
  onViewed(viewed: boolean): void;
  diffStyle: "unified" | "split";
  theme: { dark: string; light: string; mode: "dark" | "light" };
  actions: AnnoActions;
  rpc: ReturnType<typeof useRpc<Contract>>;
  onAttach(selection: SelectionRef): void;
  onSummarize(): void;
  onCouncil(text: string): void;
  alsoIn?: StackView["entries"];
  onOpenSlice?(entry: StackView["entries"][number]): void;
  /** Load the patch as soon as the card mounts, not when it scrolls into view. */
  eager?: boolean;
  /** Hide the expand/collapse control when the card is the only file on screen. */
  showToggle?: boolean;
}

function FileCard(props: FileCardProps) {
  const { review, file, expanded, onToggle, selection, diffStyle, theme, actions, rpc } = props;
  const source: DiffSource = props.source ?? { kind: "pr" };
  const inCommit = source.kind === "range";
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const eager = props.eager === true;
  const [visible, setVisible] = useState(eager);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const { name, dir } = splitPath(file.path);

  useEffect(() => {
    if (eager) {
      setVisible(true);
      return;
    }
    const el = ref.current;
    if (el === null) return;
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), { rootMargin: "900px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [eager]);

  const sourceKey = source.kind === "pr" ? `pr:${review.headSha}` : `range:${source.base}..${source.head}`;
  const rangeBase = source.kind === "range" ? source.base : null;
  const rangeHead = source.kind === "range" ? source.head : null;
  useEffect(() => {
    setPatch(null);
    setError(null);
    if (!expanded || !visible || file.binary) return;
    let cancelled = false;
    const request = rangeBase === null || rangeHead === null
      ? rpc.call("review_patch", { reviewId: review.id, path: file.path })
      : rpc.call("commit_patch", { reviewId: review.id, base: rangeBase, head: rangeHead, path: file.path, oldPath: file.oldPath });
    request.then(
      (r) => { if (!cancelled) setPatch(r.patch); },
      (c: unknown) => { if (!cancelled) setError(describeError(c)); },
    );
    return () => { cancelled = true; };
  }, [expanded, visible, file.binary, file.path, file.oldPath, review.id, rpc, rangeBase, rangeHead, sourceKey]);

  const fileDiff = useMemo<FileDiffMetadata | null>(() => {
    if (patch === null) return null;
    return pickFileDiff(patch, file.path, file.oldPath);
  }, [patch, file.path, file.oldPath]);

  const annotations = useMemo<DiffLineAnnotation<Anno>[]>(() => {
    const list: DiffLineAnnotation<Anno>[] = [];
    for (const thread of props.threads) {
      const line = thread.line ?? thread.originalLine;
      if (line === null) continue;
      const side = thread.side === "LEFT" ? "deletions" : "additions";
      list.push({ side, lineNumber: annotationLine(fileDiff, side, line), metadata: { kind: "thread", thread } });
    }
    for (const pending of props.pending) {
      const side = pending.side === "LEFT" ? "deletions" : "additions";
      list.push({ side, lineNumber: annotationLine(fileDiff, side, pending.line), metadata: { kind: "pending", pending } });
    }
    for (const note of props.notes) {
      const side = note.side === "LEFT" ? "deletions" : "additions";
      list.push({ side, lineNumber: annotationLine(fileDiff, side, note.line), metadata: { kind: "note", note } });
    }
    if (props.composer) list.push({ side: props.composer.side === "LEFT" ? "deletions" : "additions", lineNumber: props.composer.line, metadata: props.composer });
    return list;
  }, [props.threads, props.pending, props.notes, props.composer, fileDiff]);

  const selected = selection?.path === file.path ? selection.range : null;
  const loadDiffFiles = useCallback(
    async (meta: FileDiffMetadata) => {
      const [oldSide, newSide] = source.kind === "pr"
        ? await Promise.all([
            rpc.call("review_file", { reviewId: review.id, path: file.path, side: "old" }),
            rpc.call("review_file", { reviewId: review.id, path: file.path, side: "new" }),
          ])
        : await Promise.all([
            rpc.call("commit_file", { reviewId: review.id, sha: source.base, path: file.oldPath ?? file.path }),
            rpc.call("commit_file", { reviewId: review.id, sha: source.head, path: file.path }),
          ]);
      return {
        oldFile: { name: meta.prevName ?? meta.name, contents: oldSide.content ?? "" },
        newFile: { name: meta.name, contents: newSide.content ?? "" },
      };
    },
    [rpc, review.id, file.path, file.oldPath, source],
  );

  return (
    <div ref={ref} id={fileAnchorId(file.path)} className="scroll-mt-3 rounded-lg border border-border bg-card">
      <div className="sticky top-0 z-10 flex items-center gap-2 rounded-t-lg border-b border-border bg-card/95 px-3 py-2 text-xs backdrop-blur">
        {props.showToggle === false ? null : (
          <button type="button" onClick={onToggle} className="text-muted-foreground hover:text-foreground" aria-expanded={expanded} aria-label={expanded ? "Collapse file" : "Expand file"}>
            <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-foreground">{name}</span>
          {dir ? <span className="ml-2 text-muted-foreground">{dir}</span> : null}
          {file.oldPath && file.oldPath !== file.path ? <span className="ml-2 text-muted-foreground">renamed from {file.oldPath}</span> : null}
        </span>
        {file.unresolvedCount > 0 ? <span className="inline-flex items-center gap-1 text-muted-foreground" title={`${file.unresolvedCount} open GitHub thread${file.unresolvedCount === 1 ? "" : "s"}`}><Icon name="Github" className="size-3" />{file.unresolvedCount}</span> : null}
        {file.pendingCount > 0 ? <span className="inline-flex items-center gap-1 text-muted-foreground" title={`${file.pendingCount} pending`}><Icon name="Edit" className="size-3" />{file.pendingCount}</span> : null}
        {props.notes.filter((n) => n.state === "open" || n.state === "stale").length > 0 ? <span className="inline-flex items-center gap-1 text-amber-800 dark:text-amber-200" title="Open notes"><Icon name="MessageSquarePlus" className="size-3" />{props.notes.filter((n) => n.state === "open" || n.state === "stale").length}</span> : null}
        {(props.alsoIn ?? []).length > 0 ? (
          <span className="inline-flex max-w-[40%] flex-wrap items-center gap-1 text-[10px] text-muted-foreground" title="Also changed in other stack layers">
            <Icon name="Layers" className="size-3" />
            {(props.alsoIn ?? []).slice(0, 4).map((e) => (
              <button
                key={e.number}
                type="button"
                className="inline-flex items-center gap-1 rounded border border-border px-1 font-mono hover:bg-state-hover hover:text-foreground"
                title={`#${e.number} ${e.title}`}
                onClick={() => props.onOpenSlice?.(e)}
              >
                <PrMark state={e.state} isDraft={e.isDraft} merged={e.merged} className="size-3" />
                #{e.number}
              </button>
            ))}
            {(props.alsoIn ?? []).length > 4 ? <span>+{(props.alsoIn ?? []).length - 4}</span> : null}
          </span>
        ) : null}
        <span className="font-mono"><span className="text-primary">+{file.additions}</span> <span className="ml-1 text-destructive">-{file.deletions}</span></span>
        {inCommit ? null : (
          <Button variant="ghost" size="sm" className={cn("h-6 px-2 text-xs", file.viewed && "text-primary")} onClick={() => props.onViewed(!file.viewed)}>
            {file.viewed ? <><Icon name="Check" className="size-3" />Viewed</> : "Mark as viewed"}
          </Button>
        )}
        <span className="relative">
          <Button variant="ghost" size="sm" className="h-6 w-6 px-0" onClick={() => setMenu((m) => !m)} aria-label="File actions" aria-expanded={menu}><Icon name="MoreHorizontal" className="size-3.5" /></Button>
          {menu ? (
            <div className="absolute right-0 top-full z-20 mt-1 w-52 rounded-md border border-border bg-card p-1 text-xs shadow-md">
              <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-state-hover" onClick={() => { setMenu(false); props.onSummarize(); }}><Icon name="Brain" className="size-3.5" />Summarize in chat</button>
              <FileLink target={{ kind: "host", hostId: review.hostId, path: `${review.worktree}/${file.path}` }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-state-hover" onClick={() => setMenu(false)}><Icon name="ExternalLink" className="size-3.5" />Open file at head</FileLink>
              <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-state-hover" onClick={() => { void navigator.clipboard?.writeText(file.path); setMenu(false); toast.success("Path copied"); }}><Icon name="Copy" className="size-3.5" />Copy path</button>
            </div>
          ) : null}
        </span>
      </div>

      {selected ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-2 text-xs">
          <span className="font-mono text-muted-foreground">
            L{Math.min(selected.start, selected.end)}{selected.start !== selected.end ? `–${Math.max(selected.start, selected.end)}` : ""}{selected.side === "deletions" ? " (base)" : ""}
          </span>
          <Button type="button" size="sm" className="h-7 text-xs" onClick={() => props.onAttach(toSelectionRef({ path: file.path, range: selected }))} title="Put these lines in the chat as a pill, then ask (shortcut: a)">
            <Icon name="Brain" className="size-3.5" />Add to chat<kbd className="ml-1 rounded border border-primary-foreground/40 px-1 font-mono text-[10px] opacity-80">a</kbd>
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => props.onOpenComposer(file.path, selected)} title={inCommit ? "Comments live on the PR diff; this jumps to the same file and line at the PR head" : undefined}><Icon name="Edit" className="size-3.5" />{inCommit ? "Comment at head" : "Comment"}</Button>
          <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => props.onCouncil(`${review.owner}/${review.repo}#${review.number} · ${file.path}:${Math.min(selected.start, selected.end)}-${Math.max(selected.start, selected.end)} (head ${shortSha(review.headSha)})\n\nPlease look at this range.`)} title="Send this range to a Roundtable room"><Icon name="MessageSquare" className="size-3.5" />Council</Button>
          <span className="flex-1" />
          <Button type="button" variant="ghost" size="sm" className="h-7 w-7 px-0" onClick={() => props.onSelect(null)} aria-label="Clear selection"><Icon name="X" className="size-3.5" /></Button>
        </div>
      ) : null}

      {!expanded ? null : file.binary ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">Binary file.</div>
      ) : error ? (
        <div className="px-3 py-3 text-xs text-destructive">{error}</div>
      ) : patch === null ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">{visible ? "Loading diff…" : `${file.additions + file.deletions} changed lines`}</div>
      ) : fileDiff === null ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">No textual diff.</div>
      ) : (
        <div className="overflow-x-auto text-[12.5px]">
          <FileDiff<Anno>
            fileDiff={fileDiff}
            options={{
              diffStyle,
              theme: { dark: theme.dark, light: theme.light },
              themeType: theme.mode,
              disableFileHeader: true,
              enableLineSelection: true,
              controlledSelection: true,
              lineHoverHighlight: "both",
              enableGutterUtility: true,
              onLineSelected: (range) => props.onSelect(range === null ? null : { path: file.path, range }),
              onGutterUtilityClick: (range) => props.onOpenComposer(file.path, range),
              loadDiffFiles,
              hunkSeparators: "line-info",
              overflow: "scroll",
            }}
            selectedLines={selected}
            lineAnnotations={annotations}
            renderAnnotation={(annotation) => <Annotation anno={annotation.metadata} actions={actions} />}
          />
        </div>
      )}
      {!expanded || inCommit || fileDiff !== null || (patch === null && !file.binary && error === null) ? null : props.pending.length === 0 && props.notes.filter((n) => n.state === "open" || n.state === "stale").length === 0 ? null : (
        <div className="space-y-1 border-t border-border px-2 py-2">
          {props.pending.map((pending) => <PendingCard key={pending.id} pending={pending} actions={actions} />)}
          {props.notes.filter((n) => n.state === "open" || n.state === "stale").map((note) => <NoteCard key={note.id} note={note} actions={actions} />)}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Room sender (Roundtable bridge)
// ---------------------------------------------------------------------------

function RoomSender({ text, onClose }: { text: string; onClose: () => void }) {
  const rpc = useRpc<Contract>();
  const [rooms, setRooms] = useState<{ id: string; title: string; handles: string[] }[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [roomId, setRoomId] = useState("");
  const [body, setBody] = useState(text);
  const [tags, setTags] = useState<string[]>([]);
  const [turns, setTurns] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    rpc.call("rooms_list").then((r) => { setRooms(r.rooms); setAvailable(r.available); setRoomId(r.rooms[0]?.id ?? ""); }, (c: unknown) => setError(describeError(c)));
  }, [rpc]);
  const room = rooms?.find((r) => r.id === roomId);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/60 p-4" role="dialog" aria-label="Send to the council">
      <form className="w-full max-w-lg space-y-3 rounded-lg border border-border bg-card p-4 text-sm shadow-lg" onSubmit={async (e: FormEvent) => { e.preventDefault(); if (roomId === "" || body.trim() === "") return; setBusy(true); setError(null); try { await rpc.call("send_to_room", { roomId, text: body.trim(), tags, turns }); toast.success("Sent to the room"); onClose(); } catch (cause) { setError(describeError(cause)); } finally { setBusy(false); } }}>
        <div className="flex items-center justify-between">
          <span className="font-semibold">Send to the council</span>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close"><Icon name="X" className="size-4" /></Button>
        </div>
        {!available ? <p className="text-xs text-destructive">The Roundtable plugin is not running.</p> : null}
        <label className="block space-y-1 text-xs text-muted-foreground">
          Room
          <select value={roomId} onChange={(e) => { setRoomId(e.target.value); setTags([]); }} className="block h-8 w-full rounded-md border border-input bg-background px-2 text-xs">
            {(rooms ?? []).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
          </select>
        </label>
        {room ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Tag:</span>
            {room.handles.map((h) => (
              <button key={h} type="button" onClick={() => setTags((t) => (t.includes(h) ? t.filter((x) => x !== h) : [...t, h]))} className={cn("rounded-full border border-border px-2 py-0.5", tags.includes(h) && "bg-foreground text-background")}>@{h}</button>
            ))}
            <label className="ml-auto inline-flex items-center gap-1 text-muted-foreground">Turns<Input type="number" min={0} max={40} value={turns} onChange={(e) => setTurns(Math.max(0, Math.min(40, Number(e.target.value) || 0)))} className="h-7 w-14 text-xs" /></label>
          </div>
        ) : null}
        <TextArea value={body} onChange={setBody} rows={8} />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={busy || roomId === "" || body.trim() === ""}><Icon name="Sent" className="size-3.5" />Send</Button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review page
// ---------------------------------------------------------------------------

function Description({ body }: { body: string }) {
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

function Discussion({ reviewId, threads, onJump }: { reviewId: string; threads: GhThread[]; onJump: JumpFn }) {
  const rpc = useRpc<Contract>();
  const [conversation, setConversation] = useState<{ comments: { id: number; author: string; body: string; createdAt: string; url: string }[]; reviews: { id: number; author: string; state: string; body: string; submittedAt: string | null; url: string }[] } | null>(null);
  const load = useCallback((refresh = false) => {
    rpc.call("review_conversation", { reviewId, refresh }).then((r) => setConversation({ comments: r.comments, reviews: r.reviews }), () => undefined);
  }, [rpc, reviewId]);
  useEffect(() => { load(); }, [load]);
  useRealtime(REVIEW_CHANGED, (payload) => {
    const p = payloadReview(payload);
    if (p !== null && p.reviewId === reviewId && (p.what === "synced" || p.what === "conversation" || p.what === "threads")) load();
  });
  const open = threads.filter((t) => !t.isResolved);
  if (conversation === null) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const items = [
    ...conversation.reviews.map((r) => ({ key: `r-${r.id}`, author: r.author, when: r.submittedAt, body: r.body, badge: r.state, url: r.url })),
    ...conversation.comments.map((c) => ({ key: `c-${c.id}`, author: c.author, when: c.createdAt, body: c.body, badge: null as string | null, url: c.url })),
  ].sort((a, b) => Date.parse(a.when ?? "") - Date.parse(b.when ?? ""));
  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{items.length} comments and reviews · {open.length} open threads in the diff</span>
        <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => { load(true); void rpc.call("review_threads_refresh", { reviewId }); }} aria-label="Refresh discussion"><Icon name="ArrowReloadHorizontal" className="size-3.5" /></Button>
      </div>
      {open.length > 0 ? (
        <div className="rounded-lg border border-border">
          <div className="border-b border-border px-3 py-1.5 text-xs font-medium">Open threads</div>
          <ul className="divide-y divide-border/60">
            {open.slice(0, 40).map((t) => (
              <li key={t.id} className="flex items-baseline gap-2 px-3 py-1.5 text-xs">
                <button type="button" onClick={() => onJump(t.path, t.line, t.side === "LEFT" ? "old" : "new")} className="shrink-0 font-mono hover:underline">{splitPath(t.path).name}{t.line ? `:${t.line}` : ""}</button>
                <span className="min-w-0 truncate text-muted-foreground"><span className="font-medium text-foreground">{t.comments[0]?.author}</span> {t.comments[0]?.body.split("\n")[0]}</span>
              </li>
            ))}
            {open.length > 40 ? <li className="px-3 py-1.5 text-xs text-muted-foreground">and {open.length - 40} more in the diff</li> : null}
          </ul>
        </div>
      ) : null}
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.key} className="rounded-lg border border-border bg-card p-3">
            <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{item.author}</span>
              {item.badge ? <span className={cn("inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0 text-[10px] uppercase", reviewStateTone(item.badge))}>{item.badge.replace(/_/g, " ").toLowerCase()}</span> : null}
              {item.when ? <span>{timeAgo(item.when)}</span> : null}
              <UrlLink href={item.url} className="ml-auto hover:text-foreground" title="Open on GitHub"><Icon name="ExternalLink" className="size-3.5" /></UrlLink>
            </div>
            {item.body.trim() === "" ? <span className="text-xs text-muted-foreground">No text.</span> : <Markdown content={item.body} />}
          </li>
        ))}
      </ul>
    </div>
  );
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
        <span>Click a commit for its diff.{anchor !== null ? <> Shift-click another to diff it together with <span className="font-mono">{shortSha(anchor)}</span>.</> : " Shift-click a second one for the range between them."}</span>
        {newCount > 0 && seen.prevHead !== null ? (
          <Button variant="outline" size="sm" className="ml-auto h-6 text-xs" onClick={() => onOpen({ from: ordered[prevIndex + 1].sha, to: ordered[ordered.length - 1].sha, inclusive: true })}>
            Diff the {newCount} new commit{newCount === 1 ? "" : "s"} since you last looked
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
                <span className="shrink-0 text-xs text-muted-foreground">{c.author} · {timeAgo(c.date)}</span>
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
// Commit view: one commit or a range of the PR as a diff, read-only apart
// from the chat. Comments, threads, notes, and viewed marks belong to the
// PR head diff and are not shown here.
// ---------------------------------------------------------------------------

interface CommitData {
  base: string;
  head: string;
  info: CommitInfo;
  commits: CommitInfo[];
  files: ChangedFile[];
}

function CommitView({ reviewId, review, target, rpc, onNavigate }: {
  reviewId: string;
  review: Review;
  target: CommitTarget;
  rpc: ReturnType<typeof useRpc<Contract>>;
  onNavigate(target: CommitTarget | null): void;
}) {
  const [data, setData] = useState<CommitData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMessage, setShowMessage] = useState(false);
  const key = commitPath(reviewId, target);
  useEffect(() => {
    setData(null);
    setError(null);
    rpc.call("commit_get", { reviewId, to: target.to, ...(target.from === null ? {} : { from: target.from, inclusive: target.inclusive }) }).then(setData, (c: unknown) => setError(describeError(c)));
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
        <div className="mt-3 text-xs text-muted-foreground">The diff is in the Diff pane. Threads, pending comments, notes, and viewed marks live on the pull request head.</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brief: slop score from deterministic signals, plus a plain-English
// summary, areas, claims checked against the diff, and a model score.
// ---------------------------------------------------------------------------

type JumpFn = (path: string, line: number | null, side: "old" | "new") => void;

function scoreTone(score: number): string {
  return score < 20 ? "text-primary" : score < 45 ? "text-amber-600 dark:text-amber-400" : score < 70 ? "text-orange-600 dark:text-orange-400" : "text-destructive";
}

const VERDICT_STYLE: Record<ClaimVerdict, { label: string; className: string }> = {
  matches: { label: "matches", className: "border-primary/40 bg-primary/10 text-primary" },
  partly: { label: "partly", className: "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  "no-evidence": { label: "no evidence", className: "border-border bg-muted text-muted-foreground" },
  contradicted: { label: "contradicted", className: "border-destructive/50 bg-destructive/10 text-destructive" },
};

function EvidenceLink({ path, line, side, note, onJump }: { path: string; line: number | null; side: "old" | "new"; note?: string; onJump: JumpFn }) {
  if (path === "") return <span className="text-muted-foreground">{note}</span>;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5">
      <button type="button" onClick={() => onJump(path, line, side)} className="shrink-0 font-mono text-[11px] text-foreground hover:underline" title={path}>
        {splitPath(path).name}{line !== null ? `:${line}` : ""}
      </button>
      {note ? <span className="min-w-0 text-muted-foreground">{note}</span> : null}
    </span>
  );
}

function SlopMeter({
  report,
  aiScore,
  reasons,
  onJump,
  onRecompute,
  computing,
  stale,
  helperModel,
  models,
  onModel,
  signalNotes,
  onToggleSignal,
}: {
  report: SlopReport | null;
  aiScore: number | null;
  reasons: Brief["ai"]["reasons"];
  onJump: JumpFn;
  onRecompute: () => void;
  computing: boolean;
  stale: boolean;
  helperModel: string;
  models: ProviderOption["models"];
  onModel: (model: string) => void;
  signalNotes: Set<string>;
  onToggleSignal: (signalId: string, show: boolean) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const det = report?.score ?? null;
  const shown = det ?? aiScore;
  const maxScore = Math.max(1, ...(report?.signals.map((s) => s.score) ?? [1]));
  const modelOptions = models.some((m) => m.model === helperModel)
    ? models
    : helperModel === ""
      ? models
      : [{ model: helperModel, displayName: helperModel, isDefault: false }, ...models];
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">Slop</span>
        {report?.aiAttributed ? (
          <span title="Description credits an AI"><Icon name="Bot" className="size-3.5 text-violet-600 dark:text-violet-300" /></span>
        ) : null}
        {modelOptions.length > 0 && helperModel !== "" ? (
          <select
            className="ml-auto h-6 max-w-[11rem] truncate rounded-md border-0 bg-transparent text-[11px] text-muted-foreground"
            value={helperModel}
            disabled={computing}
            title="Model for the score"
            onChange={(e) => onModel(e.target.value)}
          >
            {modelOptions.map((m) => (
              <option key={m.model} value={m.model}>{m.displayName}</option>
            ))}
          </select>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-6 w-6 px-0", modelOptions.length === 0 && "ml-auto", stale && !computing && "text-destructive hover:text-destructive")}
          onClick={onRecompute}
          disabled={computing}
          title={stale ? "Head moved. Recalculate signals and the model score." : "Recalculate signals and the model score"}
        >
          <Icon name="ArrowReloadHorizontal" className={cn("size-3.5", computing && "animate-spin")} />
        </Button>
      </div>
      {report === null ? (
        <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Icon name="Loading" className="size-3.5 animate-spin" /></p>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-4">
            <div className={cn("text-4xl font-semibold tabular-nums leading-none", scoreTone(shown ?? 0))}>{shown ?? "—"}</div>
            <div className="min-w-0 flex-1">
              <div className="relative mt-1.5 h-2 rounded-full bg-gradient-to-r from-primary/40 via-amber-400/60 to-destructive/70">
                <div className="absolute -top-0.5 size-3 -translate-x-1/2 rounded-full border-2 border-background bg-foreground shadow" style={{ left: `${shown ?? 0}%` }} />
              </div>
              <div className="mt-2 flex items-center gap-3 text-xs tabular-nums text-muted-foreground">
                <span className="inline-flex items-center gap-1" title="Signals from the diff">
                  <Icon name="ChartColumn" className="size-3.5" />{det ?? "—"}
                </span>
                <span className="inline-flex items-center gap-1" title="Model score">
                  <Icon name="Bot" className="size-3.5" />{aiScore ?? (computing ? "…" : "—")}
                </span>
                <span className="ml-auto inline-flex items-center gap-1" title="Added lines">
                  <Icon name="FileDiff" className="size-3.5" />{report.stats.addedLines.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
          {reasons.length > 0 ? (
            <ul className="mt-3 space-y-1.5 text-xs">
              {reasons.map((r, i) => (
                <li key={i} className="flex gap-2">
                  <Icon name="Bot" className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="text-foreground">{r.reason}</span>
                    {r.evidence.length > 0 ? (
                      <span className="ml-2 inline-flex flex-wrap gap-x-2">
                        {r.evidence.map((e, j) => (
                          e.found
                            ? <EvidenceLink key={j} path={e.path} line={e.line} side="new" onJump={onJump} />
                            : <span key={j} className="font-mono text-[11px] text-muted-foreground line-through" title="not in this diff">{splitPath(e.path).name}{e.line !== null ? `:${e.line}` : ""}</span>
                        ))}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {report.signals.length === 0 ? <p className="mt-3 text-xs text-muted-foreground">No signals fired.</p> : (
            <ul className="mt-3 divide-y divide-border/60 rounded-md border border-border/60">
              {report.signals.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => setOpen((o) => (o === s.id ? null : s.id))} className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs hover:bg-state-hover" aria-expanded={open === s.id}>
                    <Icon name={open === s.id ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="w-44 shrink-0 font-medium">{s.label}</span>
                    <span className="w-10 shrink-0 rounded-full bg-foreground/10 px-1.5 text-center tabular-nums">{s.count}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{s.description}</span>
                    <span className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-border"><span className="block h-full rounded-full bg-amber-500/80" style={{ width: `${Math.round((100 * s.score) / maxScore)}%` }} /></span>
                  </button>
                  {open === s.id ? (
                    <ul className="space-y-1 border-t border-border/60 bg-background/60 px-3 py-2 text-xs">
                      {s.evidence.some((e: SlopEvidence) => e.line !== null) ? (
                        <li className="flex items-center gap-2 pb-1">
                          <Button variant={signalNotes.has(s.id) ? "default" : "outline"} size="sm" className="h-6 text-xs" onClick={() => onToggleSignal(s.id, !signalNotes.has(s.id))}>
                            {signalNotes.has(s.id) ? "Hide notes in the diff" : "Show as notes in the diff"}
                          </Button>
                        </li>
                      ) : null}
                      {s.evidence.map((e: SlopEvidence, i) => (
                        <li key={i} className="flex gap-2"><EvidenceLink path={e.path} line={e.line} side={e.side} note={e.note} onJump={onJump} /></li>
                      ))}
                      {s.count > s.evidence.length ? <li className="text-muted-foreground">and {s.count - s.evidence.length} more</li> : null}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function BriefPanel({ reviewId, onJump, signalNotes, onToggleSignal }: { reviewId: string; onJump: JumpFn; signalNotes: Set<string>; onToggleSignal: (signalId: string, show: boolean) => void }) {
  const { state, error, refresh, setModel } = useBrief(reviewId);
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  const report = (state?.signalsStatus === "ready" ? (state.signals as unknown as SlopReport | null) : null) ?? null;
  const brief = (state?.briefStatus === "ready" ? (state.brief as unknown as Brief | null) : null) ?? null;
  const writing = state?.briefStatus === "writing";
  const models = state?.helperModels ?? [];
  const evidenceList = (list: BriefEvidence[]) => (
    <span className="inline-flex flex-wrap gap-x-2">
      {list.map((e, i) => (e.found ? <EvidenceLink key={i} path={e.path} line={e.line} side="new" onJump={onJump} /> : <span key={i} className="font-mono text-[11px] text-muted-foreground line-through" title="not in this diff">{splitPath(e.path).name}{e.line !== null ? `:${e.line}` : ""}</span>))}
    </span>
  );
  return (
    <div className="space-y-4 text-sm">
      <SlopMeter
        report={report}
        aiScore={brief?.ai.score ?? null}
        reasons={brief?.ai.reasons ?? []}
        onJump={onJump}
        onRecompute={refresh}
        computing={state?.signalsStatus === "computing" || writing}
        stale={state?.stale === true}
        helperModel={state?.helperModel ?? ""}
        models={models}
        onModel={setModel}
        signalNotes={signalNotes}
        onToggleSignal={onToggleSignal}
      />
      {state?.signalsStatus === "failed" ? <p className="text-xs text-destructive">Signals failed: {state.signalsError}</p> : null}

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">What it does</span>
        </div>
        {brief === null ? (
          writing ? (
            <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Icon name="Loading" className="size-3.5 animate-spin" /></p>
          ) : state?.briefStatus === "failed" ? (
            <p className="mt-3 text-xs text-destructive">{state.briefError ?? "unknown error"}</p>
          ) : state === null ? (
            <p className="mt-3 text-xs text-muted-foreground">Loading…</p>
          ) : null
        ) : (
          <>
            <div className={cn(PROSE, "mt-3 text-sm")}><Markdown content={brief.summary} /></div>
            {brief.areas.length > 0 ? (
              <ul className="mt-4 divide-y divide-border/60 rounded-md border border-border/60 text-xs">
                {brief.areas.map((a) => (
                  <li key={a.module} className="flex items-baseline gap-3 px-3 py-1.5">
                    {a.path ? <button type="button" onClick={() => onJump(a.path ?? "", null, "new")} className="w-48 shrink-0 truncate text-left font-mono hover:underline" title={a.path}>{a.module}</button> : <span className="w-48 shrink-0 truncate font-mono">{a.module}</span>}
                    <span className="min-w-0 text-foreground">{a.what}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </section>

      {brief !== null && brief.claims.length > 0 ? (
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Claims versus diff</span>
            <span className="text-xs text-muted-foreground">
              {brief.claims.filter((c) => c.verdict === "matches").length}/{brief.claims.length}
            </span>
          </div>
          <ul className="mt-3 space-y-2 text-xs">
            {brief.claims.map((c, i) => (
              <li key={i} className="flex gap-3 rounded-md border border-border/60 px-3 py-2">
                <span className={cn("mt-0.5 h-fit shrink-0 rounded-full border px-1.5 text-[10px] font-medium", VERDICT_STYLE[c.verdict].className)}>{VERDICT_STYLE[c.verdict].label}</span>
                <span className="min-w-0 flex-1">
                  <span className="text-foreground">{c.claim}</span>
                  {c.note ? <span className="block text-muted-foreground">{c.note}</span> : null}
                  {c.evidence.length > 0 ? <span className="mt-0.5 block">{evidenceList(c.evidence)}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function StackRail({
  review,
  stack,
  opening,
  onOpen,
}: {
  review: Review;
  stack: StackView;
  opening: number | null;
  onOpen: (entry: StackView["entries"][number]) => void;
}) {
  const storageKey = stackRailKey(review.owner, review.repo, stack);
  const [expanded, setExpanded] = useState(() => readStorage<boolean>(storageKey) ?? true);
  const toggle = () => {
    setExpanded((open) => {
      const next = !open;
      writeStorage(storageKey, next);
      return next;
    });
  };
  return (
    <div className="border-b border-border bg-card/50">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-state-hover"
        aria-expanded={expanded}
        title={expanded ? "Collapse stack" : "Expand stack"}
      >
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
        <Icon name="GitPullRequestArrow" className="size-3.5" />
        {stack.number !== null ? <span className="font-mono font-medium text-foreground" title={`GitHub stack #${stack.number}`}>#{stack.number}</span> : null}
        <LayerMark position={stack.currentPosition} size={stack.entries.length} />
        <span className="inline-flex items-center gap-1 font-mono" title={`Trunk ${stack.baseRefName}`}>
          <Icon name="GitBranch" className="size-3.5" />
          {stack.baseRefName}
        </span>
        {stack.source === "inferred" ? <span title="Inferred from PR bases"><Icon name="Info" className="size-3.5" /></span> : null}
        <span className="ml-auto inline-flex items-center gap-1 font-mono text-[10px]">
          <kbd className="rounded border border-border px-1" title="Previous layer">[</kbd>
          <kbd className="rounded border border-border px-1" title="Next layer">]</kbd>
        </span>
      </button>
      {expanded ? (
        <ol className="max-h-48 space-y-px overflow-y-auto px-2 pb-2">
          {stack.entries.map((entry) => {
            const current = entry.number === review.number;
            return (
              <li key={entry.number}>
                <button
                  type="button"
                  disabled={opening !== null}
                  onClick={() => { if (!current) onOpen(entry); }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs",
                    current ? "bg-state-active" : "hover:bg-state-hover",
                    (entry.merged || entry.state !== "OPEN") && !current ? "text-muted-foreground" : "",
                  )}
                  title={`${entry.headRefName} → ${entry.baseRefName}`}
                >
                  <span className="w-4 shrink-0 text-right font-mono text-muted-foreground">{entry.position}</span>
                  <PrMark state={entry.state} isDraft={entry.isDraft} merged={entry.merged} />
                  <span className="w-12 shrink-0 font-mono">#{entry.number}</span>
                  <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                  <CountBadge count={entry.pendingCount} title={`${entry.pendingCount} pending`} />
                  {entry.reviewId !== null && entry.changedFiles > 0 ? (
                    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground" title={`${entry.viewedCount} of ${entry.changedFiles} files viewed`}>
                      <Icon name="Eye" className="size-3" />
                      {entry.viewedCount}/{entry.changedFiles}
                    </span>
                  ) : null}
                  <span className="shrink-0 font-mono"><span className="text-primary">+{entry.additions}</span> <span className="ml-1 text-destructive">-{entry.deletions}</span></span>
                  {opening === entry.number ? <Icon name="Loading" className="size-3 animate-spin" /> : null}
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

type Tab = "brief" | "description" | "discussion" | "commits";

function ReviewView({ reviewId, commit }: { reviewId: string; commit: CommitTarget | null }) {
  const { rpc, detail, error, refetch } = useReview(reviewId);
  const panel = useAppPanel();
  const navigate = useBbNavigate();

  useEffect(() => {
    rpc.call("review_seen", { reviewId }).then(() => refetch(), () => undefined);
  }, [rpc, reviewId, refetch]);
  useEffect(() => {
    if (pendingJump !== null && pendingJump.reviewId === reviewId) return;
    openDiff(panel, reviewId, undefined, commit);
  }, [panel, reviewId, commit?.to, commit?.from, commit?.inclusive]);

  const [tab, setTab] = useState<Tab>("brief");
  const [busy, setBusy] = useState<string | null>(null);
  const [openingSlice, setOpeningSlice] = useState<number | null>(null);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
    } catch (cause) {
      toast.error(describeError(cause));
    } finally {
      setBusy(null);
    }
  };

  const openChat = useCallback(() => panel.openFixedTab({ surface: { kind: "current" }, tab: CHAT_TAB, target: { reviewId } }), [panel, reviewId]);

  const openStackEntry = useCallback(async (entry: StackView["entries"][number]) => {
    if (detail === null || entry.number === detail.review.number) return;
    setOpeningSlice(entry.number);
    try {
      await openSlice(rpc, navigate, detail.review.owner, detail.review.repo, entry);
    } catch (cause) {
      toast.error(describeError(cause));
    } finally {
      setOpeningSlice(null);
    }
  }, [detail, navigate, rpc]);

  const jumpToLine = useCallback<JumpFn>((path, line, side) => {
    openDiff(panel, reviewId, { path, line, side });
  }, [panel, reviewId]);

  useEffect(() => {
    if (error !== "closed" && error !== "removed") return;
    navigate.toPluginPanel(PANEL_PATH);
    if (error === "closed") toast.message("This pull request closed on GitHub");
  }, [error, navigate]);

  useEffect(() => {
    const stack = detail?.stack ?? null;
    if (stack === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" && e.key !== "]") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const next = stack.entries.find((entry) => entry.position === stack.currentPosition + (e.key === "[" ? -1 : 1));
      if (next === undefined) {
        toast.message(e.key === "[" ? "Already at the bottom of the stack" : "Already at the top of the stack");
        return;
      }
      e.preventDefault();
      void openStackEntry(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail?.stack, openStackEntry]);

  const openCommit = useCallback((target: CommitTarget | null) => {
    navigate.toPluginPanel(PANEL_PATH, { subPath: target === null ? reviewId : commitPath(reviewId, target) });
  }, [navigate, reviewId]);

  useEffect(() => {
    if (commit !== null || detail === null || pendingJump === null || pendingJump.reviewId !== reviewId) return;
    const jump = pendingJump;
    pendingJump = null;
    openDiff(panel, reviewId, jump);
  }, [commit, detail, panel, reviewId]);

  if (error === "closed" || error === "removed") return <div className="p-6"><EmptyState>Returning to reviews…</EmptyState></div>;
  if (error !== null) return <div className="p-6"><p role="alert" className="text-sm text-destructive">{error}</p></div>;
  if (detail === null) return <div className="p-6"><EmptyState>Loading review…</EmptyState></div>;

  const { review, files, threads, pending, stack, notes } = detail;
  const stackRail = stack !== null ? <StackRail review={review} stack={stack} opening={openingSlice} onOpen={(entry) => void openStackEntry(entry)} /> : null;
  const topBar = (
    <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
      <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={() => (commit === null ? navigate.toPluginPanel(PANEL_PATH) : openCommit(null))} aria-label={commit === null ? "Back to reviews" : "Back to the pull request"}><Icon name="ChevronLeft" className="size-4" /></Button>
      <PrMark state={review.state} isDraft={review.isDraft} />
      <span className="min-w-0 truncate"><span className="text-muted-foreground">#{review.number}</span> <span className="font-medium">{review.title}</span> <span className="text-muted-foreground">{review.repo}</span></span>
      {detail.stack !== null ? <LayerMark position={detail.stack.currentPosition} size={detail.stack.entries.length} className="shrink-0 text-muted-foreground" /> : null}
      {commit !== null ? <span className="shrink-0 text-muted-foreground">{commit.from === null ? shortSha(commit.to) : `${shortSha(commit.from)}..${shortSha(commit.to)}`}</span> : null}
      <span className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="sm" className="h-7 w-7 px-0" onClick={() => void run("sync", async () => { await rpc.call("reviews_sync", { reviewId }); refetch(); toast.success("Synced with GitHub"); })} disabled={busy !== null} aria-label="Sync with GitHub" title="Sync with GitHub">
          <Icon name="ArrowReloadHorizontal" className={cn("size-3.5", busy === "sync" && "animate-spin")} />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 px-0" onClick={() => openDiff(panel, reviewId, undefined, commit)} aria-label="Diff" title="Diff">
          <Icon name="FileDiff" className="size-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 px-0" onClick={() => panel.openFixedTab({ surface: { kind: "current" }, tab: CODEMAP_TAB, target: { reviewId } })} aria-label="Codemap" title="Codemap">
          <Icon name="Layers" className="size-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 px-0" onClick={openChat} aria-label="Chat" title="Chat">
          <Icon name="Brain" className="size-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 px-0" onClick={() => panel.openFixedTab({ surface: { kind: "current" }, tab: INFO_TAB, target: { reviewId } })} aria-label="Submit review" title="Submit review">
          <Icon name="Github" className="size-3.5" />
          <CountBadge count={pending.length} title={`${pending.length} pending`} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 px-0 text-muted-foreground hover:text-destructive"
          disabled={busy !== null}
          onClick={() => {
            if (!confirmRemoveReview()) return;
            void run("remove", async () => {
              await rpc.call("reviews_remove", { reviewId });
              navigate.toPluginPanel(PANEL_PATH);
              toast.success("Removed from Review Desk");
            });
          }}
          aria-label="Remove review"
          title="Remove from Review Desk"
        >
          <Icon name="Trash2" className={cn("size-3.5", busy === "remove" && "animate-spin")} />
        </Button>
      </span>
    </div>
  );
  if (commit !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {topBar}
        {stackRail}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <CommitView reviewId={reviewId} review={review} target={commit} rpc={rpc} onNavigate={openCommit} />
        </div>
      </div>
    );
  }
  const signalNotes = new Set(notes.filter((n) => n.signalId !== null).map((n) => n.signalId as string));
  const toggleSignalNotes = (signalId: string, show: boolean) =>
    void run("notes", async () => {
      const r = await rpc.call("notes_from_signal", { reviewId, signalId, show });
      refetch();
      toast.success(show ? `${r.count} private note${r.count === 1 ? "" : "s"} added to the diff` : "Notes removed from the diff");
    });
  const openThreads = threads.filter((t) => !t.isResolved).length;
  const repoUrl = review.url.replace(/\/pull\/\d+$/, "");

  return (
    <div className="flex h-full min-h-0 flex-col">
      {topBar}
      {stackRail}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 pb-16 pt-8">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatePill state={review.state} isDraft={review.isDraft} />
              <DraftToggle
                review={review}
                busy={busy === "draft"}
                onToggle={(draft) => void run("draft", async () => {
                  await rpc.call("review_set_draft", { reviewId, draft });
                  refetch();
                  toast.success(draft ? "Converted to draft on GitHub" : "Marked ready for review on GitHub");
                })}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <UrlLink href={repoUrl} className="hover:underline">{review.owner}/{review.repo}</UrlLink>
              <span>#{review.number}</span>
              {stack !== null ? (
                <>
                  {stack.number !== null ? (
                    <span className="inline-flex items-center gap-1" title={`GitHub stack #${stack.number}`}>
                      <Icon name="GitPullRequestArrow" className="size-3.5" />#{stack.number}
                    </span>
                  ) : <span title="Stack"><Icon name="GitPullRequestArrow" className="size-3.5" /></span>}
                  <LayerMark position={stack.currentPosition} size={stack.entries.length} />
                </>
              ) : null}
            </div>
            <h1 className="text-2xl font-semibold leading-tight tracking-tight">
              <UrlLink href={review.url} className="hover:underline">{review.title}</UrlLink>
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {review.author ? <span className="inline-flex items-center gap-1.5"><span className="inline-flex size-5 items-center justify-center rounded-full bg-foreground/10 text-[10px] font-medium uppercase">{review.author[0]}</span>{review.author}</span> : null}
              <span className="rounded-md border border-border bg-card px-1.5 py-0.5 font-mono">{review.baseRefName}</span>
              <Icon name="ChevronLeft" className="size-3 text-muted-foreground" />
              <span className="rounded-md border border-border bg-card px-1.5 py-0.5 font-mono">{review.headRefName}</span>
              <span className="font-mono text-muted-foreground">{shortSha(review.headSha)}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              Opened {timeAgo(review.createdAt)} {files.length} files <span className="text-primary">+{review.additions}</span> <span className="text-destructive">-{review.deletions}</span> {review.commits.length} commits synced {timeAgo(review.syncedAt)}
            </div>
          </div>

          <div className="mt-6 flex items-center gap-1 border-b border-border text-sm">
            {([["brief", "Brief", null], ["description", "Description", null], ["discussion", "Discussion", openThreads], ["commits", "Commits", review.commits.length]] as const).map(([id, label, count]) => (
              <button key={id} type="button" onClick={() => setTab(id)} className={cn("-mb-px border-b-2 px-3 py-2", tab === id ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}>
                {label}{count !== null && count > 0 ? <span className="ml-1.5 rounded-full bg-foreground/10 px-1.5 text-[11px]">{count}</span> : null}
              </button>
            ))}
          </div>
          <div className="mt-4">
            {tab === "brief" ? <BriefPanel reviewId={reviewId} onJump={jumpToLine} signalNotes={signalNotes} onToggleSignal={toggleSignalNotes} /> : tab === "description" ? <Description body={review.body} /> : tab === "discussion" ? <Discussion reviewId={reviewId} threads={threads} onJump={jumpToLine} /> : <Commits review={review} seen={detail.seen} onOpen={openCommit} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Side panel tabs
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
        return (
          <li key={node.file.path}>
            <button
              type="button"
              onClick={() => onSelect(node.file.path)}
              className={cn("flex w-full items-center gap-1 py-0.5 pr-2 text-left hover:bg-state-hover", active && "bg-state-hover")}
              style={{ paddingLeft: 20 + depth * 12 }}
              title={node.file.path}
            >
              <span className={cn("min-w-0 flex-1 truncate", node.file.viewed && "text-muted-foreground")}>{node.name}</span>
              {node.file.unresolvedCount > 0 ? <Icon name="Github" className="size-3 shrink-0 text-muted-foreground" /> : null}
              <span className="shrink-0 font-mono text-[10px]"><span className="text-primary">+{node.file.additions}</span> <span className="text-destructive">-{node.file.deletions}</span></span>
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

function DiffTab({ subPath }: { subPath: string }) {
  const tab = useFixedTabTarget(DIFF_TAB);
  const parsed = parseReviewSubPath(subPath);
  const reviewId = parsed.reviewId;
  const commit = parsed.commit;
  const jump = tab == null || tab.target.reviewId !== reviewId ? null : jumpFromTarget(tab.target);
  const { rpc, detail, error, refetch } = useReview(reviewId);
  const panel = useAppPanel();
  const navigate = useBbNavigate();
  const codeTheme = useCodeTheme();
  const narrow = useNarrow();
  const scope = commit === null ? "pr" : `${commit.from ?? ""}..${commit.to}`;

  const [showTree, setShowTree] = useState(() => !window.matchMedia("(max-width: 767px)").matches && readStorage<boolean>(TREE_KEY) !== false);
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const [selection, setSelectionState] = useState<Selection | null>(null);
  const [composer, setComposer] = useState<Extract<Anno, { kind: "composer" }> | null>(null);
  const [roomText, setRoomText] = useState<string | null>(null);
  const [noteFilter, setNoteFilter] = useState<{ kinds: Set<NoteKind>; showDismissed: boolean }>({ kinds: new Set<NoteKind>(["slop", "cleanup", "risk", "question"]), showDismissed: false });
  const [notesMenu, setNotesMenu] = useState(false);
  const [commitData, setCommitData] = useState<CommitData | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [openingSlice, setOpeningSlice] = useState<number | null>(null);

  useEffect(() => {
    setPicked(reviewId === null ? null : readStorage<string>(fileSelKey(reviewId, scope)));
    setFilter("");
    setComposer(null);
    setCommitData(null);
    setCommitError(null);
  }, [reviewId, scope]);

  useEffect(() => {
    if (reviewId === null || commit === null) {
      setCommitData(null);
      setCommitError(null);
      return;
    }
    setCommitData(null);
    setCommitError(null);
    rpc.call("commit_get", { reviewId, to: commit.to, ...(commit.from === null ? {} : { from: commit.from, inclusive: commit.inclusive }) }).then(
      setCommitData,
      (cause: unknown) => setCommitError(describeError(cause)),
    );
  }, [rpc, reviewId, commit?.to, commit?.from, commit?.inclusive]);

  const setSelection = useCallback((next: Selection | null) => {
    setSelectionState(next);
    if (reviewId === null) return;
    writeStorage(selectionKey(reviewId), next === null ? null : toSelectionRef(next));
    window.dispatchEvent(new CustomEvent(SELECTION_EVENT, { detail: { reviewId } }));
  }, [reviewId]);

  const theme = useMemo(() => {
    const known = SHIKI_THEMES.has(codeTheme.name);
    return {
      dark: known && codeTheme.mode === "dark" ? codeTheme.name : "github-dark",
      light: known && codeTheme.mode === "light" ? codeTheme.name : "github-light",
      mode: codeTheme.mode,
    };
  }, [codeTheme.name, codeTheme.mode]);

  const openChat = useCallback(() => {
    if (reviewId === null) return;
    panel.openFixedTab({ surface: { kind: "current" }, tab: CHAT_TAB, target: { reviewId } });
  }, [panel, reviewId]);

  const attachToChat = useCallback((mention: PluginComposerMention, text?: string) => {
    if (reviewId === null) return;
    queueAttach(reviewId, text === undefined ? { mention } : { mention, text });
    openChat();
  }, [reviewId, openChat]);

  const prAuthor = detail?.review.author ?? null;
  const actions = useMemo<AnnoActions>(() => ({
    prAuthor,
    reply: async (commentId, body) => { if (reviewId === null) return; await rpc.call("thread_reply", { reviewId, commentId, body }); refetch(); toast.success("Reply posted"); },
    resolve: async (threadId, resolve) => { if (reviewId === null) return; await rpc.call("thread_resolve", { reviewId, threadId, resolve }); refetch(); },
    savePending: async (input) => { if (reviewId === null) return; await rpc.call("pending_add", { reviewId, ...input }); refetch(); },
    savePrivate: async (input) => { if (reviewId === null) return; await rpc.call("note_add", { reviewId, ...input }); refetch(); },
    updatePending: async (id, body) => { await rpc.call("pending_update", { id, body }); refetch(); },
    deletePending: async (id) => { await rpc.call("pending_delete", { id }); refetch(); },
    closeComposer: () => setComposer(null),
    setNoteState: async (id, state) => { await rpc.call("note_update", { id, state }); refetch(); },
    promoteNote: async (id) => { await rpc.call("note_promote", { id }); refetch(); toast.success("Now a pending comment; it posts with your review"); },
    deleteNote: async (id) => { await rpc.call("note_delete", { id }); refetch(); },
    noteToChat: (note) => {
      if (reviewId === null) return;
      attachToChat(pill({ kind: "range", reviewId, path: note.path, startLine: note.startLine ?? note.line, endLine: note.line, side: note.side === "LEFT" ? "old" : "new" }), `Note: ${note.title ? `${note.title}. ` : ""}${note.body.split("\n")[0]} Is this right, and what would you change?`);
    },
    noteToCouncil: (text) => setRoomText(text),
  }), [rpc, reviewId, refetch, prAuthor, attachToChat]);

  useEffect(() => {
    if (selection === null || reviewId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "a" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      e.preventDefault();
      const sel = toSelectionRef(selection);
      attachToChat(commit === null || commitData === null ? selectionPill(reviewId, sel) : pill({ kind: "crange", reviewId, sha: commitData.head, path: sel.path, startLine: sel.startLine, endLine: sel.endLine }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, reviewId, attachToChat, commit, commitData]);

  useEffect(() => {
    if (jump?.path) {
      setPicked(jump.path);
      if (reviewId !== null) writeStorage(fileSelKey(reviewId, scope), jump.path);
    }
  }, [jump?.path, jump?.line, jump?.side, reviewId, scope]);

  const files: FileEntry[] = commit === null ? (detail?.files ?? []) : (commitData?.files ?? []).map(asFileEntry);
  const selectedPath = files.some((f) => f.path === picked) ? picked : (files[0]?.path ?? null);
  const selectedFile = files.find((f) => f.path === selectedPath) ?? null;

  useEffect(() => {
    if (jump?.path === undefined || selectedPath !== jump.path) return;
    const timer = window.setTimeout(() => settleDiffLine(jump.path, jump.line), 250);
    return () => window.clearTimeout(timer);
  }, [jump?.path, jump?.line, selectedPath, selectedFile?.path]);

  const toggleTree = () => {
    setShowTree((value) => {
      const next = !value;
      if (!narrow) writeStorage(TREE_KEY, next);
      return next;
    });
  };

  const selectFile = (path: string) => {
    setPicked(path);
    if (reviewId !== null) writeStorage(fileSelKey(reviewId, scope), path);
    if (narrow) setShowTree(false);
  };

  if (reviewId === null) return <div className="p-4"><EmptyState>Open a review to see its diff here.</EmptyState></div>;
  if (error !== null) return <div className="p-4"><p role="alert" className="text-sm text-destructive">{error}</p></div>;
  if (detail === null) return <div className="p-4"><EmptyState>Loading review…</EmptyState></div>;
  if (commit !== null && commitError !== null) return <div className="p-4"><p role="alert" className="text-sm text-destructive">{commitError}</p></div>;
  if (commit !== null && commitData === null) return <div className="p-4"><EmptyState>Loading commit…</EmptyState></div>;

  const { review, threads, pending, notes, notesRunning, notesError, stack } = detail;
  const inCommit = commit !== null;
  const file = selectedFile;
  const threadsByPath = groupByPath(threads);
  const livePaths = new Set(files.flatMap((entry) => entry.oldPath === null ? [entry.path] : [entry.path, entry.oldPath]));
  const lostPending = inCommit ? [] : pending.filter((p) => !livePaths.has(p.path));
  const pendingOnFile = (path: string) => {
    if (inCommit) return [];
    const entry = files.find((file) => file.path === path);
    return pending.filter((p) => p.path === path || (entry?.oldPath !== undefined && p.path === entry.oldPath));
  };
  const notesForFile = (path: string) => notes.filter((n) => {
    if (n.path !== path) return false;
    if (!noteFilter.kinds.has(n.kind)) return false;
    if (!noteFilter.showDismissed && (n.state === "dismissed" || n.state === "promoted")) return false;
    return true;
  });
  const openNotes = notes.filter((n) => n.state === "open" || n.state === "stale").length;
  const viewedCount = files.filter((f) => f.viewed).length;
  const source: DiffSource | undefined = inCommit && commitData !== null ? { kind: "range", base: commitData.base, head: commitData.head } : undefined;

  const openStackEntry = async (entry: StackView["entries"][number]) => {
    setOpeningSlice(entry.number);
    try {
      await openSlice(rpc, navigate, review.owner, review.repo, entry);
    } catch (cause) {
      toast.error(describeError(cause));
    } finally {
      setOpeningSlice(null);
    }
  };

  const tree = showTree ? (
    <div className={cn(
      "flex flex-col border-r border-border bg-card",
      narrow ? "absolute inset-y-0 left-0 z-30 w-[min(18rem,85vw)] shadow-lg" : "w-60 shrink-0",
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
    </div>
  ) : null;

  return (
    <div className="relative flex h-full min-h-0 text-xs">
      {narrow && showTree ? <button type="button" className="absolute inset-0 z-20 bg-background/60" aria-label="Close file list" onClick={() => setShowTree(false)} /> : null}
      {tree}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
          <Button
            variant={showTree ? "outline" : "ghost"}
            size="sm"
            className="h-7 w-7 shrink-0 px-0"
            onClick={toggleTree}
            aria-pressed={showTree}
            aria-label={showTree ? "Hide file list" : "Show file list"}
            title={showTree ? "Hide file list" : "Show file list"}
          >
            <Icon name={showTree ? "FolderOpen" : "Folder"} className="size-3.5" />
          </Button>
          <select
            value={selectedPath ?? ""}
            onChange={(e) => { if (e.target.value !== "") selectFile(e.target.value); }}
            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 font-mono text-xs"
            aria-label="Changed file"
            disabled={files.length === 0}
          >
            {files.length === 0 ? <option value="">No files</option> : null}
            {files.map((entry) => (
              <option key={entry.path} value={entry.path}>{entry.path}</option>
            ))}
          </select>
          {inCommit ? null : (
            <>
              {narrow ? null : <Progress value={viewedCount} total={files.length} className="w-16" />}
              <span className="relative shrink-0">
                <Button variant="outline" size="sm" className={cn("h-7 w-7 px-0", openNotes > 0 && "border-amber-500/60 text-amber-800 dark:text-amber-200")} onClick={() => setNotesMenu((m) => !m)} aria-expanded={notesMenu} title="Private notes" aria-label="Private notes">
                  <Icon name={notesRunning ? "Loading" : "MessageSquarePlus"} className={cn("size-3.5", notesRunning && "animate-spin")} />
                </Button>
                {notesMenu ? (
                  <div className="absolute right-0 top-full z-20 mt-1 w-80 space-y-1 rounded-md border border-border bg-card p-2 text-xs shadow-md">
                    <div className="px-1 text-[11px] text-muted-foreground">Private notes live only here. Promote one to make it a pending GitHub comment.</div>
                    <button type="button" disabled={notesRunning} className="flex w-full flex-col rounded px-2 py-1.5 text-left hover:bg-state-hover disabled:opacity-60" onClick={() => { setNotesMenu(false); void rpc.call("notes_find", { reviewId }).then(() => { refetch(); toast.success("The helper is reading the diff for slop and cleanups."); }, (cause: unknown) => toast.error(describeError(cause))); }}>
                      <span className="font-medium">{notesRunning ? "The helper is reading the diff…" : "Find slop and cleanups"}</span>
                      <span className="text-muted-foreground">The helper reads the diff and leaves up to 25 notes on the lines.</span>
                    </button>
                    {notesError ? <div className="px-2 text-destructive">{notesError}</div> : null}
                    <div className="border-t border-border/60 px-2 pt-1.5">
                      <div className="mb-1 text-[11px] text-muted-foreground">Show</div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {(["slop", "cleanup", "risk", "question"] as const).map((k) => (
                          <label key={k} className="inline-flex items-center gap-1"><input type="checkbox" checked={noteFilter.kinds.has(k)} onChange={(e) => setNoteFilter((f) => { const kinds = new Set(f.kinds); if (e.target.checked) kinds.add(k); else kinds.delete(k); return { ...f, kinds }; })} />{k}<span className="text-muted-foreground">{notes.filter((n) => n.kind === k && (n.state === "open" || n.state === "stale")).length}</span></label>
                        ))}
                      </div>
                      <label className="mt-1 inline-flex items-center gap-1 text-muted-foreground"><input type="checkbox" checked={noteFilter.showDismissed} onChange={(e) => setNoteFilter((f) => ({ ...f, showDismissed: e.target.checked }))} />dismissed and promoted too</label>
                    </div>
                    <div className="flex flex-wrap gap-1 border-t border-border/60 px-1 pt-1.5">
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => { setNotesMenu(false); void rpc.call("notes_clear", { reviewId, source: "helper" }).then(() => refetch()); }}>Clear helper notes</Button>
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => { setNotesMenu(false); void rpc.call("notes_clear", { reviewId, source: "signal" }).then(() => refetch()); }}>Clear signal notes</Button>
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => { setNotesMenu(false); void rpc.call("notes_clear", { reviewId, dismissedOnly: true }).then(() => refetch()); }}>Clear dismissed</Button>
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => { setNotesMenu(false); void rpc.call("notes_clear", { reviewId, staleOnly: true }).then(() => refetch()); }}>Clear stale</Button>
                    </div>
                  </div>
                ) : null}
              </span>
            </>
          )}
          <select value={diffStyle} onChange={(e) => setDiffStyle(e.target.value as "unified" | "split")} className="h-7 shrink-0 rounded-md border border-input bg-background px-1.5 text-xs" aria-label="Diff style">
            <option value="unified">Unified</option>
            <option value="split">Split</option>
          </select>
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
                    onJump={() => openDiff(panel, reviewId, { path: p.path, line: p.line, side: p.side === "LEFT" ? "old" : "new" })}
                    onDelete={() => void rpc.call("pending_delete", { id: p.id }).then(() => refetch(), (cause: unknown) => toast.error(describeError(cause)))}
                  />
                ))}
              </ul>
            </div>
          ) : null}
          {file === null ? <EmptyState>No files in this diff.</EmptyState> : (
            <FileCard
              key={file.path}
              review={review}
              file={file}
              source={source}
              threads={inCommit ? [] : (threadsByPath.get(file.path) ?? [])}
              pending={pendingOnFile(file.path)}
              notes={inCommit ? [] : notesForFile(file.path)}
              composer={inCommit || composer?.path !== file.path ? null : composer}
              selection={selection}
              onSelect={setSelection}
              onOpenComposer={(path, range) => {
                const start = Math.min(range.start, range.end);
                const end = Math.max(range.start, range.end);
                const side: "old" | "new" = (range.side ?? "additions") === "deletions" ? "old" : "new";
                if (inCommit) {
                  pendingJump = { reviewId, path, line: end, side };
                  navigate.toPluginPanel(PANEL_PATH, { subPath: reviewId });
                  return;
                }
                setComposer({ kind: "composer", path, line: end, startLine: start !== end ? start : null, side: side === "old" ? "LEFT" : "RIGHT", initial: "" });
              }}
              expanded
              onToggle={() => undefined}
              showToggle={false}
              onViewed={(viewed) => void rpc.call("viewed_set", { reviewId, path: file.path, viewed }).then(() => refetch(), (cause: unknown) => toast.error(describeError(cause)))}
              diffStyle={diffStyle}
              theme={theme}
              actions={actions}
              rpc={rpc}
              onAttach={(sel) => attachToChat(inCommit && commitData !== null ? pill({ kind: "crange", reviewId, sha: commitData.head, path: sel.path, startLine: sel.startLine, endLine: sel.endLine }) : selectionPill(reviewId, sel))}
              onSummarize={() => attachToChat(inCommit && commitData !== null ? pill({ kind: "commit", reviewId, sha: commitData.head }) : pill({ kind: "file", reviewId, path: file.path }), inCommit ? `Summarize what ${file.path} changes in this commit and why.` : "Summarize these changes and why they matter for this PR.")}
              onCouncil={(text) => setRoomText(text)}
              alsoIn={inCommit ? [] : alsoInSlices(file.path, stack, review.number)}
              onOpenSlice={(entry) => void openStackEntry(entry)}
              eager
            />
          )}
        </div>
      </div>
      {roomText !== null ? <RoomSender text={roomText} onClose={() => setRoomText(null)} /> : null}
      <span className="sr-only">{openingSlice === null ? "" : `Opening #${openingSlice}`}</span>
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

function InfoTab({ subPath }: { subPath: string }) {
  const target = useFixedTabTarget(INFO_TAB);
  const reviewId = parseReviewSubPath(subPath).reviewId ?? target?.target.reviewId ?? null;
  const { rpc, detail, refetch } = useReview(reviewId);
  const panel = useAppPanel();
  const navigate = useBbNavigate();
  const [event, setEvent] = useState<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAllChecks, setShowAllChecks] = useState(false);
  const [openingSlice, setOpeningSlice] = useState<number | null>(null);
  if (reviewId === null) return <div className="p-4"><EmptyState>Open a review to see its checks, reviewers, and your pending comments here.</EmptyState></div>;
  if (detail === null) return <div className="p-4"><EmptyState>Loading…</EmptyState></div>;
  const { review, pending, stack } = detail;
  const nextUp = stack?.entries.find((e) => e.position === stack.currentPosition + 1) ?? null;
  const prevDown = stack?.entries.find((e) => e.position === stack.currentPosition - 1) ?? null;
  const goSlice = async (entry: StackView["entries"][number]) => {
    setOpeningSlice(entry.number);
    try {
      await openSlice(rpc, navigate, review.owner, review.repo, entry);
    } catch (cause) {
      toast.error(describeError(cause));
    } finally {
      setOpeningSlice(null);
    }
  };
  const ok = (c: Review["checks"][number]) => (c.conclusion ?? "").toLowerCase() === "success" || (c.conclusion ?? "").toLowerCase() === "skipped" || (c.conclusion ?? "").toLowerCase() === "neutral";
  const failing = (c: Review["checks"][number]) => ["failure", "error", "timed_out", "cancelled", "action_required", "startup_failure"].includes((c.conclusion ?? "").toLowerCase());
  const passed = review.checks.filter(ok).length;
  const sortedChecks = [...review.checks].sort((a, b) => Number(failing(b)) - Number(failing(a)) || Number(ok(a)) - Number(ok(b)));
  const visibleChecks = showAllChecks ? sortedChecks : sortedChecks.slice(0, 6);
  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2">
              <span className="text-sm font-semibold">Review</span>
              <DraftToggle
                review={review}
                busy={busy}
                onToggle={(draft) => {
                  setBusy(true);
                  void rpc.call("review_set_draft", { reviewId, draft }).then(
                    () => {
                      refetch();
                      toast.success(draft ? "Converted to draft on GitHub" : "Marked ready for review on GitHub");
                    },
                    (cause: unknown) => toast.error(describeError(cause)),
                  ).finally(() => setBusy(false));
                }}
              />
            </span>
            <span className="flex items-center gap-2 text-muted-foreground">
              {pending.length} pending comment{pending.length === 1 ? "" : "s"}
              {pending.some((p) => p.stale) ? (
                <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs text-destructive" onClick={() => void rpc.call("pending_clear", { reviewId, staleOnly: true }).then((r) => { refetch(); toast.success(`Removed ${r.removed} stale comment${r.removed === 1 ? "" : "s"}`); }, (cause: unknown) => toast.error(describeError(cause)))}>Remove stale</Button>
              ) : null}
            </span>
          </div>
          {pending.length > 0 ? (
            <ul className="space-y-1">
              {pending.map((p) => (
                <PendingListItem
                  key={p.id}
                  pending={p}
                  onJump={() => openDiff(panel, reviewId, { path: p.path, line: p.line, side: p.side === "LEFT" ? "old" : "new" })}
                  onDelete={() => void rpc.call("pending_delete", { id: p.id }).then(() => refetch(), (cause: unknown) => toast.error(describeError(cause)))}
                />
              ))}
            </ul>
          ) : <p className="text-muted-foreground">Select lines in the diff and press Comment to add one.</p>}
          <form className="space-y-2" onSubmit={async (e: FormEvent) => { e.preventDefault(); setBusy(true); try { const r = await rpc.call("review_submit", { reviewId, event, body }); toast.success(`Submitted ${r.posted} comment${r.posted === 1 ? "" : "s"} to GitHub${r.dropped > 0 ? ` (${r.dropped} no longer sat on the diff)` : ""}${nextUp ? `. Next: #${nextUp.number} ${nextUp.title}` : ""}`); setBody(""); refetch(); } catch (cause) { toast.error(describeError(cause)); } finally { setBusy(false); } }}>
            <div className="flex flex-wrap gap-3">
              {(["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const).map((ev) => (
                <label key={ev} className="inline-flex items-center gap-1.5"><input type="radio" name="event" checked={event === ev} onChange={() => setEvent(ev)} />{ev === "COMMENT" ? "Comment" : ev === "APPROVE" ? "Approve" : "Request changes"}</label>
              ))}
            </div>
            <TextArea value={body} onChange={setBody} rows={3} placeholder="Review summary (optional for comment reviews)" />
            <Button type="submit" size="sm" disabled={busy || (pending.every((p) => p.stale) && body.trim() === "")}><Icon name="Github" className="size-3.5" />Submit review to GitHub</Button>
            {stack !== null ? (
              <div className="flex flex-wrap gap-1.5">
                {prevDown ? (
                  <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={openingSlice !== null} onClick={() => void goSlice(prevDown)} title={`#${prevDown.number} ${prevDown.title}`} aria-label={`Open pull request #${prevDown.number}`}>
                    {openingSlice === prevDown.number ? <Icon name="Loading" className="size-3.5 animate-spin" /> : <Icon name="ChevronsDown" className="size-3.5" />}
                    #{prevDown.number}
                  </Button>
                ) : null}
                {nextUp ? (
                  <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={openingSlice !== null} onClick={() => void goSlice(nextUp)} title={`#${nextUp.number} ${nextUp.title}`} aria-label={`Open pull request #${nextUp.number}`}>
                    {openingSlice === nextUp.number ? <Icon name="Loading" className="size-3.5 animate-spin" /> : <Icon name="ChevronsUp" className="size-3.5" />}
                    #{nextUp.number}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </form>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Checks</span>
            <span className="text-muted-foreground">{passed}/{review.checks.length}</span>
          </div>
          <Progress value={passed} total={review.checks.length} />
          <ul className="space-y-0.5">
            {visibleChecks.map((c, i) => (
              <li key={`${c.name}-${i}`} className="flex items-center gap-2">
                <span className={cn("size-2 shrink-0 rounded-full", ok(c) ? "bg-primary" : failing(c) ? "bg-destructive" : "bg-muted-foreground/40")} />
                {c.url ? <UrlLink href={c.url} className="min-w-0 truncate hover:underline">{c.name}</UrlLink> : <span className="min-w-0 truncate">{c.name}</span>}
                <span className="ml-auto shrink-0 text-muted-foreground">{(c.conclusion ?? c.status).toLowerCase().replace(/_/g, " ")}</span>
              </li>
            ))}
          </ul>
          {review.checks.length > 6 ? <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => setShowAllChecks((v) => !v)}>{showAllChecks ? "Show fewer" : `Show all ${review.checks.length}`}</Button> : null}
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between"><span className="text-sm font-semibold">Reviewers</span><span className="text-muted-foreground">{review.reviewers.length}</span></div>
          {review.reviewers.length === 0 ? <p className="text-muted-foreground">None yet.</p> : (
            <ul className="space-y-1">
              {review.reviewers.map((r) => (
                <li key={r.login} className="flex items-center gap-2">
                  <span className="inline-flex size-5 items-center justify-center rounded-full bg-foreground/10 text-[10px] font-medium uppercase">{r.login[0]}</span>
                  <span className="min-w-0 truncate">{r.login}</span>
                  <Icon name={reviewStateIcon(r.state)} className={cn("ml-auto size-3.5", reviewStateTone(r.state))} aria-label={r.state} />
                </li>
              ))}
            </ul>
          )}
          {review.reviewDecision ? <p className="text-muted-foreground">Decision: {review.reviewDecision.replace(/_/g, " ").toLowerCase()}</p> : null}
        </section>

        <section className="space-y-2">
          <span className="text-sm font-semibold">Assignees</span>
          <p className="text-muted-foreground">{review.assignees.length === 0 ? "No assignees" : review.assignees.join(", ")}</p>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between"><span className="text-sm font-semibold">Labels</span><span className="text-muted-foreground">{review.labels.length}</span></div>
          <div className="flex flex-wrap gap-1">{review.labels.map((l) => <span key={l} className="rounded-full border border-border px-2 py-0.5">{l}</span>)}</div>
        </section>
      </div>
    </div>
  );
}

function ChatTab({ subPath }: { subPath: string }) {
  const target = useFixedTabTarget(CHAT_TAB);
  const reviewId = parseReviewSubPath(subPath).reviewId ?? target?.target.reviewId ?? null;
  const { rpc, detail, refetch } = useReview(reviewId);
  const { providers, defaultProvider } = useProviders();
  const [providerId, setProviderId] = useChatProvider(providers, defaultProvider);
  const [composing, setComposing] = useState(false);
  const [roomText, setRoomText] = useState<string | null>(null);
  const seats = detail?.seats ?? [];
  const seat = composing ? null : seats.find((s) => s.providerId === providerId) ?? seats[0] ?? null;

  // The "new chat" composer has no thread yet; tell the composer banner which
  // review it belongs to so queued pills land in it.
  useEffect(() => {
    if (reviewId === null || detail === null || seat !== null) return;
    setComposingReview(reviewId);
    return () => setComposingReview(null);
  }, [reviewId, detail, seat]);

  if (reviewId === null) return <div className="p-4"><EmptyState>Open a review and press Chat to talk with its analyst here.</EmptyState></div>;
  if (detail === null) return <div className="p-4"><EmptyState>Loading…</EmptyState></div>;
  const { review, stack } = detail;
  const displayName = (id: string) => providers.find((p) => p.id === id)?.displayName ?? id;

  const start = async (request: NewThreadRequest) => {
    await rpc.call("chat_start", {
      reviewId,
      providerId: request.providerId,
      model: request.model,
      reasoningLevel: request.reasoningLevel,
      permissionMode: request.permissionMode,
      ...(request.serviceTier === undefined ? {} : { serviceTier: request.serviceTier }),
      executionInputSources: request.executionInputSources as Record<string, "client-preference" | "explicit">,
      input: request.input as unknown as Record<string, unknown>[],
    });
    setProviderId(request.providerId);
    setComposing(false);
    refetch();
  };
  const addAsComment = async (text: string) => {
    const sel = readStorage<SelectionRef>(selectionKey(reviewId));
    if (sel === null) {
      toast.error("Select lines in the diff first, then use this action to attach the answer there.");
      return;
    }
    try {
      await rpc.call("pending_add", { reviewId, path: sel.path, line: sel.endLine, startLine: sel.startLine !== sel.endLine ? sel.startLine : null, side: sel.side === "old" ? "LEFT" : "RIGHT", body: text.trim() });
      toast.success(`Pending comment added at ${splitPath(sel.path).name}:${sel.endLine}`);
      refetch();
    } catch (cause) {
      toast.error(describeError(cause));
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5 text-xs">
        {seats.map((s) => (
          <button key={s.providerId} type="button" onClick={() => { setProviderId(s.providerId); setComposing(false); }} className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-1", seat?.providerId === s.providerId ? "bg-state-active font-medium" : "text-muted-foreground hover:bg-state-hover")}>
            {displayName(s.providerId)}
          </button>
        ))}
        <button type="button" onClick={() => setComposing(true)} className={cn("inline-flex items-center gap-1 rounded-md px-2 py-1", seat === null ? "bg-state-active font-medium" : "text-muted-foreground hover:bg-state-hover")} title="Start a chat with another provider">
          <Icon name="Plus" className="size-3.5" />{seats.length === 0 ? "New chat" : null}
        </button>
        {seat ? (
          <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5 text-xs" onClick={() => { if (window.confirm("Reset this chat? The analyst starts over with a fresh thread.")) void rpc.call("chat_reset", { reviewId, providerId: seat.providerId }).then(() => refetch()); }} title="Start a fresh analyst thread">
            <Icon name="RotateCcw" className="size-3.5" />Reset
          </Button>
        ) : null}
      </div>
      {stack !== null ? (
        <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-[11px] text-muted-foreground" title={`This chat is for #${review.number} only`}>
          <PrMark state={review.state} isDraft={review.isDraft} />
          <span className="font-mono">#{review.number}</span>
          {stack.number !== null ? (
            <span className="inline-flex items-center gap-1" title={`GitHub stack #${stack.number}`}>
              <Icon name="GitPullRequestArrow" className="size-3.5" />#{stack.number}
            </span>
          ) : null}
          <LayerMark position={stack.currentPosition} size={stack.entries.length} />
        </div>
      ) : null}
      {seat ? (
        <ThreadChat
          key={seat.threadId}
          threadId={seat.threadId}
          variant="compact"
          layout="contained"
          className="min-h-0 flex-1"
          messageActions={[
            { id: "add-comment", title: "Add as PR comment on the selected lines", icon: "Edit", roles: ["assistant"], run: (message) => { void addAsComment(message.text); } },
            { id: "council", title: "Send to the council", icon: "MessageSquare", roles: ["assistant", "user"], run: (message) => setRoomText(message.text) },
          ]}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto p-4 text-sm">
            <p className="font-medium">Chat with this PR</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The analyst runs in a worktree at the PR head with the full diff, description, and repository at hand. It reads, it never edits.
            </p>
            <ul className="mt-3 space-y-1.5 text-xs text-muted-foreground">
              <li><kbd className="rounded border border-border px-1 font-mono">@</kbd> attaches a changed file, symbol, review thread, or <span className="font-mono">path:10-20</span> as a pill.</li>
              <li>Select lines in the diff and press <kbd className="rounded border border-border px-1 font-mono">a</kbd> or <span className="text-foreground">Add to chat</span>.</li>
              <li>Pills turn into code when you send. You keep a short transcript; the analyst gets the excerpt.</li>
            </ul>
          </div>
          <div className="border-t border-border p-2">
            <NewThreadComposer
              defaultProjectId={detail.chatProjectId}
              defaultProviderId={providerId || defaultProvider || undefined}
              defaultEnvironment={review.environmentId ? { type: "reuse", environmentId: review.environmentId } : { type: "host", hostId: review.hostId, workspace: { type: "unmanaged", path: review.worktree } }}
              placeholder="Ask about the PR. @ attaches code, a adds the selected lines."
              layout="contained"
              draftKey={`review-desk:${reviewId}`}
              onSubmit={start}
            />
          </div>
        </div>
      )}
      {roomText !== null ? <RoomSender text={roomText} onClose={() => setRoomText(null)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer banner: lives inside every thread and new-thread composer, shows
// only for our analyst composers. Drains queued pills and offers the current
// diff selection.
// ---------------------------------------------------------------------------

function PillBanner() {
  const view = useComposerView();
  const composer = useComposer();
  const rpc = useRpc<Contract>();
  const scope = view.scope;
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const composing = useComposingReview();
  const [seatReview, setSeatReview] = useState<string | null>(null);
  useEffect(() => {
    if (threadId === null) {
      setSeatReview(null);
      return;
    }
    let cancelled = false;
    void lookupSeatReview(rpc, threadId).then((id) => { if (!cancelled) setSeatReview(id); });
    return () => { cancelled = true; };
  }, [threadId, rpc]);
  const reviewId = scope.kind === "thread" ? seatReview : scope.kind === "new-thread" ? composing : null;
  const selection = useSelectionRef(reviewId);

  const composerRef = useRef(composer);
  composerRef.current = composer;
  useEffect(() => {
    if (reviewId === null) return;
    const drain = () => {
      const list = drainAttaches(reviewId);
      if (list.length === 0) return;
      for (const attach of list) {
        composerRef.current.insertMention(attach.mention);
        if (attach.text) composerRef.current.updateText((t) => `${t.trim() === "" ? "" : `${t.trimEnd()} `}${attach.text}`);
      }
      composerRef.current.focus();
    };
    drain();
    const onAttach = (e: Event) => { if ((e as CustomEvent<{ reviewId: string }>).detail.reviewId === reviewId) drain(); };
    window.addEventListener(ATTACH_EVENT, onAttach);
    return () => window.removeEventListener(ATTACH_EVENT, onAttach);
  }, [reviewId]);

  if (reviewId === null || selection === null) return null;
  const label = mentionLabel({ kind: "range", reviewId, path: selection.path, startLine: selection.startLine, endLine: selection.endLine, side: selection.side });
  return (
    <div className="flex items-center gap-2 px-1 pb-1 text-xs text-muted-foreground">
      <Icon name="Code" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">Selected <span className="font-mono text-foreground">{label}</span>{splitPath(selection.path).dir ? <span> in {splitPath(selection.path).dir}</span> : null}</span>
      <button type="button" className="ml-auto shrink-0 rounded-md border border-border px-2 py-0.5 hover:bg-state-hover" onClick={() => { composer.insertMention(selectionPill(reviewId, selection)); composer.focus(); }}>
        Add to chat
      </button>
    </div>
  );
}

function CodemapTab({ subPath }: { subPath: string }) {
  const target = useFixedTabTarget(CODEMAP_TAB);
  const reviewId = parseReviewSubPath(subPath).reviewId ?? target?.target.reviewId ?? null;
  const panel = useAppPanel();
  const { state, error, refresh } = useCodemap(reviewId, reviewId !== null);
  const [filter, setFilter] = useState("");
  const jumpFile = (path: string) => {
    if (reviewId === null) return;
    openDiff(panel, reviewId, { path, line: null, side: "new" });
  };
  if (reviewId === null) return <div className="p-4"><EmptyState>Open a review and press Codemap to see its structure here.</EmptyState></div>;
  if (error) return <p className="p-3 text-xs text-destructive">{error}</p>;
  if (state === null || state.status === "building" || state.status === "missing") return <p className="inline-flex items-center gap-1.5 p-3 text-xs text-muted-foreground"><Icon name="Loading" className="size-3.5 animate-spin" />Building the codemap: parsing changed files and counting references…</p>;
  if (state.status === "failed" || state.codemap === null) return <div className="space-y-2 p-3 text-xs"><p className="text-destructive">{state.error ?? "Codemap failed."}</p><Button size="sm" variant="outline" onClick={refresh}>Retry</Button></div>;
  const c: Codemap = state.codemap;
  const files = c.files.filter((f) => f.symbols.some((s) => s.status !== "unchanged")).filter((f) => filter === "" || f.path.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <span className="text-sm font-semibold">Codemap</span>
        <span className="text-muted-foreground">{c.stats.symbols} symbols · +{c.stats.added} ~{c.stats.modified} -{c.stats.removed} · {c.edges.length} references</span>
        <Button variant="ghost" size="sm" className="ml-auto h-7 px-1.5" onClick={refresh} aria-label="Rebuild codemap"><Icon name="ArrowReloadHorizontal" className="size-3.5" /></Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <section className="space-y-1.5">
          <div className="font-medium">Reading order</div>
          <ol className="space-y-1.5">
            {c.readingOrder.map((m, i) => (
              <li key={m.module} className="rounded-md border border-border p-2">
                <div className="flex items-center gap-1.5"><span className="text-muted-foreground">{i + 1}.</span><span className="font-mono font-medium">{m.module}</span><span className="ml-auto text-muted-foreground">{m.paths.length} files</span></div>
                <div className="text-[11px] text-muted-foreground">{m.reason}</div>
                <ul className="mt-1 space-y-0.5">
                  {m.paths.map((p) => <li key={p}><button type="button" onClick={() => jumpFile(p)} className="w-full truncate text-left font-mono text-[11px] hover:underline" title={p}>{p.split("/").slice(2).join("/") || p}</button></li>)}
                </ul>
              </li>
            ))}
          </ol>
        </section>
        <section className="space-y-1.5">
          <div className="font-medium">Hotspots</div>
          <ul className="space-y-0.5">
            {c.hotspots.slice(0, 12).map((h) => (
              <li key={`${h.path}#${h.qualified}`}>
                <button type="button" onClick={() => jumpFile(h.path)} className="flex w-full items-center gap-2 text-left hover:underline" title={`${h.path} ${h.changedLines} changed lines, fan-in ${h.fanIn}`}>
                  <span className="w-10 shrink-0 text-right font-mono text-muted-foreground">{Math.round(h.score)}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">{h.qualified}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="space-y-1.5">
          <div className="flex items-center gap-2"><span className="font-medium">Changed symbols</span><Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files…" className="ml-auto h-7 w-40 text-xs" /></div>
          {files.map((f) => (
            <div key={f.path} className="rounded-md border border-border bg-card">
              <button type="button" onClick={() => jumpFile(f.path)} className="flex w-full items-center gap-2 border-b border-border/60 px-2 py-1.5 text-left font-mono hover:underline">
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
                <span className="text-muted-foreground">{f.changedLines} lines</span>
              </button>
              <ul className="divide-y divide-border/60">
                {f.symbols.filter((s) => s.status !== "unchanged").map((s) => (
                  <li key={`${s.kind}:${s.qualified}`} className="flex items-center gap-2 px-2 py-1">
                    <span className={cn("w-14 shrink-0 rounded-full border px-1.5 text-center text-[10px] uppercase", s.status === "added" ? "border-primary/50 text-primary" : s.status === "removed" ? "border-destructive/50 text-destructive" : "border-border text-muted-foreground")}>{s.status}</span>
                    <span className="text-muted-foreground">{s.kind}</span>
                    <span className="min-w-0 flex-1 truncate font-mono" title={s.qualified}>{s.qualified}</span>
                    <span className="shrink-0 text-muted-foreground">{s.status === "removed" ? `old ${s.oldStart}-${s.oldEnd}` : `${s.start}-${s.end}`}{s.fanIn > 0 ? ` · ${s.fanIn} refs` : ""}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function groupReviews(reviews: ReviewSummary[]): { key: string; stack: ReviewSummary["stack"]; items: ReviewSummary[] }[] {
  const groups: { key: string; stack: ReviewSummary["stack"]; items: ReviewSummary[] }[] = [];
  const seen = new Set<string>();
  for (const review of reviews) {
    if (seen.has(review.id)) continue;
    if (review.stack === null) {
      seen.add(review.id);
      groups.push({ key: review.id, stack: null, items: [review] });
      continue;
    }
    const items = reviews.filter((other) => other.stack?.key === review.stack?.key).sort((a, b) => (a.stack?.position ?? 0) - (b.stack?.position ?? 0));
    for (const item of items) seen.add(item.id);
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
  const drop = async (ids: string[], multiple = false) => {
    if (!confirmRemoveReview(multiple)) return;
    try {
      for (const id of ids) await rpc.call("reviews_remove", { reviewId: id });
      refetch();
      toast.success(ids.length === 1 ? "Removed from Review Desk" : `Removed ${ids.length} reviews`);
    } catch (cause) {
      toast.error(describeError(cause));
    }
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
        <p className="mt-1 text-sm text-muted-foreground">Open a pull request or a GitHub stack to read it with the diff, the conversation, and an analyst that has the code in front of it.</p>
        <form onSubmit={open} className="mt-6 flex items-center gap-2">
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="owner/repo#123 or owner/repo/stack/7" className="h-10" aria-label="Pull request" />
          <Button type="submit" className="h-10" disabled={opening || ref.trim() === ""}>
            {opening ? <Icon name="Loading" className="size-4 animate-spin" /> : <Icon name="GitPullRequest" className="size-4" />}
            {opening ? "Fetching…" : "Open"}
          </Button>
        </form>
        {openError ? <p className="mt-2 text-sm text-destructive">{openError}</p> : null}
        <div className="mt-10">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent</div>
          {error ? <p className="text-sm text-destructive">{error}</p> : reviews === null ? <p className="text-sm text-muted-foreground">Loading…</p> : reviews.length === 0 ? <EmptyState>No reviews yet.</EmptyState> : (
            <ul className="space-y-3">
              {groupReviews(reviews).map((group) => {
                if (group.stack === null) {
                  const r = group.items[0];
                  if (r === undefined) return null;
                  return (
                    <li key={group.key} className="overflow-hidden rounded-lg border border-border">
                      <div className="flex items-center">
                        <button type="button" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: r.id })} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left hover:bg-state-hover">
                          <PrMark state={r.state} isDraft={r.isDraft} className="size-4" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{r.title}</span>
                            <span className="flex items-center gap-2 truncate text-xs text-muted-foreground">
                              <span className="truncate">{r.owner}/{r.repo} #{r.number}</span>
                              <CountBadge count={r.pendingCount} title={`${r.pendingCount} pending`} />
                            </span>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(r.updatedAt)}</span>
                        </button>
                        <RemoveReviewButton label="Remove review" onClick={() => void drop([r.id])} />
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
                      <button type="button" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: latest.id })} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left hover:bg-state-hover">
                        <Icon name="GitPullRequestArrow" className={cn("size-4 shrink-0", latest.state === "OPEN" ? "text-primary" : "text-muted-foreground")} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{latest.title}</span>
                          <span className="flex items-center gap-2 truncate text-xs text-muted-foreground">
                            <span className="truncate">{latest.owner}/{latest.repo}</span>
                            {stackInfo.number !== null ? <span className="font-mono" title={`GitHub stack #${stackInfo.number}`}>#{stackInfo.number}</span> : null}
                            <LayerMark position={group.items.length} size={stackInfo.size} title={`${group.items.length} of ${stackInfo.size} layers opened`} />
                            <CountBadge count={group.items.reduce((n, r) => n + r.pendingCount, 0)} title="Pending comments" />
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(latest.updatedAt)}</span>
                      </button>
                      <RemoveReviewButton label="Remove stack reviews" onClick={() => void drop(group.items.map((item) => item.id), true)} />
                    </div>
                    <ul className="divide-y divide-border/60 border-t border-border/60">
                      {layers.map((r) => (
                        <li key={r.id}>
                          <div className="flex items-center">
                            <button type="button" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: r.id })} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-1.5 pl-11 text-left hover:bg-state-hover">
                              <span className="w-8 shrink-0 font-mono text-[11px] text-muted-foreground">{r.stack?.position}/{stackInfo.size}</span>
                              <span className="w-12 shrink-0 font-mono text-xs">#{r.number}</span>
                              <span className="min-w-0 flex-1 truncate text-xs">{r.title}</span>
                              <PrMark state={r.state} isDraft={r.isDraft} />
                              <CountBadge count={r.pendingCount} title={`${r.pendingCount} pending`} />
                            </button>
                            <RemoveReviewButton label={`Remove #${r.number}`} onClick={() => void drop([r.id])} />
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
    fixedTabs: [
      { ...DIFF_TAB, title: "Diff", icon: "FileDiff", layout: "flush", component: DiffTab },
      { ...INFO_TAB, title: "Info", icon: "Info", layout: "flush", component: InfoTab },
      { ...CHAT_TAB, title: "Chat", icon: "Brain", layout: "flush", component: ChatTab },
      { ...CODEMAP_TAB, title: "Codemap", icon: "Layers", layout: "flush", component: CodemapTab },
    ],
  });
  app.composer.customize({
    id: "code-pills",
    scopes: ["thread", "new-thread"],
    banners: [{ id: "selection", chrome: "bare", component: PillBanner }],
  });
});
