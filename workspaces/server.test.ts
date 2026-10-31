import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
  type ExperimentalFakeHostRpcCall,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import plugin from "./server.js";

const PROJECT = "/src/dynamo";
const OFFERED = ["alpha", "beta"];

/** A fake host entry that remembers which repos each workspace holds. */
function fakeHost() {
  const workspaces = new Map<string, Set<string>>();
  const removed: unknown[] = [];
  const branches: unknown[] = [];
  return {
    workspaces,
    removed,
    branches,
    call({ method, input }: ExperimentalFakeHostRpcCall) {
      const args = input as { pathKey: string; repos: { name: string }[] };
      switch (method) {
        case "scan":
          return { repos: OFFERED };
        case "branch":
          branches.push(input);
          return { branch: "me/task" };
        case "ensure": {
          const names = args.repos.map(({ name }) => name);
          const unknown = names.filter((name) => !OFFERED.includes(name));
          if (unknown.length > 0) throw new Error(`Unknown repo ${unknown.join(", ")}.`);
          const held = workspaces.get(args.pathKey) ?? new Set<string>();
          const created = names.filter((name) => !held.has(name));
          for (const name of created) held.add(name);
          workspaces.set(args.pathKey, held);
          return { path: `/data/workspaces/${args.pathKey}`, created };
        }
        case "remove":
          removed.push(input);
          workspaces.delete(args.pathKey);
          return {};
        case "changes":
          return { repos: [{ name: "alpha", branch: "bb/task", base: null, files: [], truncated: false, error: null }] };
        case "diff":
          return { patch: "diff --git a/x b/x" };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

async function load(sdk: Record<string, unknown> = {}) {
  const host = fakeHost();
  const { bb, harness } = createFakePluginHost({
    pluginId: "workspaces",
    sdk,
    experimental_callHostRpc: (call) => host.call(call),
  });
  await plugin(bb);
  const provider = harness.registrations.environmentProviders.get("workspaces")!;
  return { bb, harness, host, provider };
}

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    project: { id: "proj_1" },
    host: makeHostResponse({ id: "host_1" }),
    projectCheckout: { path: PROJECT, experimental_ownsPath: false },
    gitRemote: null,
    inputs: { repos: ["alpha"] },
    thread: makeThreadResponse({ id: "thr_1" }),
    suggestedBranchName: "bb/task-thr_1",
    attempt: 1,
    pathKey: "thr_1-1",
    experimental_claimPath: async () => true,
    report: { step: () => {}, log: () => {} },
    signal: new AbortController().signal,
    ...overrides,
  } as never;
}

function restoreContext(previousKey: string, pathKey: string) {
  return {
    ...(createContext({ pathKey, projectCheckout: { path: "/moved/dynamo", experimental_ownsPath: false } }) as object),
    previous: { environment: { environmentProviderInstanceKey: previousKey }, resource: null },
  } as never;
}

function removeContext(pathKey: string) {
  return {
    environment: null,
    hostId: "host_1",
    path: null,
    pathKey,
    resource: null,
    attempt: 1,
    report: { step: () => {}, log: () => {} },
    signal: new AbortController().signal,
  } as never;
}

describe("workspaces provider", () => {
  it("creates the picked repos on a branch the host names, and records them with their starts", async () => {
    const { bb, host, provider } = await load();

    expect(await provider.create(createContext({ inputs: { repos: ["alpha@origin/feature"] } }))).toEqual({
      status: "created",
      path: "/data/workspaces/thr_1-1",
      ownsPath: true,
    });
    expect(host.branches).toEqual([{ projectPath: PROJECT, suggested: "bb/task-thr_1" }]);
    expect([...host.workspaces.get("thr_1-1")!]).toEqual(["alpha"]);
    expect(await bb.storage.kv.get("workspace:thr_1-1")).toEqual({
      projectPath: PROJECT,
      branch: "me/task",
      repos: [{ name: "alpha", from: "origin/feature" }],
    });
  });

  it("creates an empty workspace when no repo is picked", async () => {
    const { provider } = await load();

    expect(await provider.create(createContext({ inputs: { repos: [] } }))).toMatchObject({ status: "created" });
  });

  it("keeps the first branch name when create is called again after a rename", async () => {
    const { bb, host, provider } = await load();
    await provider.create(createContext());

    await provider.create(createContext({ suggestedBranchName: "bb/renamed-thr_1" }));

    expect(host.branches).toHaveLength(1);
    expect(await bb.storage.kv.get("workspace:thr_1-1")).toMatchObject({ branch: "me/task" });
  });

  it("fails create with the host's reason", async () => {
    const { provider } = await load();

    expect(await provider.create(createContext({ inputs: { repos: ["gamma"] } }))).toEqual({
      status: "failed",
      message: "Unknown repo gamma.",
    });
  });

  it("removes the folder and keeps the repo list for restore", async () => {
    const { bb, host, provider } = await load();
    await provider.create(createContext({ inputs: { repos: ["alpha", "beta"] } }));

    expect(await provider.remove(removeContext("thr_1-1"))).toEqual({ status: "removed" });

    expect(host.removed).toEqual([{ pathKey: "thr_1-1" }]);
    expect(await bb.storage.kv.get("workspace:thr_1-1")).toMatchObject({
      repos: [{ name: "alpha", from: null }, { name: "beta", from: null }],
    });
  });

  it("restores under the new key and project path, and can restore again", async () => {
    const { bb, host, provider } = await load();
    await provider.create(createContext({ inputs: { repos: ["alpha", "beta"] } }));
    await provider.remove(removeContext("thr_1-1"));

    const expected = { status: "created", path: "/data/workspaces/thr_1-2", ownsPath: true };
    expect(await provider.restore!(restoreContext("thr_1-1", "thr_1-2"))).toEqual(expected);
    // Core can call restore again with the same previous environment.
    expect(await provider.restore!(restoreContext("thr_1-1", "thr_1-2"))).toEqual(expected);
    expect([...host.workspaces.get("thr_1-2")!]).toEqual(["alpha", "beta"]);
    expect(await bb.storage.kv.get("workspace:thr_1-2")).toEqual({
      projectPath: "/moved/dynamo",
      branch: "me/task",
      repos: [{ name: "alpha", from: null }, { name: "beta", from: null }],
    });
  });

  it("cannot restore a workspace whose repo list was never saved", async () => {
    const { provider } = await load();

    expect(await provider.restore!(restoreContext("thr_9-1", "thr_9-2"))).toMatchObject({ status: "failed" });
  });

  it("lists the project's repos for the picker", async () => {
    const { harness } = await load({
      projects: {
        get: async () => ({ sources: [{ hostId: "host_1", type: "local_path", path: PROJECT }] }),
      },
      environments: { list: async () => [] },
    });

    expect(await harness.behavior.callRpc("listRepos", { projectId: "proj_1", hostId: "host_1" })).toEqual({
      repos: OFFERED,
      previous: null,
    });
  });

  it("remembers successful initial selections and refs separately for each project", async () => {
    const { harness, provider } = await load({
      projects: { get: async () => ({ sources: [{ hostId: "host_1", type: "local_path", path: PROJECT }] }) },
    });
    await provider.create(createContext({ inputs: { repos: ["alpha@origin/topic", "beta@#12"] } }));
    await provider.create(createContext({ project: { id: "proj_2" }, pathKey: "other", inputs: { repos: [] } }));

    expect(await harness.behavior.callRpc("listRepos", { projectId: "proj_1", hostId: "host_1" })).toEqual({
      repos: OFFERED, previous: ["alpha@origin/topic", "beta@#12"],
    });
    expect(await harness.behavior.callRpc("listRepos", { projectId: "proj_2", hostId: "host_1" })).toEqual({
      repos: OFFERED, previous: [],
    });
  });

  it("keeps the newer workspace selection when an older create finishes later or is retried", async () => {
    const { bb, provider } = await load();
    const older = createContext({ pathKey: "older", thread: makeThreadResponse({ createdAt: 10 }), inputs: { repos: ["alpha"] } });
    const newer = createContext({ pathKey: "newer", thread: makeThreadResponse({ createdAt: 20 }), inputs: { repos: ["beta@main"] } });
    await provider.create(older);
    await provider.create(newer);
    await provider.create(older);
    expect(await bb.storage.kv.get("selection:proj_1")).toMatchObject({ repos: ["beta@main"] });
  });

  it("does not remember a failed workspace creation", async () => {
    const { bb, provider } = await load();
    await provider.create(createContext({ inputs: { repos: ["gamma"] } }));
    expect(await bb.storage.kv.get("selection:proj_1")).toBeUndefined();
  });

  it("uses the latest completed existing workspace before a project has a saved selection", async () => {
    const list = vi.fn(async ({ offset }: { offset: number }) => offset === 0
      ? [
          { createdAt: 10, status: "ready", environmentProviderSelection: { inputs: { repos: ["alpha@main"] } } },
          { createdAt: 30, status: "error", environmentProviderSelection: { inputs: { repos: ["alpha"] } } },
          { createdAt: 20, status: "destroyed", environmentProviderSelection: { inputs: { repos: ["beta@#7"] } } },
        ]
      : []);
    const { harness } = await load({
      projects: { get: async () => ({ sources: [{ hostId: "host_1", type: "local_path", path: PROJECT }] }) },
      environments: { list },
    });
    expect(await harness.behavior.callRpc("listRepos", { projectId: "proj_1", hostId: "host_1" })).toEqual({
      repos: OFFERED, previous: ["beta@#7"],
    });
    expect(list).toHaveBeenCalledWith({ projectId: "proj_1", environmentProviderId: "workspaces", limit: 100, offset: 0 });
  });
});

describe("bb workspaces add", () => {
  const sdk = {
    threads: { get: async () => makeThreadResponse({ id: "thr_1", environmentId: "env_1" }) },
    environments: {
      get: async () => ({
        environmentProviderId: "workspaces",
        environmentProviderInstanceKey: "thr_1-1",
        hostId: "host_1",
        status: "ready",
        lifecycle: { phase: "active" },
      }),
    },
  };

  it("adds repos to the current thread's workspace and keeps the ones it has", async () => {
    const { bb, harness, host, provider } = await load(sdk);
    await provider.create(createContext());

    const result = await harness.behavior.runCli(["add", "beta@#12", "alpha@main"], { threadId: "thr_1" } as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Added beta at /data/workspaces/thr_1-1/beta on branch me/task.");
    expect(result.stdout).toContain("alpha is already in the workspace");
    expect([...host.workspaces.get("thr_1-1")!]).toEqual(["alpha", "beta"]);
    expect(await bb.storage.kv.get("workspace:thr_1-1")).toMatchObject({
      repos: [{ name: "alpha", from: null }, { name: "beta", from: "#12" }],
    });
  });

  it("rejects a start point git could misread", async () => {
    const { harness, provider } = await load(sdk);
    await provider.create(createContext());

    const result = await harness.behavior.runCli(["add", "beta@main..evil"], { threadId: "thr_1" } as never);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Not a repo or <repo>@<start>: beta@main..evil");
  });

  it("reports the host's reason and records nothing when an add fails", async () => {
    const { bb, harness, provider } = await load(sdk);
    await provider.create(createContext());

    const result = await harness.behavior.runCli(["add", "gamma"], { threadId: "thr_1" } as never);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unknown repo gamma.");
    expect(await bb.storage.kv.get("workspace:thr_1-1")).toMatchObject({ repos: [{ name: "alpha", from: null }] });
  });

  it("asks for a thread outside an agent shell", async () => {
    const { harness } = await load(sdk);

    const result = await harness.behavior.runCli(["add", "beta"], {} as never);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--thread");
  });
});

describe("Changes panel", () => {
  function environmentSdk(environment: Record<string, unknown>) {
    return {
      threads: { get: async () => makeThreadResponse({ id: "thr_1", environmentId: "env_1" }) },
      environments: {
        get: async () => ({ hostId: "host_1", path: "/data/workspaces/thr_1-1", status: "ready", ...environment }),
      },
    };
  }

  it("reads changes and diffs from the thread's folder on its machine", async () => {
    const { harness } = await load(environmentSdk({}));

    expect(await harness.behavior.callRpc("changes", { threadId: "thr_1", mode: "working" })).toMatchObject({
      status: "ready",
      repos: [{ name: "alpha" }],
    });
    const diff = { threadId: "thr_1", repo: "alpha", path: "x", oldPath: null, mode: "branch", untracked: false };
    expect(await harness.behavior.callRpc("diff", diff)).toEqual({ patch: "diff --git a/x b/x" });
    const calls = harness.inspection.experimental_hostRpcCalls.map((call) => [
      call.method,
      call.hostId,
      (call.input as { root: string }).root,
    ]);
    expect(calls).toEqual([
      ["changes", "host_1", "/data/workspaces/thr_1-1"],
      ["diff", "host_1", "/data/workspaces/thr_1-1"],
    ]);
  });

  it("says when the thread's folder is gone", async () => {
    const { harness } = await load(environmentSdk({ status: "destroyed", path: null }));

    expect(await harness.behavior.callRpc("changes", { threadId: "thr_1", mode: "working" })).toEqual({
      status: "unavailable",
      reason: "This thread has no workspace folder right now.",
    });
  });
});
