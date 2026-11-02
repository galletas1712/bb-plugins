import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { Library, hash } from "./library";
import {
  Explainers,
  MAX_EXPLAINER_BYTES,
  explainerReference,
} from "./explainers";
import { saveSchema } from "./schema";

describe("saved thread explainers", () => {
  let root: string;
  let library: Library;
  let host: ReturnType<typeof createFakePluginHost>;
  let metadata: Record<string, Record<string, any>>;
  let files: Record<string, Buffer>;
  const ref = { recordId: "handoff", name: "overview.html" };
  const present = [{ name: ref.name, title: "How request handoff works" }];

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-test-"));
    library = new Library(root);
    metadata = {};
    files = { "/storage/overview.html": Buffer.from("<h1>Handoff</h1>") };
    host = createFakePluginHost({
      pluginId: "knowledge",
      settings: { libraryPath: root },
      sdk: {
        threads: {
          get: async ({ threadId }) =>
            makeThreadResponse({
              id: threadId,
              projectId: "project-one",
              environmentId: "environment-one",
            }),
          events: { list: async () => [{ seq: 42 }] },
          storageLocation: async () => ({
            hostId: "host-one",
            storageRootPath: "/storage",
          }),
          getPluginMetadata: async ({ threadId }) => metadata[threadId] ?? {},
          updatePluginMetadata: async ({ threadId, set }) =>
            (metadata[threadId] = { ...metadata[threadId], ...set }),
        },
        files: {
          read: async ({ path: filePath }) => {
            const bytes = files[filePath];
            if (!bytes) throw new Error("Source unavailable");
            return {
              content: bytes.toString("base64"),
              contentEncoding: "base64",
              sizeBytes: bytes.length,
              sha256: hash(bytes),
            };
          },
        },
        system: { config: async () => ({ primaryHostId: "host-one" }) },
      },
    });
    await plugin(host.bb);
  });
  afterEach(async () => {
    await host.harness.lifecycle.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function save(input: object, threadId = "caller") {
    return JSON.parse(
      (await host.harness.behavior.callAgentTool("knowledge_save", input, {
        threadId,
      })) as string,
    );
  }
  const capture = {
    id: "handoff",
    title: "Request handoff",
    body: "The coordinator hands requests to workers.",
    artifacts: [
      {
        name: "overview.html",
        path: "overview.html",
        source: "thread-storage",
      },
    ],
  };

  it("saves before attaching and only presents explicit HTML", async () => {
    const first = await save(capture);
    expect(first.presented).toEqual([]);
    expect(metadata).toEqual({});
    const result = await save({ id: "handoff", present });
    expect(result.presented[0]).toMatchObject({
      attached: true,
      name: ref.name,
    });
    expect(result.presented[0].reference).toContain(
      'title="How request handoff works"',
    );
    expect(
      await host.harness.behavior.callRpc("listThreadExplainers", {
        threadId: "caller",
      }),
    ).toEqual([expect.objectContaining({ ...ref, title: present[0].title })]);
    expect(
      await host.harness.behavior.callRpc("readExplainer", ref),
    ).toMatchObject({
      html: "<h1>Handoff</h1>",
      sha256: first.artifacts[0].sha256,
    });
  });

  it("quotes directive labels using Markdown attribute entities", () => {
    expect(explainerReference(ref, 'How "handoff" works & why <now>')).toBe(
      '::explainer{record="handoff" artifact="overview.html" title="How &quot;handoff&quot; works &amp; why &lt;now&gt;"}',
    );
  });

  it("keeps the original source when another thread rewrites the text", async () => {
    await save(capture, "origin");
    const original = library.read("handoff").source;
    expect(original.threadId).toBe("origin");
    const rewritten = await save(
      { id: "handoff", title: "Handoff", body: "Revised notes" },
      "maintainer",
    );
    expect(rewritten.source).toEqual(original);
    expect(library.read("handoff").body).toBe("Revised notes");
    const cited = await save(
      { id: "handoff", title: "Handoff", body: "Cited", threadId: "cited" },
      "maintainer",
    );
    expect(cited.source).toEqual({ threadId: "cited", sequence: 42 });
  });

  it("keeps scope, provenance and body mtime for attachment-only saves", async () => {
    await save({ ...capture, global: true });
    const original = library.read("handoff");
    const body = fs.readFileSync(library.bodyPath("handoff"));
    const mtime = fs.statSync(library.bodyPath("handoff")).mtimeMs;
    files["/storage/overview.html"] = Buffer.from("<h1>Updated</h1>");
    const result = await save(
      {
        id: "handoff",
        threadId: "bytes-source",
        artifacts: capture.artifacts,
        present,
      },
      "destination",
    );
    expect(result).toMatchObject({
      projectId: null,
      source: original.source,
      createdAt: original.createdAt,
    });
    expect(fs.readFileSync(library.bodyPath("handoff"))).toEqual(body);
    expect(fs.statSync(library.bodyPath("handoff")).mtimeMs).toBe(mtime);
    expect(metadata.destination).toBeDefined();
    expect(metadata["bytes-source"]).toBeUndefined();
    const manifest = path.join(root, "records/handoff/artifacts.json");
    const before = [
      fs.statSync(manifest).mtimeMs,
      fs.statSync(library.bodyPath("handoff")).mtimeMs,
    ];
    await save({ id: "handoff", present }, "reuse");
    expect([
      fs.statSync(manifest).mtimeMs,
      fs.statSync(library.bodyPath("handoff")).mtimeMs,
    ]).toEqual(before);
    expect(metadata.reuse).toBeDefined();
  });

  it("replaces current entries without resurrecting old or orphaned bytes", async () => {
    const first = await save(capture);
    files["/storage/overview.html"] = Buffer.from("<p>Revision two</p>");
    const second = await save({ id: "handoff", artifacts: capture.artifacts });
    expect(second.artifacts).toHaveLength(1);
    expect(second.artifacts[0].sha256).not.toBe(first.artifacts[0].sha256);
    expect(
      fs.existsSync(
        path.join(root, "records/handoff", first.artifacts[0].file),
      ),
    ).toBe(true);
    fs.unlinkSync(path.join(root, "records/handoff/artifacts.json"));
    expect(library.read("handoff").artifacts).toEqual([]);
    await expect(save({ id: "handoff", present })).rejects.toThrow(
      "current or incoming HTML",
    );
  });

  it("validates presentation before reading or writing capture files", async () => {
    await expect(
      save({
        ...capture,
        present: [{ name: "missing.html", title: "Missing" }],
      }),
    ).rejects.toThrow("current or incoming HTML");
    await expect(
      save({ ...capture, present: [{ name: "overview.html", title: " " }] }),
    ).rejects.toThrow();
    await expect(
      save({ id: "new", artifacts: capture.artifacts }),
    ).rejects.toThrow("title and body");
    await expect(
      host.harness.behavior.callRpc("save", { ...capture, present }),
    ).rejects.toThrow("calling BB thread");
    expect(host.harness.inspection.sdk.callsTo("files.read")).toHaveLength(0);
    expect(library.all()).toEqual([]);
    await save(capture);
    await expect(
      save({ id: "handoff", sourceSequence: 1, present }),
    ).rejects.toThrow("requires record text");
    await expect(save({ id: "handoff", global: true })).rejects.toThrow(
      "cannot move",
    );
    await expect(
      host.harness.behavior.callRpc("edit", { id: "handoff" }),
    ).rejects.toThrow();
  });

  it("reports saved-but-unattached honestly and recovers through the opener", async () => {
    host.harness.sdk.stub("threads.updatePluginMetadata", async () => {
      throw new Error("metadata offline");
    });
    const saved = await save({ ...capture, present });
    expect(saved.presented[0]).toMatchObject({
      attached: false,
      error: "metadata offline",
    });
    expect(library.read("handoff").artifacts).toHaveLength(1);
    host.harness.sdk.stub(
      "threads.updatePluginMetadata",
      async ({ threadId, set }) =>
        (metadata[String(threadId)] = {
          ...metadata[String(threadId)],
          ...(set as Record<string, unknown>),
        }),
    );
    await host.harness.behavior.callRpc("attachThreadExplainer", {
      ...ref,
      threadId: "caller",
      title: present[0].title,
    });
    const first = (await new Explainers(host.bb, library).list("caller"))[0];
    await save({
      id: "handoff",
      present: [{ name: ref.name, title: "New short title" }],
    });
    const writes = host.harness.inspection.sdk.callsTo(
      "threads.updatePluginMetadata",
    ).length;
    await host.harness.behavior.callRpc("attachThreadExplainer", {
      ...ref,
      threadId: "caller",
      title: "Old opener title",
    });
    expect(
      (await new Explainers(host.bb, library).list("caller"))[0],
    ).toMatchObject({ title: "New short title", addedAt: first.addedAt });
    expect(
      host.harness.inspection.sdk.callsTo("threads.updatePluginMetadata"),
    ).toHaveLength(writes);
    await save({
      id: "handoff",
      present: [{ name: ref.name, title: "New short title" }],
    });
    expect(
      host.harness.inspection.sdk.callsTo("threads.updatePluginMetadata"),
    ).toHaveLength(writes);
  });

  it("merges concurrent captures and keeps sessions independent", async () => {
    await save(capture);
    files["/storage/other.html"] = Buffer.from("<p>Other explainer</p>");
    await Promise.all([
      save({ id: "handoff", artifacts: capture.artifacts, present }),
      save({
        id: "handoff",
        artifacts: [
          { name: "other.html", path: "other.html", source: "thread-storage" },
        ],
        present: [{ name: "other.html", title: "Other explanation" }],
      }),
    ]);
    expect(library.read("handoff").artifacts).toHaveLength(2);
    expect(await new Explainers(host.bb, library).list("caller")).toHaveLength(
      2,
    );
    expect(await new Explainers(host.bb, library).list("side-chat")).toEqual(
      [],
    );
    metadata.caller.junk = {
      ...ref,
      title: "Junk",
      addedAt: new Date().toISOString(),
    };
    metadata.caller["explainer:evil/overview.html"] = {
      ...ref,
      title: "Wrong key",
      addedAt: new Date().toISOString(),
    };
    expect(await new Explainers(host.bb, library).list("caller")).toHaveLength(
      2,
    );
  });

  it("refuses corrupt manifests without hiding unrelated notes", async () => {
    await save(capture);
    await save({ id: "notes", title: "Notes", body: "Other useful context" });
    const manifest = path.join(root, "records/handoff/artifacts.json");
    fs.writeFileSync(manifest, "{broken");
    expect(library.all()).toHaveLength(2);
    expect(library.read("handoff")).toMatchObject({
      artifactError: expect.stringMatching(
        /^Invalid artifact manifest for handoff: .*JSON/,
      ),
      artifacts: [],
    });
    await expect(
      save({ id: "handoff", artifacts: capture.artifacts }),
    ).rejects.toThrow("Invalid artifact manifest");
    expect(fs.readFileSync(manifest, "utf8")).toBe("{broken");
    const sha256 = "a".repeat(64);
    const listed = {
      name: "a.txt",
      file: `artifacts/${sha256}-a.txt`,
      sha256,
      bytes: 1,
      sourcePath: "/a",
      hostId: "host-one",
    };
    fs.writeFileSync(manifest, JSON.stringify([listed, listed]));
    expect(library.read("handoff").artifactError).toBe(
      "Invalid artifact manifest for handoff: Duplicate artifact names in manifest",
    );
  });

  it("checks current bytes, path confinement, UTF-8 and reader size", async () => {
    await save(capture);
    const explainers = new Explainers(host.bb, library);
    const saved = library.artifact(ref.recordId, ref.name);
    fs.writeFileSync(saved.path, "tampered");
    expect(() => explainers.read(ref)).toThrow("checksum mismatch");
    library.save(
      saveSchema.parse({ id: "handoff" }),
      "project-one",
      [
        {
          name: ref.name,
          bytes: Buffer.from([0xff]),
          hostId: "host-one",
          sourcePath: "/bad",
        },
      ],
      library.read("handoff").source,
    );
    expect(() => explainers.read(ref)).toThrow();
    library.save(
      saveSchema.parse({ id: "handoff" }),
      "project-one",
      [
        {
          name: ref.name,
          bytes: Buffer.alloc(MAX_EXPLAINER_BYTES + 1),
          hostId: "host-one",
          sourcePath: "/large",
        },
      ],
      library.read("handoff").source,
    );
    expect(() => explainers.read(ref)).toThrow("5 MiB");
    const manifest = path.join(root, "records/handoff/artifacts.json");
    const artifacts = library.read("handoff").artifacts;
    fs.writeFileSync(
      manifest,
      JSON.stringify([{ ...artifacts[0], file: "../body.md" }]),
    );
    expect(() => explainers.read(ref)).toThrow("Invalid saved artifact path");
  });
});
