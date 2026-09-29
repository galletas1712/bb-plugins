import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { FileRequest } from "./contract";

export function withinRoot(rootPath: string, relative: string) {
  const paths =
    path.win32.isAbsolute(rootPath) && !path.posix.isAbsolute(rootPath)
      ? path.win32
      : path.posix;
  if (
    relative.includes("\0") ||
    path.posix.isAbsolute(relative) ||
    path.win32.isAbsolute(relative) ||
    relative.split(/[\\/]/).includes("..")
  ) {
    throw new Error("Expected a file path within the selected source");
  }
  return { rootPath, path: paths.join(rootPath, relative) };
}

export async function resolveTarget(
  sdk: BbPluginApi["sdk"],
  { path: filePath, source }: FileRequest,
) {
  if (source.kind === "thread-storage") {
    if (!source.threadId) throw new Error("Missing thread for stored artifact");
    const location = await sdk.threads.storageLocation({
      threadId: source.threadId,
    });
    return {
      ...withinRoot(location.storageRootPath, filePath),
      hostId: location.hostId,
    };
  }
  if (source.kind === "host") {
    if (
      filePath.includes("\0") ||
      !(path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath))
    )
      throw new Error("Expected an absolute host path");
    const hostId =
      source.experimental_hostId ??
      (source.environmentId
        ? (await sdk.environments.get({ environmentId: source.environmentId }))
            .hostId
        : null);
    if (!hostId) throw new Error("Missing host for file");
    const paths =
      path.win32.isAbsolute(filePath) && !path.posix.isAbsolute(filePath)
        ? path.win32
        : path.posix;
    return { hostId, path: filePath, rootPath: paths.dirname(filePath) };
  }
  if (source.environmentId) {
    const environment = await sdk.environments.get({
      environmentId: source.environmentId,
    });
    if (!environment.path || !environment.hostId)
      throw new Error("Workspace is unavailable");
    return {
      ...withinRoot(environment.path, filePath),
      hostId: environment.hostId,
    };
  }
  if (!source.projectId) throw new Error("Missing workspace or project");
  const { sources } = await sdk.projects.get({ projectId: source.projectId });
  const checkout = source.experimental_hostId
    ? sources.find((s) => s.hostId === source.experimental_hostId)
    : (sources.find((s) => s.isDefault) ?? sources[0]);
  if (!checkout) throw new Error("No matching checkout");
  return { ...withinRoot(checkout.path, filePath), hostId: checkout.hostId };
}
