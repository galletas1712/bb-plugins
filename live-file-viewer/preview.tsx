import { useEffect, useState } from "react";
import { Markdown, useRpc, type MarkdownProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";
import type { DocumentSession } from "./document";
export function fileKind(path: string) {
  return /\.svg$/i.test(path)
    ? "svg"
    : /\.html?$/i.test(path)
      ? "html"
      : "markdown";
}

export function htmlDocument(content: string, baseUrl: string | null) {
  const document = new DOMParser().parseFromString(content, "text/html");
  // Supply the saved file's directory only when the author hasn't supplied a base.
  if (baseUrl && !document.querySelector("base[href]")) {
    const base = document.createElement("base");
    base.href = baseUrl;
    document.head.prepend(base);
  }
  return "<!doctype html>\n" + document.documentElement.outerHTML;
}
export function Preview({ doc }: { doc: DocumentSession }) {
  const rpc = useRpc<typeof rpcContract>();
  const kind = fileKind(doc.request.path);
  const content = doc.saved;
  const revision = doc.previewRevision;
  const [html, setHtml] = useState<{ content: string; revision: number } | null>(null);
  const [assetError, setAssetError] = useState(false);
  useEffect(() => {
    if (kind !== "html") return;
    let stopped = false;
    // Freeze the iframe until the next successful save/reload. Renewing an asset
    // URL in the background would otherwise restart scripts without a save.
    void (async () => {
      let baseUrl: string | null = null;
      try {
        const assets = await rpc.call("assets", doc.request);
        if (stopped) return;
        const url = new URL(assets.baseUrl, window.location.href);
        if (!url.pathname.endsWith("/")) url.pathname += "/";
        baseUrl = url.href;
        setAssetError(false);
      } catch {
        if (stopped) return;
        setAssetError(true);
      }
      setHtml({ content: htmlDocument(content, baseUrl), revision });
    })();
    return () => { stopped = true; };
  }, [doc, kind, rpc, content, revision]);
  const source = doc.request.source;
  let context: MarkdownProps["experimental_document"];
  if (source.threadId && source.kind === "thread-storage")
    context = {
      threadId: source.threadId,
      rootPath: doc.rootPath,
      target: {
        kind: "thread-storage",
        threadId: source.threadId,
        path: doc.request.path,
      },
    };
  if (source.threadId && source.kind === "workspace" && source.environmentId)
    context = {
      threadId: source.threadId,
      rootPath: doc.rootPath,
      target: {
        kind: "workspace",
        environmentId: source.environmentId,
        path: doc.request.path,
      },
    };
  return (
    <div className="lfv-preview" aria-label="Rendered preview">
      {kind === "html" ? (
        <>
          {assetError && (
            <p role="status" className="lfv-notice">
              Local preview assets are unavailable. Save or reload to retry.
            </p>
          )}
          {html && <iframe
            key={html.revision}
            title={`Preview of ${doc.request.path}`}
            sandbox="allow-scripts"
            srcDoc={html.content}
          />}
        </>
      ) : kind === "svg" ? (
        <div className="lfv-svg">
          <img
            alt={`Preview of ${doc.request.path}`}
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`}
          />
        </div>
      ) : (
        <div className="lfv-markdown">
          <Markdown content={content} experimental_document={context} />
        </div>
      )}
    </div>
  );
}
