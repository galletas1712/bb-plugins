import { useEffect, useRef, useState, type RefObject } from "react";
import {
  experimental_Diff as Diff,
  useRpc,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { ChangesResult, Mode, RepoChanges, rpcContract } from "./contract";

type FileChange = RepoChanges["files"][number];

// Close to live while the tab is in view. A folder of dozens of repos
// takes seconds to scan, so the wait grows with the scan time.
const POLL_MS = 3000;
const POLL_SCAN_MULTIPLE = 4;

const MODES: readonly { mode: Mode; label: string; empty: string }[] = [
  { mode: "working", label: "Uncommitted", empty: "No uncommitted changes" },
  { mode: "branch", label: "Branch", empty: "No new commits" },
];

const STATUS: Record<FileChange["status"], { label: string; className: string }> = {
  M: { label: "Modified", className: "text-muted-foreground" },
  A: { label: "Added", className: "text-[color:var(--diff-added)]" },
  D: { label: "Deleted", className: "text-[color:var(--diff-removed)]" },
  R: { label: "Renamed", className: "text-muted-foreground" },
  U: { label: "Conflict", className: "text-destructive" },
  "?": { label: "Untracked", className: "text-[color:var(--diff-added)]" },
};

/**
 * Each repo's changes in the thread's folder. Repos with changes get a
 * section and clean repos share one line. Clicking a file shows its diff.
 * The list refreshes while the tab is in view.
 */
export function ChangesPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const root = useRef<HTMLDivElement>(null);
  const shown = useShown(root);
  const [mode, setMode] = useState<Mode>("working");
  const [refreshes, setRefreshes] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [loaded, setLoaded] = useState<{
    mode: Mode;
    // Bumped on every load so open diffs refresh with the list.
    tick: number;
    result: ChangesResult;
  } | null>(null);
  const [error, setError] = useState<{ mode: Mode; message: string } | null>(null);

  useEffect(() => {
    if (!shown) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const started = Date.now();
      setScanning(true);
      try {
        const result = await rpc.call("changes", { threadId, mode });
        if (!live) return;
        setLoaded((previous) => ({ mode, tick: (previous?.tick ?? 0) + 1, result }));
        setError(null);
      } catch (failure) {
        if (live) setError({ mode, message: messageOf(failure) });
      } finally {
        if (live) setScanning(false);
      }
      if (live) timer = setTimeout(load, Math.max(POLL_MS, POLL_SCAN_MULTIPLE * (Date.now() - started)));
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [rpc, threadId, mode, refreshes, shown]);

  const current = loaded?.mode === mode ? loaded : null;
  const failure = error?.mode === mode ? error.message : null;
  const empty = MODES.find((entry) => entry.mode === mode)!.empty;

  return (
    <div ref={root} className="flex flex-col gap-3 text-sm">
      <div className="flex items-center gap-2">
        <div role="group" aria-label="Compare" className="inline-flex rounded-md border border-border p-0.5 text-xs">
          {MODES.map((entry) => (
            <button
              key={entry.mode}
              type="button"
              aria-pressed={mode === entry.mode}
              onClick={() => setMode(entry.mode)}
              className={cn(
                "rounded px-2 py-0.5",
                mode === entry.mode ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={scanning}
          onClick={() => setRefreshes((count) => count + 1)}
          className="ml-auto rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {scanning ? "Refreshing" : "Refresh"}
        </button>
      </div>
      {failure !== null && <p className="text-xs text-destructive">{failure}</p>}
      {current === null ? (
        failure === null && <p className="text-muted-foreground">Loading changes</p>
      ) : current.result.status === "unavailable" ? (
        <p className="text-muted-foreground">{current.result.reason}</p>
      ) : current.result.repos.length === 0 ? (
        <p className="text-muted-foreground">No git repos in this thread's folder.</p>
      ) : (
        <Repos repos={current.result.repos} mode={mode} threadId={threadId} tick={current.tick} empty={empty} />
      )}
    </div>
  );
}

/** True while the element is in a visible document and on screen, such as an open, active panel tab. */
function useShown(element: RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(true);
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry?.isIntersecting ?? true));
    if (element.current !== null) observer.observe(element.current);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
    };
  }, [element]);
  return onScreen && visible;
}

function Repos(props: { repos: RepoChanges[]; mode: Mode; threadId: string; tick: number; empty: string }) {
  const changed = props.repos.filter((repo) => repo.files.length > 0 || repo.error !== null);
  const clean = props.repos.filter((repo) => !changed.includes(repo));
  return (
    <>
      {changed.map((repo) => (
        <RepoSection key={repo.name} repo={repo} {...props} />
      ))}
      {clean.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {props.empty} in {clean.map((repo) => repo.name).join(", ")}.
        </p>
      )}
    </>
  );
}

