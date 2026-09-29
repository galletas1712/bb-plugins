import { expect, it } from "vitest";
import { resolveTarget, withinRoot } from "./target";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
it("confines relative paths on both host platforms", () => {
  expect(withinRoot("/work", "docs/a.md")).toEqual({
    rootPath: "/work",
    path: "/work/docs/a.md",
  });
  expect(withinRoot("C:\\work", "docs/a.md").path).toBe("C:\\work\\docs\\a.md");
  for (const path of [
    "../secret",
    "foo/../secret",
    "/absolute",
    "C:\\other",
    "..\\secret",
    "bad\0path",
  ])
    expect(() => withinRoot("/work", path)).toThrow();
});
it("routes workspace reads to the environment host and stored artifacts to their owning host", async () => {
  const sdk = {
    environments: { get: async () => ({ path: "/work", hostId: "remote" }) },
    threads: {
      storageLocation: async () => ({
        hostId: "storage-host",
        storageRootPath: "/artifacts",
      }),
    },
  } as unknown as BbPluginApi["sdk"];
  const source = {
    kind: "workspace" as const,
    threadId: "thread",
    environmentId: "env",
    projectId: null,
  };
  expect(await resolveTarget(sdk, { path: "docs/a.md", source })).toEqual({
    path: "/work/docs/a.md",
    rootPath: "/work",
    hostId: "remote",
  });
  expect(
    await resolveTarget(sdk, {
      path: "a.md",
      source: { ...source, kind: "thread-storage" },
    }),
  ).toEqual({
    path: "/artifacts/a.md",
    rootPath: "/artifacts",
    hostId: "storage-host",
  });
});
