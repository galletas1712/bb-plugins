import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  definePluginApp,
  Markdown,
  experimental_FileLink as FileLink,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";
import type { KnowledgeRecord, RecordSummary } from "./schema";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

const fieldClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm";
function RecordEditor({
  record,
  onSaved,
  onCancel,
}: {
  record: KnowledgeRecord;
  onSaved: (record: KnowledgeRecord) => void;
  onCancel: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [title, setTitle] = useState(record.title);
  const [body, setBody] = useState(record.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await rpc.call("edit", {
        id: record.id,
        expectedVersion: record.version,
        title,
        body,
      });
      onSaved(saved);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-lg border border-border p-4"
    >
      <h2 className="text-base font-medium">Edit knowledge</h2>
      <p className="text-sm text-muted-foreground">
        Keep the context, evidence, and limitations another task will need.
      </p>
      <label className="block text-sm">
        Title
        <Input
          required
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What is this about?"
        />
      </label>
      <label className="block text-sm">
        Content
        <textarea
          required
          rows={8}
          maxLength={60000}
          className={fieldClass}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          disabled={busy || (title === record.title && body === record.body)}
          type="submit"
        >
          {busy ? "Saving…" : "Save changes"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function KnowledgePage({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const connection = useRealtimeConnectionState();
  const [query, setQuery] = useState("");
  const [draftQuery, setDraftQuery] = useState("");
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>(
    [],
  );
  const [engine, setEngine] = useState<"keyword" | "hybrid">("keyword");
  const [offset, setOffset] = useState(0);
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [detail, setDetail] = useState<{
    record: KnowledgeRecord;
    reportPath: string;
    hostId: string | null;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const request = useRef(0);
  const report = useCallback(
    (cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    [],
  );
  const [route, target] = (subPath ?? "").replace(/^\/+/, "").split("/");

  const refresh = useCallback(async () => {
    const current = ++request.current;
    setLoading(true);
    try {
      const search = await rpc.call("search", {
        query,
        ...(project ? { projectId: project } : {}),
        limit: 20,
        offset,
        engine,
      });
      if (current !== request.current) return;
      setRecords(search.records);
      setTotal(search.total);
      setError(null);
    } catch (cause) {
      if (current === request.current) report(cause);
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [rpc, query, project, offset, engine, report]);
  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
    };
  }, [refresh, connection]);
  useEffect(() => {
    sdk.projects.list().then(setProjects, report);
  }, [sdk, report]);
  useRealtime("changed", refresh);
  useEffect(() => {
    let active = true;
    setDetail(null);
    setEditing(false);
    if (route === "record" && target)
      rpc.call("read", { id: target }).then((value) => {
        if (active) setDetail(value);
      }, report);
    return () => {
      active = false;
    };
  }, [route, target, rpc, report]);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Knowledge</h1>
            <p className="text-sm text-muted-foreground">
              Useful results, independent of the session that produced them.
            </p>
          </div>
        </div>
        {detail && (
          <Button
            variant="ghost"
            onClick={() => {
              navigate.toPluginPanel("library");
            }}
          >
            Back to library
          </Button>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {detail && editing ? (
          <RecordEditor
            key={detail.record.id}
            record={detail.record}
            onCancel={() => setEditing(false)}
            onSaved={(record) => {
              setDetail({ ...detail, record });
              setEditing(false);
              void refresh();
            }}
          />
        ) : detail ? (
          <article className="space-y-4 rounded-lg border border-border p-5">
            <div className="text-xs text-muted-foreground">
              Version {detail.record.version} ·{" "}
              {new Date(detail.record.updatedAt).toLocaleDateString()}
            </div>
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-lg font-medium">{detail.record.title}</h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Edit knowledge"
                onClick={() => setEditing(true)}
              >
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m16 3 5 5M4 15 16 3a3.5 3.5 0 0 1 5 5L9 20l-6 1z" />
                </svg>
              </Button>
            </div>
            <Markdown content={detail.record.body} />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate.toThread(detail.record.source.threadId)}
              >
                Source thread
              </Button>
            </div>
            {!!detail.record.artifacts.length && (
              <ul className="space-y-2 text-sm">
                {detail.record.artifacts.map((a) => (
                  <li key={a.file}>
                    {detail.hostId ? (
                      <FileLink
                        target={{
                          kind: "host",
                          hostId: detail.hostId,
                          path:
                            detail.reportPath.replace(
                              /[\\/]versions[\\/][^\\/]+[\\/]report\.md$/,
                              "/",
                            ) + a.file,
                        }}
                      >
                        {a.name}
                      </FileLink>
                    ) : (
                      a.name
                    )}{" "}
                    <span className="text-muted-foreground">
                      {a.bytes.toLocaleString()} bytes
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </article>
        ) : (
          <>
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setOffset(0);
                setQuery(draftQuery);
                if (draftQuery === query && offset === 0) void refresh();
              }}
            >
              <Input
                className="min-w-48 flex-1"
                aria-label="Search knowledge"
                value={draftQuery}
                onChange={(e) => setDraftQuery(e.target.value)}
                placeholder="Search findings, pitfalls, decisions…"
              />
              <select
                className={selectClass}
                aria-label="Project"
                value={project}
                onChange={(e) => {
                  setProject(e.target.value);
                  setOffset(0);
                }}
              >
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} + global
                  </option>
                ))}
              </select>
              <select
                className={selectClass}
                aria-label="Search mode"
                value={engine}
                onChange={(e) => {
                  setEngine(e.target.value as typeof engine);
                  setOffset(0);
                }}
              >
                <option value="keyword">Keyword</option>
                <option value="hybrid">Hybrid</option>
              </select>
              <Button type="submit" disabled={loading}>
                Search
              </Button>
            </form>
            {loading ? (
              <p role="status" className="text-sm text-muted-foreground">
                Searching…
              </p>
            ) : records.length ? (
              <div className="grid gap-3 md:grid-cols-2">
                {records.map((record) => (
                  <button
                    key={record.id}
                    onClick={() =>
                      navigate.toPluginPanel("library", {
                        subPath: `record/${record.id}`,
                      })
                    }
                    className="space-y-2 rounded-lg border border-border p-4 text-left hover:bg-state-hover"
                  >
                    <div className="text-xs text-muted-foreground">
                      {new Date(record.updatedAt).toLocaleDateString()}
                    </div>
                    <h2 className="font-medium">{record.title}</h2>
                    <p className="text-sm text-muted-foreground">
                      {record.snippet}
                    </p>
                  </button>
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                {query
                  ? "No matching results. Try other terms or hybrid search."
                  : "Ask an agent to save useful context or evidence."}
              </p>
            )}
            <div className="flex items-center gap-3 text-sm">
              <Button
                variant="ghost"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 20))}
              >
                Previous
              </Button>
              <span>{total} results</span>
              <Button
                variant="ghost"
                disabled={offset + 20 >= total}
                onClick={() => setOffset(offset + 20)}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "library",
    title: "Knowledge",
    icon: "knowledge/book",
    path: "library",
    component: KnowledgePage,
  });
});
