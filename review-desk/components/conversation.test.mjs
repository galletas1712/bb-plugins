import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "HTMLElement", "Node", "MutationObserver", "customElements"]) globalThis[name] = dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
const { fireEvent } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const app = await loadPluginApp(() => import("../app.tsx"));

const comment = (id, author, body, replyToId = null) => ({ id, author, body, replyToId, databaseId: 1, createdAt: "2026-10-05T00:00:00Z", url: null, canEdit: author === "me" });
const thread = (id, comments, isResolved = false) => ({ id, comments, isResolved, isOutdated: false, path: "file.ts", line: 1, originalLine: 1, startLine: null, originalStartLine: null, startSide: null, subjectType: "LINE", side: "RIGHT" });
const review = { id: "review", owner: "o", repo: "r", number: 1, title: "Review", body: "Description", state: "OPEN", isDraft: false, url: "https://github.com/o/r/pull/1", author: "me", baseRefName: "main", headRefName: "branch", headSha: "head", baseSha: "base", additions: 0, deletions: 0, changedFiles: 0, reviewDecision: null, mergeable: null, labels: [], checks: [], reviewers: [], assignees: [], commits: [], createdAt: "2026-10-05T00:00:00Z", worktree: "/repo", environmentId: null, hostId: "host", syncedAt: 0, ghUpdatedAt: "2026-10-05T00:00:00Z" };
const detail = { review, files: [], pending: [], notes: [], seen: { prevHead: null, seenHead: null }, stack: null, syncError: null, threads: [thread("active", [comment("reply", "me", "Reply body", "original"), comment("original", "other", "Original body")]), thread("resolved", [comment("hidden", "other", "Resolved body")], true)] };

test("conversation shows each comment, independently toggles bodies, and keeps replies under their original", async () => {
  const slot = renderSlot(app.navPanels[0], { subPath: "review" }, { rpc: {
    reviews_list: () => ({ reviews: [] }),
    reviews_get: () => detail,
    review_seen: () => ({ ok: true }),
    review_description: () => ({ body: review.body, canEdit: true }),
    review_conversation: () => ({ comments: [{ id: 1, nodeId: "issue", canEdit: false, author: "other", body: "Discussion body", createdAt: "2026-10-05T00:00:00Z", url: review.url }], reviews: [{ id: 2, nodeId: "summary", canEdit: false, author: "reviewer", state: "APPROVED", body: "", submittedAt: "2026-10-05T00:00:00Z", url: review.url }], events: [], fetchedAt: 0 }),
  } });
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Conversation" }));
    const discussion = await slot.findByText("Discussion body");
    const original = await slot.findByText("Original body");
    const reply = await slot.findByText("Reply body");
    assert.ok(original.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(reply.closest(".border-l-2"));
    assert.equal(slot.queryByRole("button", { name: "Edit comment by other" }), null);
    assert.ok(slot.getByRole("button", { name: "Edit comment by me" }));
    assert.ok(slot.getByText("No message."));
    assert.equal(slot.queryByText("Resolved body"), null);
    const resolved = slot.getByText("Resolved threads (1)").closest("details");
    assert.equal(resolved.open, false);
    fireEvent.click(resolved.querySelector("summary"));
    assert.equal(slot.queryByText("Resolved body"), null);
    fireEvent.click(resolved.querySelector("button[aria-expanded]"));
    assert.ok(slot.getByText("Resolved body"));
    const dropdown = discussion.closest("details");
    fireEvent.click(dropdown.querySelector("summary"));
    assert.equal(dropdown.open, false);
    assert.equal(original.closest("details").open, true);
    assert.equal(reply.closest("details").open, true);
    fireEvent.click(dropdown.querySelector("summary"));
    assert.equal(dropdown.open, true);
    assert.ok(slot.getByText("Discussion body"));
  } finally { slot.lifecycle.unmount(); }
});
