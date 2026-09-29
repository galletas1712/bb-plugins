import { afterEach, expect, it } from "vitest";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
} from "@get-bb/plugin-sdk/testing";
import { fileURLToPath } from "node:url";
import plugin from "./server";
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});
function host() {
  const h = createFakePluginHost({ pluginId: "live-file-viewer" });
  hosts.push(h);
  return h;
}
it("uses only public SDK contracts and declared dependencies", () => {
  const scan = experimental_scanPublicSdkOnly(
    fileURLToPath(new URL(".", import.meta.url)),
    {
      allow: [
        /^react$/,
        /^@codemirror\//,
        /^codemirror$/,
        /^vitest$/,
        /^@testing-library\//,
      ],
    },
  );
  expect(scan.violations).toEqual([]);
  expect(scan.privateDependencies).toEqual([]);
});
it("refuses writes to thread-storage artifacts before resolving or touching any file", async () => {
  const { bb, harness } = host();
  plugin(bb);
  await expect(
    harness.behavior.callRpc("write", {
      path: "artifact.html",
      source: {
        kind: "thread-storage",
        threadId: "thread",
        environmentId: null,
        projectId: null,
      },
      content: "changed",
      expectedSha256: "a".repeat(64),
    }),
  ).rejects.toThrow("read-only");
  expect(harness.inspection.sdk.callsTo("files.write")).toHaveLength(0);
});
it("passes the original hash and host to the write operation and returns conflicts unchanged", async () => {
  const { bb, harness } = host();
  harness.sdk.stub("files.write", async () => ({
    outcome: "conflict",
    currentSha256: "b".repeat(64),
  }));
  plugin(bb);
  const result = await harness.behavior.callRpc("write", {
    path: "/workspace/page.html",
    source: {
      kind: "host",
      experimental_hostId: "remote",
      threadId: null,
      environmentId: null,
      projectId: null,
    },
    content: "draft",
    expectedSha256: "a".repeat(64),
  });
  expect(result).toEqual({
    outcome: "conflict",
    currentSha256: "b".repeat(64),
  });
  expect(harness.inspection.sdk.callsTo("files.write")[0]?.[0]).toMatchObject({
    hostId: "remote",
    path: "/workspace/page.html",
    rootPath: "/workspace",
    expectedSha256: "a".repeat(64),
    content: "draft",
  });
});

it("keeps sibling assets reachable while setting the document-relative base", async () => {
  const { bb, harness } = host();
  harness.sdk.stub("environments.get", async () => ({
    path: "/workspace",
    hostId: "remote",
  }));
  harness.sdk.stub("files.createPreview", async () => ({
    baseUrl: "/api/preview/token/",
    expiresAtMs: 1234,
  }));
  plugin(bb);
  const result = await harness.behavior.callRpc("assets", {
    path: "docs/my page.html",
    source: {
      kind: "workspace",
      threadId: "thread",
      environmentId: "env",
      projectId: null,
    },
  });
  expect(result).toEqual({
    baseUrl: "/api/preview/token/docs/",
    expiresAtMs: 1234,
  });
  expect(
    harness.inspection.sdk.callsTo("files.createPreview")[0]?.[0],
  ).toMatchObject({ hostId: "remote", rootPath: "/workspace" });
});
