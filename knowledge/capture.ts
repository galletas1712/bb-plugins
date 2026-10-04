import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Library, hash } from "./library";
import {
  MAX_ARTIFACT_BYTES,
  MAX_CAPTURE_BYTES,
  saveSchema,
  type SaveInput,
} from "./schema";

export async function saveRecord(
  bb: BbPluginApi,
  library: Library,
  raw: SaveInput,
  currentThreadId?: string,
) {
  const input = saveSchema.parse(raw);
  const threadId = input.threadId ?? currentThreadId;
  if (!threadId)
    throw new Error("Provide threadId when saving outside a BB thread");
  const thread = await bb.sdk.threads.get({ threadId });
  const sequence =
    (await bb.sdk.threads.events.list({
      threadId,
      order: "desc",
      limit: "1",
    }))[0]?.seq ?? 0;
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
  const record = library.save(
    input,
    input.global ? null : thread.projectId,
    evidence,
    { threadId, sequence: input.sourceSequence ?? sequence },
  );
  bb.realtime.publish("changed", {});
  return record;
}