// Longer lists start collapsed so one huge repo does not bury the rest.
const OPEN_FILE_LIMIT = 25;

function RepoSection({ repo, ...rest }: { repo: RepoChanges; mode: Mode; threadId: string; tick: number }) {
  const [open, setOpen] = useState(repo.files.length <= OPEN_FILE_LIMIT);
  return (
    <section className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-baseline gap-2 rounded py-1 text-left hover:bg-accent"
      >
        <span className="font-medium">{repo.name}</span>
        {repo.error === null && (
          <>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {repo.branch ?? "detached HEAD"}
              {repo.base !== null && ` vs ${repo.base}`}
            </span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {repo.files.length}
              {repo.truncated && "+"} {repo.files.length === 1 ? "file" : "files"}
            </span>
          </>
        )}
      </button>
      {repo.error !== null && <p className="text-xs text-destructive">{repo.error}</p>}
      {open && (
        <ul className="flex flex-col">
          {repo.files.map((file) => (
            <FileRow key={`${file.status}:${file.path}`} repo={repo.name} file={file} {...rest} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FileRow(props: { repo: string; file: FileChange; mode: Mode; threadId: string; tick: number }) {
  const { file } = props;
  const [open, setOpen] = useState(false);
  return (
    <li className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-accent"
      >
        <span className={cn("w-3 shrink-0 font-mono text-xs", STATUS[file.status].className)} title={STATUS[file.status].label}>
          {file.status}
        </span>
        <span className="min-w-0 truncate font-mono text-xs">
          {file.oldPath === null ? file.path : `${file.oldPath} → ${file.path}`}
        </span>
      </button>
      {open && <FilePatch {...props} />}
    </li>
  );
}

function FilePatch({ repo, file, mode, threadId, tick }: { repo: string; file: FileChange; mode: Mode; threadId: string; tick: number }) {
  const rpc = useRpc<typeof rpcContract>();
  // undefined while loading, null when the patch is too large to show.
  const [patch, setPatch] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // A diff slower than the list keeps its request instead of restarting on every tick.
  const loading = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);

  useEffect(() => {
    if (loading.current) return;
    loading.current = true;
    rpc
      .call("diff", { threadId, repo, path: file.path, oldPath: file.oldPath, mode, untracked: file.status === "?" })
      .then(
        (result) => {
          if (!mounted.current) return;
          setPatch(result.patch);
          setError(null);
        },
        (failure: unknown) => mounted.current && setError(messageOf(failure)),
      )
      .finally(() => {
        loading.current = false;
      });
  }, [rpc, threadId, repo, file.path, file.oldPath, file.status, mode, tick]);

  const note =
    error ?? (patch === undefined ? "Loading diff" : patch === null ? "Too large to show (over 512 KiB)." : patch === "" ? "No text changes." : null);
  return (
    <div className="my-1 overflow-hidden rounded-md border border-border">
      {note === null ? (
        // A rename or type change can come back as one section per side, and Diff shows one file.
        patch!.split(/^(?=diff --git )/m).map((section, index) => <Diff key={index} patch={section} path={file.path} />)
      ) : (
        <p className="px-2 py-1 text-xs text-muted-foreground">{note}</p>
      )}
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
