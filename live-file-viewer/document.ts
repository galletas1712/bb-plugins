import type { EditorState } from "@codemirror/state";
import type { FileRequest } from "./contract";
export type Mode = "preview" | "editor" | "split";
export type SaveResult =
  | { outcome: "written"; sha256: string }
  | { outcome: "conflict"; currentSha256: string | null };
export class DocumentSession {
  content: string;
  saved: string;
  sha256: string;
  editorState?: EditorState;
  mode: Mode = "preview";
  saving = false;
  error: string | null = null;
  conflict = false;
  version = 0;
  previewRevision = 0;
  listeners = new Set<() => void>();
  constructor(
    readonly request: FileRequest,
    file: {
      content: string;
      sha256: string;
      rootPath: string;
      readOnly: boolean;
    },
  ) {
    this.content = this.saved = file.content;
    this.sha256 = file.sha256;
    this.rootPath = file.rootPath;
    this.readOnly = file.readOnly;
  }
  rootPath: string;
  readOnly: boolean;
  get dirty() {
    return this.content !== this.saved;
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.version;
  notify() {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }
  edit(content: string) {
    this.content = content;
    this.notify();
  }
  setMode(mode: Mode) {
    this.mode = mode;
    this.notify();
  }
  async save(
    write: (
      request: FileRequest & { content: string; expectedSha256: string },
    ) => Promise<SaveResult>,
  ) {
    if (this.saving || this.readOnly) return;
    const content = this.content;
    this.saving = true;
    this.error = null;
    this.notify();
    try {
      const result = await write({
        ...this.request,
        content,
        expectedSha256: this.sha256,
      });
      this.conflict = result.outcome === "conflict";
      if (result.outcome === "written") {
        this.sha256 = result.sha256;
        this.saved = content;
        this.previewRevision++;
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.saving = false;
      this.notify();
    }
  }
}
// Retain drafts and undo history when BB unmounts inactive/closed tabs. Session-only;
// never put potentially sensitive file contents in browser persistent storage.
const sessions = new Map<string, DocumentSession>();
const pending = new Map<string, Promise<DocumentSession>>();
export function documentKey({ path, source }: FileRequest) {
  return JSON.stringify([
    source.kind,
    source.threadId,
    source.environmentId,
    source.projectId,
    source.experimental_hostId,
    path,
  ]);
}
export function openDocument(
  request: FileRequest,
  read: () => Promise<{
    content: string;
    sha256: string;
    rootPath: string;
    readOnly: boolean;
  }>,
) {
  const key = documentKey(request),
    current = sessions.get(key);
  if (current) return Promise.resolve(current);
  let load = pending.get(key);
  if (!load) {
    load = read()
      .then((file) => {
        const doc = new DocumentSession(request, file);
        sessions.set(key, doc);
        return doc;
      })
      .finally(() => pending.delete(key));
    pending.set(key, load);
  }
  return load;
}
export function hasDirtyDocuments() {
  return [...sessions.values()].some((doc) => doc.dirty && !doc.readOnly);
}
