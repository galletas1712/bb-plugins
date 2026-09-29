import { describe, expect, it } from "vitest";
import { DocumentSession, openDocument } from "./document";
const request = {
  path: "page.html",
  source: {
    kind: "workspace" as const,
    threadId: "thread",
    environmentId: "env",
    projectId: "project",
  },
};
const initial = {
  content: "original",
  sha256: "old-hash",
  rootPath: "/workspace",
  readOnly: false,
};
describe("document lifecycle", () => {
  it("keeps edits made during an in-flight save dirty and saves the next revision against the returned hash", async () => {
    const doc = new DocumentSession(request, initial);
    doc.edit("first");
    let finish!: (value: { outcome: "written"; sha256: string }) => void;
    const pending = doc.save(async (input) => {
      expect(input.content).toBe("first");
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    doc.edit("second");
    finish({ outcome: "written", sha256: "first-hash" });
    await pending;
    expect(doc.content).toBe("second");
    expect(doc.saved).toBe("first");
    expect(doc.dirty).toBe(true);
    await doc.save(async (input) => {
      expect(input.expectedSha256).toBe("first-hash");
      expect(input.content).toBe("second");
      return { outcome: "written", sha256: "second-hash" };
    });
    expect(doc.dirty).toBe(false);
  });
  it("preserves the draft and original hash on an external conflict", async () => {
    const doc = new DocumentSession(request, initial);
    doc.edit("draft");
    await doc.save(async () => ({
      outcome: "conflict",
      currentSha256: "external",
    }));
    expect(doc.content).toBe("draft");
    expect(doc.sha256).toBe("old-hash");
    expect(doc.conflict).toBe(true);
    expect(doc.dirty).toBe(true);
  });
  it("does not write read-only artifacts", async () => {
    const doc = new DocumentSession(request, { ...initial, readOnly: true });
    doc.edit("other");
    await doc.save(async () => {
      throw new Error("must not write");
    });
    expect(doc.error).toBeNull();
  });
  it("shares pending loads and retains drafts across tab remounts", async () => {
    const target = { ...request, path: "cached.md" };
    let reads = 0;
    const read = async () => {
      reads++;
      return initial;
    };
    const [first, second] = await Promise.all([
      openDocument(target, read),
      openDocument(target, read),
    ]);
    expect(first).toBe(second);
    expect(reads).toBe(1);
    first.edit("draft");
    expect((await openDocument(target, read)).content).toBe("draft");
    expect(reads).toBe(1);
  });
});
