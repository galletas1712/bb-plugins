import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { Complete } from "./claude";
import plugin from "./server";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

interface FakeThread {
  title: string | null;
  titleFallback?: string;
  metadata: Record<string, unknown>;
}

function setup(thread: FakeThread, reply: string) {
  const prompts: string[] = [];
  const complete: Complete = async (prompt) => {
    prompts.push(prompt.user);
    return { text: reply, costUsd: 0.0004, durationMs: 1 };
  };
  const host = createFakePluginHost({
    pluginId: "retitle",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId, title: thread.title, titleFallback: thread.titleFallback ?? null }),
        getPluginMetadata: async () => thread.metadata,
        updatePluginMetadata: async ({ set }: { set?: Record<string, unknown> }) => {
          thread.metadata = { ...thread.metadata, ...set };
          return thread.metadata;
        },
        conversationOutline: async () => ({
          items: [
            { id: "1", role: "user", preview: "Write a retitle plugin for bb", attachmentSummary: null },
            { id: "2", role: "assistant", preview: "Done", attachmentSummary: null },
          ],
          maxSeq: 2,
        }),
        update: async ({ title }: { title?: string | null }) => {
          thread.title = title ?? thread.title;
          return makeThreadResponse({ title });
        },
      },
    },
  });
  hosts.push(host);
  plugin(host.bb, { complete });
  return { ...host, prompts };
}

async function userMessageThenIdle(
  host: ReturnType<typeof setup>,
  initiator: "user" | "agent" | "system" = "user",
) {
  const hook = host.harness.inspection.registrations.hooks["message.dispatch"]!;
  const decision = await hook(makeMessageDispatchHookContext({ thread: { id: "thr_1" }, initiator }));
  expect(decision).toEqual({ action: "proceed" });
  await host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: "thr_1" }),
    lastAssistantText: "done",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("retitle plugin", () => {
  it("uses only public SDK contracts", () => {
    const scan = experimental_scanPublicSdkOnly(fileURLToPath(new URL(".", import.meta.url)));
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });

  it("renames after a user message when the model proposes a new title", async () => {
    const thread: FakeThread = { title: "Old title", metadata: {} };
    const host = setup(thread, '{"title":"Retitle plugin for bb"}');
    await userMessageThenIdle(host);
    expect(thread.title).toBe("Retitle plugin for bb");
    expect(thread.metadata).toEqual({ locked: false, lastTitle: "Retitle plugin for bb" });
    expect(host.prompts[0]).toContain("Current title: Old title");
  });

  it("ignores turns not started by a user", async () => {
    const thread: FakeThread = { title: "Old title", metadata: {} };
    const host = setup(thread, '{"title":"New"}');
    await userMessageThenIdle(host, "agent");
    expect(host.prompts).toEqual([]);
    expect(thread.title).toBe("Old title");
  });

  it("keeps the title when the model returns null", async () => {
    const thread: FakeThread = { title: "Old title", metadata: {} };
    const host = setup(thread, '{"title":null}');
    await userMessageThenIdle(host);
    expect(thread.title).toBe("Old title");
    expect(thread.metadata.lastTitle).toBe("Old title");
  });

  it("stops after a manual rename, and --apply clears the lock", async () => {
    const thread: FakeThread = { title: "My own name", metadata: { lastTitle: "Auto name" } };
    const host = setup(thread, '{"title":"Model name"}');
    await userMessageThenIdle(host);
    expect(host.prompts).toEqual([]);
    expect(thread.metadata.locked).toBe(true);

    await userMessageThenIdle(host);
    expect(host.prompts).toEqual([]);

    const result = await host.harness.behavior.runCli(["check", "thr_1", "--apply"]);
    expect(result.stdout).toContain('Renamed: "My own name" -> "Model name"');
    expect(thread.metadata).toEqual({ locked: false, lastTitle: "Model name" });
  });

  it("treats bb's late first title as automatic, not manual", async () => {
    const thread: FakeThread = { title: "bb first title", metadata: { lastTitle: null } };
    const host = setup(thread, '{"title":null}');
    await userMessageThenIdle(host);
    expect(host.prompts).toHaveLength(1);
  });

  it("leaves untitled handoffs alone so they keep showing the source thread's live title", async () => {
    const thread: FakeThread = { title: null, titleFallback: "Continue from @thread:thr_src", metadata: {} };
    const host = setup(thread, '{"title":"Anything"}');
    await userMessageThenIdle(host);
    const result = await host.harness.behavior.runCli(["check", "thr_1", "--apply"]);
    expect(result.stdout).toBe("Skipped: handoff\n");
    expect(host.prompts).toEqual([]);
    expect(thread.title).toBeNull();
  });

  it("check is a dry run by default", async () => {
    const thread: FakeThread = { title: "Old title", metadata: {} };
    const host = setup(thread, '{"title":"New title"}');
    const result = await host.harness.behavior.runCli(["check", "thr_1"]);
    expect(result.stdout).toBe('Would rename: "Old title" -> "New title"\n');
    expect(thread.title).toBe("Old title");
    expect(thread.metadata).toEqual({});
  });
});
