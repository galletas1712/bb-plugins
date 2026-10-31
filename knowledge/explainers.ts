import fs from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Library, hash } from "./library";
import {
  explainerRefSchema,
  explainerTitleSchema,
  idSchema,
  isHtml,
  threadExplainerSchema,
  type ExplainerRef,
  type ThreadExplainer,
} from "./schema";

export const MAX_EXPLAINER_BYTES = 5 * 1024 * 1024;
const key = ({ recordId, name }: ExplainerRef) =>
  `explainer:${recordId}/${name}`;

export function explainerReference(ref: ExplainerRef, title: string) {
  const label = title
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `::explainer{record="${ref.recordId}" artifact="${ref.name}" title="${label}"}`;
}

/** Saved bytes belong to Knowledge. Thread metadata only holds named references. */
export class Explainers {
  constructor(
    private bb: BbPluginApi,
    private library: Library,
  ) {}

  read(raw: ExplainerRef) {
    const ref = explainerRefSchema.parse(raw);
    if (!isHtml(ref.name)) throw new Error("Explainers must be HTML files");
    const saved = this.library.artifact(ref.recordId, ref.name);
    if (fs.statSync(saved.path).size > MAX_EXPLAINER_BYTES)
      throw new Error("Explainer exceeds the 5 MiB reader limit");
    const bytes = fs.readFileSync(saved.path);
    if (
      bytes.length > MAX_EXPLAINER_BYTES ||
      bytes.length !== saved.artifact.bytes ||
      hash(bytes) !== saved.artifact.sha256
    )
      throw new Error("Saved explainer checksum mismatch");
    return {
      html: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      sha256: saved.artifact.sha256,
      path: saved.path,
    };
  }

  async list(threadId: string): Promise<ThreadExplainer[]> {
    const metadata = await this.bb.sdk.threads.getPluginMetadata({
      threadId: idSchema.parse(threadId),
    });
    return Object.entries(metadata)
      .flatMap(([entryKey, value]) => {
        const parsed = threadExplainerSchema.safeParse(value);
        return parsed.success &&
          isHtml(parsed.data.name) &&
          entryKey === key(parsed.data)
          ? [parsed.data]
          : [];
      })
      .sort(
        (a, b) =>
          b.addedAt.localeCompare(a.addedAt) || key(a).localeCompare(key(b)),
      );
  }

  async attach(
    threadId: string,
    ref: ExplainerRef,
    rawTitle: string,
    retitle = false,
  ) {
    idSchema.parse(threadId);
    explainerRefSchema.parse(ref);
    const title = explainerTitleSchema.parse(rawTitle);
    this.read(ref);
    const metadata = await this.bb.sdk.threads.getPluginMetadata({ threadId });
    const parsed = threadExplainerSchema.safeParse(metadata[key(ref)]);
    const previous =
      parsed.success && key(parsed.data) === key(ref) ? parsed.data : null;
    const entry: ThreadExplainer = {
      ...ref,
      title: previous && !retitle ? previous.title : title,
      addedAt: previous ? previous.addedAt : new Date().toISOString(),
    };
    await this.bb.sdk.threads.updatePluginMetadata({
      threadId,
      set: { [key(ref)]: entry },
    });
    this.bb.realtime.publish("changed", {});
    return entry;
  }
}
