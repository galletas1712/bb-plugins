import { describe, expect, it } from "vitest";
import { buildTitlePrompt, parseTitleReply, renderDigest, sanitizeTitle, TITLE_MAX_CHARS } from "./prompt";

const user = (preview: string) => ({ role: "user" as const, preview });
const assistant = (preview: string) => ({ role: "assistant" as const, preview });

describe("renderDigest", () => {
  it("keeps everything that fits, in order", () => {
    expect(renderDigest([user("fix the scheduler"), assistant("done")])).toBe(
      "User: fix the scheduler\nAssistant: done",
    );
  });

  it("pins the first user message and keeps the newest messages within budget", () => {
    const items = [user("goal"), ...Array.from({ length: 50 }, (_, i) => assistant(`step ${i}`))];
    const digest = renderDigest(items, 60);
    const lines = digest.split("\n");
    expect(lines[0]).toBe("User: goal");
    expect(lines[1]).toMatch(/^\[\d+ messages omitted\]$/u);
    expect(lines.at(-1)).toBe("Assistant: step 49");
    expect(digest).not.toContain("step 0\n");
  });

  it("returns an empty digest for an empty conversation", () => {
    expect(renderDigest([user("  ")])).toBe("");
  });
});

describe("buildTitlePrompt", () => {
  it("uses the initial prompt when there is no title, the refresh prompt otherwise", () => {
    const items = [user("fix the scheduler")];
    expect(buildTitlePrompt(null, items)!.system).toContain("has no title yet");
    const refresh = buildTitlePrompt("Fix scheduler", items)!;
    expect(refresh.system).toContain('Default to "title": null');
    expect(refresh.user).toContain("Current title: Fix scheduler");
  });

  it("writes a fresh title when the current one is over the limit", () => {
    const prompt = buildTitlePrompt("x".repeat(TITLE_MAX_CHARS + 1), [user("fix the scheduler")])!;
    expect(prompt.system).toContain("has no title yet");
  });

  it("asks for module names", () => {
    expect(buildTitlePrompt(null, [user("x")])!.system).toContain("exactly as written");
  });
});

describe("parseTitleReply", () => {
  it("reads a title, a fenced title, and null", () => {
    expect(parseTitleReply('{"reason":"topic moved","title":"Retitle plugin for bb"}')).toBe("Retitle plugin for bb");
    expect(parseTitleReply('```json\n{"title": "Fix provider-codex auth."}\n```')).toBe("Fix provider-codex auth");
    expect(parseTitleReply('{"title":null}')).toBeNull();
    expect(parseTitleReply("Sure! Here is a title")).toBeNull();
  });
});

describe("sanitizeTitle", () => {
  it("cuts long titles at a word boundary", () => {
    const title = sanitizeTitle("word ".repeat(30))!;
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(title.endsWith("word")).toBe(true);
  });

  it("drops connectors stranded by the cut", () => {
    expect(sanitizeTitle("Rewrite PR #328 stack descriptions and comments today")).toBe("Rewrite PR #328 stack descriptions");
    expect(sanitizeTitle("Measure restore speedup across nodes for the GPU cluster")).toBe("Measure restore speedup across nodes");
  });

  it("rejects credential-looking titles", () => {
    expect(sanitizeTitle("api_key=abc123")).toBeNull();
    expect(sanitizeTitle("sk-abcdef")).toBeNull();
  });
});
