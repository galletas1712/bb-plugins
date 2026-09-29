import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  definePluginApp,
  useRpc,
  type PluginFileOpenerProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, FileRequest } from "./contract";
import {
  documentKey,
  hasDirtyDocuments,
  openDocument,
  type DocumentSession,
  type Mode,
} from "./document";
import { Editor } from "./editor";
import { Icon, type IconName } from "./icons";
import { Preview } from "./preview";
import "./app.css";

function Tool({
  label,
  icon,
  active,
  disabled,
  onClick,
}: {
  label: string;
  icon: IconName;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className="lfv-tool"
    >
      <Icon name={icon} className="size-4" />
    </button>
  );
}
export function DocumentView({
  doc,
  lineRange,
}: {
  doc: DocumentSession;
  lineRange?: PluginFileOpenerProps["experimental_lineRange"];
}) {
  useSyncExternalStore(doc.subscribe, doc.snapshot);
  const rpc = useRpc<typeof rpcContract>();
  const root = useRef<HTMLDivElement>(null);
  const panes = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(50);
  const [full, setFull] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [doc.content, doc.mode]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    const content = doc.content;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable in this browser.");
      await navigator.clipboard.writeText(content);
      if (doc.content === content) setCopied(true);
    } catch (error) {
      doc.error = "Could not copy file contents: " + (error instanceof Error ? error.message : String(error));
      doc.notify();
    }
  };
  const save = () => {
    void doc.save((request) => rpc.call("write", request));
  };
  useEffect(() => {
    const changed = () => setFull(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const fullscreen = async () => {
    try {
      if (document.fullscreenElement === root.current)
        await document.exitFullscreen();
      else await root.current?.requestFullscreen();
    } catch (error) {
      doc.error = error instanceof Error ? error.message : String(error);
      doc.notify();
    }
  };
  const reload = async () => {
    setConfirmReload(false);
    setReloading(true);
    try {
      const file = await rpc.call("read", doc.request);
      doc.saved = file.content;
      doc.previewRevision++;
      doc.sha256 = file.sha256;
      doc.conflict = false;
      doc.error = null;
      doc.edit(file.content);
    } catch (error) {
      doc.error = error instanceof Error ? error.message : String(error);
      doc.notify();
    } finally {
      setReloading(false);
    }
  };
  const modes: [Mode, IconName, string][] = [
    ["preview", "Eye", "Preview"],
    ["editor", "Code", "Editor"],
    ["split", "Columns2", "Split view"],
  ];
  return (
    <div
      ref={root}
      className="lfv-root"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          save();
        }
      }}
    >
      <div className="lfv-toolbar">
        <span className="lfv-filename" title={doc.request.path}>
          {doc.request.path.split(/[\\/]/).at(-1)}
        </span>
        <span
          className="lfv-status"
          role="status"
          aria-live="polite"
          title={
            doc.readOnly
              ? "Read-only artifact"
              : doc.saving
                ? "Saving"
                : doc.dirty
                  ? "Unsaved changes"
                  : "Saved"
          }
          aria-label={
            doc.readOnly
              ? "Read-only artifact"
              : doc.saving
                ? "Saving"
                : doc.dirty
                  ? "Unsaved changes"
                  : "Saved"
          }
        >
          <Icon
            name={
              doc.readOnly
                ? "Lock"
                : doc.saving
                  ? "Loading"
                  : doc.dirty
                    ? "Circle"
                    : "Check"
            }
            className={`size-3 ${doc.saving ? "animate-spin" : ""}`}
          />
        </span>
        <div className="lfv-modes" role="group" aria-label="Document view">
          {modes.map(([mode, icon, label]) => (
            <Tool
              key={mode}
              label={label}
              icon={icon}
              active={doc.mode === mode}
              onClick={() => doc.setMode(mode)}
            />
          ))}
        </div>
        {doc.mode === "editor" && (
          <Tool
            label={copied ? "Copied" : "Copy entire file"}
            icon={copied ? "Check" : "Copy"}
            onClick={() => void copy()}
          />
        )}
        <Tool
          label="Save (Ctrl/⌘ S)"
          icon="Save"
          disabled={doc.readOnly || doc.saving || reloading}
          onClick={save}
        />
        <Tool
          label="Reload from disk"
          icon="RotateCcw"
          disabled={doc.saving || reloading}
          onClick={() => (doc.dirty ? setConfirmReload(true) : void reload())}
        />
        {typeof document !== "undefined" && document.fullscreenEnabled && (
          <Tool
            label={full ? "Exit full screen" : "Full screen"}
            icon={full ? "Minimize2" : "Maximize2"}
            onClick={() => void fullscreen()}
          />
        )}
      </div>
      {(doc.error || doc.conflict) && (
        <div className="lfv-notice" role="alert">
          {doc.error ??
            "This file changed on disk. Your draft is preserved. Copy your edits before reloading to reconcile them."}
          <Tool
            label="Dismiss message"
            icon="X"
            onClick={() => {
              doc.error = null;
              doc.conflict = false;
              doc.notify();
            }}
          />
        </div>
      )}
      {confirmReload && (
        <div
          className="lfv-notice"
          role="alertdialog"
          aria-label="Discard unsaved changes"
        >
          Discard unsaved changes and reload?
          <Tool
            label="Discard and reload"
            icon="Check"
            onClick={() => void reload()}
          />
          <Tool
            label="Keep editing"
            icon="X"
            onClick={() => setConfirmReload(false)}
          />
        </div>
      )}
      <div
        ref={panes}
        className={`lfv-panes lfv-${doc.mode}`}
        style={{ "--editor-size": `${ratio}%` } as React.CSSProperties}
      >
        <div
          className="lfv-editor-pane"
          inert={doc.mode === "preview" || reloading}
        >
          <Editor doc={doc} save={save} lineRange={lineRange} />
        </div>
        {doc.mode === "split" && (
          <div
            role="separator"
            tabIndex={0}
            aria-label="Resize editor and preview"
            aria-orientation="vertical"
            aria-valuenow={Math.round(ratio)}
            aria-valuemin={20}
            aria-valuemax={80}
            className="lfv-divider"
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                setRatio((r) =>
                  Math.max(
                    20,
                    Math.min(80, r + (event.key === "ArrowLeft" ? -5 : 5)),
                  ),
                );
              }
            }}
            onPointerDown={(event) =>
              event.currentTarget.setPointerCapture(event.pointerId)
            }
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId))
                return;
              const box = panes.current?.getBoundingClientRect();
              if (box)
                setRatio(
                  Math.max(
                    20,
                    Math.min(
                      80,
                      ((event.clientX - box.left) / box.width) * 100,
                    ),
                  ),
                );
            }}
            onPointerUp={(event) =>
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
          />
        )}
        <Preview doc={doc} />
      </div>
    </div>
  );
}
export function FileViewer(props: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const request: FileRequest = { path: props.path, source: props.source };
  const key = documentKey(request);
  const [state, setState] = useState<{
    key: string;
    doc?: DocumentSession;
    error?: string;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void openDocument(request, () => rpc.call("read", request)).then(
      (doc) => {
        if (!cancelled) setState({ key, doc });
      },
      (error) => {
        if (!cancelled) setState({ key, error: String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, rpc, retry]);
  if (!state || state.key !== key)
    return (
      <div role="status" className="lfv-notice">
        <Icon name="Loading" className="size-4 animate-spin" />
        Loading document…
      </div>
    );
  if (!state.doc)
    return (
      <div role="alert" className="lfv-notice">
        {state.error}
        <Tool
          label="Retry"
          icon="RefreshCw"
          onClick={() => {
            setState(null);
            setRetry((n) => n + 1);
          }}
        />
      </div>
    );
  return (
    <DocumentView
      key={key}
      doc={state.doc}
      lineRange={props.experimental_lineRange}
    />
  );
}
export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "live-preview",
    title: "Live File Viewer",
    extensions: ["md", "markdown", "html", "htm", "svg"],
    component: FileViewer,
  });
  app.contentScripts.register({
    id: "unsaved-document-guard",
    mount() {
      const guard = (event: BeforeUnloadEvent) => {
        if (hasDirtyDocuments()) {
          event.preventDefault();
          event.returnValue = "";
        }
      };
      window.addEventListener("beforeunload", guard);
      return () => window.removeEventListener("beforeunload", guard);
    },
  });
});
