import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_useAppPanel,
  experimental_useFixedTabTarget,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type ExperimentalThreadTabProps,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";
import {
  explainerRefSchema,
  explainerTitleSchema,
  type ExplainerRef,
  type ThreadExplainer,
} from "./schema";
import { Button } from "./components/ui/button";

export const explainersTab = {
  id: "explainers",
  context: { kind: "thread" },
  availability: "fixed",
  experimental_target: {
    validate: (value: unknown): value is ExplainerRef =>
      explainerRefSchema.safeParse(value).success,
  },
} as const;

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

function LoadError({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="space-y-2 p-4 text-sm">
      <p role="alert" className="text-destructive">
        {error}
      </p>
      <Button variant="outline" size="sm" onClick={retry}>
        Retry
      </Button>
    </div>
  );
}

function useThemeCss() {
  const [theme, setTheme] = useState<{
    css: string;
    colorScheme: string;
  } | null>(null);
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      const style = getComputedStyle(root);
      const variables = Array.from(style)
        .filter((name) => name.startsWith("--"))
        .map((name) => `${name}:${style.getPropertyValue(name)};`)
        .join("");
      const scheme =
        style.colorScheme && style.colorScheme !== "normal"
          ? style.colorScheme
          : root.classList.contains("dark") || media.matches
            ? "dark"
            : "light";
      setTheme({
        css: `:root{${variables}color-scheme:${scheme};}`,
        colorScheme: scheme,
      });
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true });
    media.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);
  return theme;
}

function themedHtml(html: string, css: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const style = doc.createElement("style");
  style.textContent = css;
  doc.head.prepend(style);
  return "<!doctype html>" + doc.documentElement.outerHTML;
}

function ExplainerReader({
  selected,
}: {
  selected: ExplainerRef & { title: string };
}) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const theme = useThemeCss();
  const [document, setDocument] = useState<{
    html: string;
    sha256: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    try {
      const value = await rpc.call("readExplainer", {
        recordId: selected.recordId,
        name: selected.name,
      });
      if (current !== request.current) return;
      setDocument((previous) =>
        previous?.sha256 === value.sha256 ? previous : value,
      );
      setError(null);
    } catch (cause) {
      if (current === request.current) setError(message(cause));
    }
  }, [rpc, selected.recordId, selected.name]);
  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
    };
  }, [refresh, connection]);
  useRealtime("changed", refresh);
  if (error) return <LoadError error={error} retry={() => void refresh()} />;
  if (!document || !theme)
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Loading…
      </p>
    );
  return (
    <iframe
      title={selected.title}
      className="min-h-0 w-full flex-1 border-0 bg-background"
      style={{ colorScheme: theme.colorScheme }}
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      srcDoc={themedHtml(document.html, theme.css)}
    />
  );
}

function ThreadExplainers({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const target = experimental_useFixedTabTarget(explainersTab);
  const [selected, setSelected] = useState<
    (ExplainerRef & { title: string }) | null
  >(null);
  const [items, setItems] = useState<ThreadExplainer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    try {
      const entries = await rpc.call("listThreadExplainers", { threadId });
      if (current !== request.current) return;
      setItems(entries);
      setLoaded(true);
      setError(null);
    } catch (cause) {
      if (current === request.current) setError(message(cause));
    }
  }, [rpc, threadId]);
  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
    };
  }, [refresh, connection]);
  useRealtime("changed", refresh);
  useEffect(() => {
    if (target) setSelected({ ...target.target, title: "Explainer" });
  }, [target?.sequence]);
  const current =
    selected &&
    (items.find(
      (item) =>
        item.recordId === selected.recordId && item.name === selected.name,
    ) ??
      selected);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {current ? (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                target?.clear();
                setSelected(null);
              }}
            >
              ← Back
            </Button>
            <span className="truncate text-sm font-medium">
              {current.title}
            </span>
          </div>
          <ExplainerReader
            key={`${current.recordId}/${current.name}`}
            selected={current}
          />
        </>
      ) : error ? (
        <LoadError error={error} retry={() => void refresh()} />
      ) : !loaded ? (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          Loading…
        </p>
      ) : !items.length ? (
        <p className="p-4 text-sm text-muted-foreground">No explainers yet</p>
      ) : (
        <ul className="overflow-y-auto p-2">
          {items.map((item) => (
            <li key={`${item.recordId}/${item.name}`}>
              <button
                className="w-full rounded-md px-3 py-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => setSelected(item)}
              >
                {item.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ExplainersPanel({ threadId }: ExperimentalThreadTabProps) {
  return <ThreadExplainers key={threadId} threadId={threadId} />;
}

export function ExplainerOpener({
  attributes,
  message: sourceMessage,
}: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const panel = experimental_useAppPanel();
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = explainerRefSchema.safeParse({
    recordId: attributes.record,
    name: attributes.artifact,
  });
  const title = explainerTitleSchema.safeParse(attributes.title);
  if (!ref.success || !title.success)
    return (
      <p className="text-sm text-destructive">Invalid explainer reference</p>
    );
  async function open() {
    if (!ref.success || !title.success) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.call("attachThreadExplainer", {
        threadId: sourceMessage.threadId,
        ...ref.data,
        title: title.data,
      });
      if (!panel.openTab({ tab: explainersTab, target: ref.data })) {
        const saved = await rpc.call("readExplainer", ref.data);
        if (
          !saved.hostId ||
          !navigate.experimental_openFilePreview({
            target: { kind: "host", hostId: saved.hostId, path: saved.path },
            location: null,
          })
        )
          throw new Error("Could not open this explainer here");
      }
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void open()}
      >
        {title.data}
      </Button>
      {error && (
        <p role="alert" className="mt-1 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
