import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  explainerTargetSchema,
  type ExplainerRef,
  type ExplainerTarget,
  type ThreadExplainer,
} from "./schema";
import { Button } from "./components/ui/button";

export const explainersTab = {
  id: "explainers",
  context: { kind: "thread" },
  availability: "fixed",
  experimental_target: {
    validate: (value: unknown): value is ExplainerTarget =>
      explainerTargetSchema.safeParse(value).success,
  },
} as const;

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

// Keep common inline-vis color names usable with BB's theme tokens.
const themeAliases: Record<string, string> = {
  "card-foreground": "foreground",
  "surface-raised": "surface-raised-solid",
  "surface-recessed": "surface-recessed-solid",
  brand: "timeline-accent",
  "chart-1": "timeline-accent",
};
const chartColors = {
  light: ["#0d9488", "#d97706", "#9333ea", "#e11d48", "#65a30d"],
  dark: ["#2dd4bf", "#fbbf24", "#c084fc", "#fb7185", "#a3e635"],
};

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
      const variables =
        `background foreground muted muted-foreground subtle-foreground
        card card-foreground popover popover-foreground primary primary-foreground
        secondary secondary-foreground accent accent-foreground border input ring
        surface-raised surface-recessed brand destructive destructive-foreground
        destructive-text warning warning-text success attention diff-added diff-removed
        shadow-xs shadow-sm shadow-md shadow-lg radius font-sans font-mono
        chart-1`
          .split(/\s+/)
          .map((name) => {
            const value =
              style.getPropertyValue(`--${name}`) ||
              (themeAliases[name]
                ? style.getPropertyValue(`--${themeAliases[name]}`)
                : "");
            return value.trim() ? `--${name}:${value};` : "";
          })
          .join("");
      const scheme =
        style.colorScheme === "dark" || style.colorScheme === "light"
          ? style.colorScheme
          : root.classList.contains("dark") || media.matches
            ? "dark"
            : "light";
      // Match inline-vis's categorical palette for existing saved charts.
      const palette = chartColors[scheme]
        .map((color, index) => `--chart-${index + 2}:${color};`)
        .join("");
      const css = `:root{${variables}${palette}color-scheme:${scheme};}`;
      setTheme((previous) =>
        previous?.css === css ? previous : { css, colorScheme: scheme },
      );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true });
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
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
  const srcDoc = useMemo(
    () => (document && theme ? themedHtml(document.html, theme.css) : null),
    [document?.html, theme?.css],
  );
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
  if (!srcDoc || !theme)
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
      srcDoc={srcDoc}
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
  const [targetResult, setTargetResult] = useState<{
    sequence: number;
    entry?: ThreadExplainer;
    error?: string;
  } | null>(null);
  const [attempt, retryTarget] = useState(0);
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
    if (!target) return;
    let active = true;
    setTargetResult(null);
    rpc.call("attachThreadExplainer", { threadId, ...target.target }).then(
      (entry) => {
        if (active) setTargetResult({ sequence: target.sequence, entry });
      },
      (cause) => {
        if (active)
          setTargetResult({ sequence: target.sequence, error: message(cause) });
      },
    );
    return () => {
      active = false;
    };
  }, [target?.sequence, attempt, rpc, threadId]);
  const resolvedTarget =
    targetResult?.sequence === target?.sequence ? targetResult : null;
  const requested = target ? resolvedTarget?.entry : selected;
  const current =
    requested &&
    (items.find(
      (item) =>
        item.recordId === requested.recordId && item.name === requested.name,
    ) ??
      requested);
  const title = current?.title ?? target?.target.title;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {title && (
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
          <span className="truncate text-sm font-medium">{title}</span>
        </div>
      )}
      {target && !current ? (
        resolvedTarget?.error ? (
          <LoadError
            error={resolvedTarget.error}
            retry={() => retryTarget((value) => value + 1)}
          />
        ) : (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            Loading…
          </p>
        )
      ) : current ? (
        <ExplainerReader
          key={`${current.recordId}/${current.name}`}
          selected={current}
        />
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
  const panel = experimental_useAppPanel();
  const navigate = useBbNavigate();
  const ref = explainerTargetSchema.safeParse({
    recordId: attributes.record,
    name: attributes.artifact,
    title: attributes.title,
  });
  if (!ref.success)
    return (
      <p className="text-sm text-destructive">Invalid explainer reference</p>
    );
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        if (!panel.openTab({ tab: explainersTab, target: ref.data }))
          navigate.toThread(sourceMessage.threadId);
      }}
    >
      {ref.data.title}
    </Button>
  );
}
