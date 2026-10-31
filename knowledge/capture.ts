import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Library, hash } from "./library";
import { Explainers, explainerReference } from "./explainers";
import {
  MAX_ARTIFACT_BYTES,
  MAX_CAPTURE_BYTES,
  saveSchema,
  isHtml,
  type KnowledgeRecord,
  type SaveInput,
} from "./schema";

export async function saveRecord(
  bb: BbPluginApi,
  library: Library,
  raw: SaveInput,
  currentThreadId?: string,
) {
  const input = saveSchema.parse(raw);
  const previous = library.find(input.id);
  if (previous?.artifactError) throw new Error(previous.artifactError);
  if (!previous && input.title === undefined)
    throw new Error("New records require title and body");
  if (
    previous &&
    input.global !== undefined &&
    input.global !== (previous.projectId === null)
  )
    throw new Error("A record cannot move between project and global scopes");
  if (input.present.length && !currentThreadId)
    throw new Error("Present requires a calling BB thread");
  for (const item of input.present) {
    if (
      !isHtml(item.name) ||
      ![...input.artifacts, ...(previous?.artifacts ?? [])].some(
        (a) => a.name === item.name,
      )
    )
      throw new Error(
        `Present requires a current or incoming HTML artifact: ${item.name}`,
      );
  }
  if (input.present.length)
    await bb.sdk.threads.get({ threadId: currentThreadId! });
  const explainers = new Explainers(bb, library);
  // Pure presentation does not rewrite notes, provenance, or the manifest.
  if (previous && input.title === undefined && !input.artifacts.length)
    return present(previous);
  const threadId = input.threadId ?? currentThreadId;
  if (!threadId)
    throw new Error("Provide threadId when saving outside a BB thread");
  const thread = await bb.sdk.threads.get({ threadId });
  const sequence =
    input.title !== undefined
      ? ((
          await bb.sdk.threads.events.list({
            threadId,
            order: "desc",
            limit: "1",
          })
        )[0]?.seq ?? 0)
      : 0;
  if (input.sourceSequence !== undefined && input.sourceSequence > sequence)
    throw new Error("Source sequence is ahead of the thread history");
  const evidence = [];
  let total = 0;
  for (const artifact of input.artifacts) {
    const location =
      artifact.source === "thread-storage"
        ? await bb.sdk.threads.storageLocation({
            threadId,
          })
        : thread.environmentId
          ? await bb.sdk.environments.get({
              environmentId: thread.environmentId,
            })
          : null;
    if (!location) throw new Error("The source thread has no workspace");
    const hostId = location.hostId;
    const rootPath =
      "path" in location ? location.path : location.storageRootPath;
    if (!rootPath) throw new Error("The source workspace is unavailable");
    const paths =
      path.win32.isAbsolute(rootPath) && !path.posix.isAbsolute(rootPath)
        ? path.win32
        : path.posix;
    const filePath = paths.resolve(rootPath, artifact.path);
    const relative = paths.relative(rootPath, filePath);
    if (
      !relative ||
      relative.startsWith(".." + paths.sep) ||
      relative === ".." ||
      paths.isAbsolute(relative)
    )
      throw new Error(
        `Artifact must be inside its source ${artifact.source}: ${artifact.path}`,
      );
    const file = await bb.sdk.files.read({
      hostId,
      path: filePath,
      rootPath,
    });
    if (file.sizeBytes > MAX_ARTIFACT_BYTES)
      throw new Error(`Artifact exceeds 16 MiB: ${artifact.name}`);
    const bytes = Buffer.from(
      file.content,
      file.contentEncoding === "base64" ? "base64" : "utf8",
    );
    total += bytes.length;
    if (total > MAX_CAPTURE_BYTES) throw new Error("Capture exceeds 64 MiB");
    if (bytes.length !== file.sizeBytes || hash(bytes) !== file.sha256)
      throw new Error(`Source checksum mismatch: ${artifact.name}`);
    evidence.push({
      name: artifact.name,
      bytes,
      hostId,
      sourcePath: filePath,
    });
  }
  // Metadata-only saves keep the original source: when the caller does not
  // cite a thread and the content is unchanged, the record still originates
  // from the thread that produced the content, not from the maintainer.
  let source = { threadId, sequence: input.sourceSequence ?? sequence };
  if (
    previous &&
    input.threadId === undefined &&
    previous.title === input.title &&
    previous.body === input.body
  )
    source = previous.source;
  const record = library.save(
    input,
    previous ? previous.projectId : input.global ? null : thread.projectId,
    evidence,
    source,
  );
  bb.realtime.publish("changed", {});
  return present(record);

  async function present(record: KnowledgeRecord) {
    const presented = [];
    for (const { name, title } of input.present) {
      const ref = { recordId: input.id, name };
      const reference = explainerReference(ref, title);
      try {
        await explainers.attach(currentThreadId!, ref, title, true);
        presented.push({ name, attached: true, reference });
      } catch (cause) {
        presented.push({
          name,
          attached: false,
          reference,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    return { ...record, presented };
  }
}
