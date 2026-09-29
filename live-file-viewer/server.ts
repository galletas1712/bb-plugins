import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MAX_BYTES, rpcContract } from "./contract";
import { resolveTarget } from "./target";

export default function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    async read(request) {
      const target = await resolveTarget(bb.sdk, request);
      const file = await bb.sdk.files.read(target);
      if (file.contentEncoding !== "utf8")
        throw new Error("This file is not UTF-8 text");
      if (file.sizeBytes > MAX_BYTES)
        throw new Error("Live previews support files up to 5 MiB");
      return {
        content: file.content,
        sha256: file.sha256,
        rootPath: target.rootPath,
        readOnly: request.source.kind === "thread-storage",
      };
    },
    async assets(request) {
      const target = await resolveTarget(bb.sdk, request);
      const paths =
        path.win32.isAbsolute(target.path) &&
        !path.posix.isAbsolute(target.path)
          ? path.win32
          : path.posix;
      const preview = await bb.sdk.files.createPreview({
        hostId: target.hostId,
        rootPath: target.rootPath,
        ttlMs: 60 * 60 * 1000,
      });
      const directory = paths.relative(
        target.rootPath,
        paths.dirname(target.path),
      );
      const suffix = directory
        .split(/[\\/]/)
        .filter(Boolean)
        .map(encodeURIComponent)
        .join("/");
      return {
        ...preview,
        baseUrl:
          preview.baseUrl.replace(/\/$/, "") +
          "/" +
          (suffix ? suffix + "/" : ""),
      };
    },
    async write(request) {
      if (request.source.kind === "thread-storage")
        throw new Error("Thread-storage artifacts are read-only");
      if (Buffer.byteLength(request.content, "utf8") > MAX_BYTES)
        throw new Error("Live previews support files up to 5 MiB");
      const target = await resolveTarget(bb.sdk, request);
      const result = await bb.sdk.files.write({
        ...target,
        content: request.content,
        contentEncoding: "utf8",
        expectedSha256: request.expectedSha256,
      });
      return result.outcome === "written"
        ? { outcome: "written" as const, sha256: result.sha256 }
        : { outcome: "conflict" as const, currentSha256: result.currentSha256 };
    },
  });
}
