import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "HTMLElement", "Node", "MutationObserver", "customElements"]) globalThis[name] = dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const observers = new Set();
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; }
  observe(element) { this.element = element; observers.add(this); }
  disconnect() { observers.delete(this); }
};
const resize = async (width) => act(() => {
  for (const observer of observers) {
    observer.element.getBoundingClientRect = () => ({ width });
    observer.callback();
  }
});
const { fireEvent, act } = await import("@testing-library/react");
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

const summaries = [
  { number: 1, title: "Approved layer", state: "OPEN", reviewDecision: "APPROVED" },
  { number: 2, title: "Merged layer", state: "MERGED", reviewDecision: "APPROVED" },
  { number: 3, title: "Draft layer", state: "OPEN", isDraft: true, reviewDecision: "APPROVED" },
  { number: 4, title: "Open PR", state: "OPEN" },
  { number: 5, title: "Closed PR", state: "CLOSED", reviewDecision: "APPROVED" },
].map((item) => ({ id: item.number === 3 ? null : `review-${item.number}`, owner: "o", repo: "r", headSha: "head", additions: item.number * 10, deletions: item.number * 2, pendingCount: 0, updatedAt: 0, isDraft: false, reviewDecision: null, ...item, stack: item.number <= 3 ? { key: "gh:o/r#7", number: 7, position: item.number, size: 3 } : null }));

test("Recent uses one status per PR, only offers stack-level removal, and opens unopened layers", async () => {
  let removed = null; let opened = null;
  const previousConfirm = window.confirm;
  window.confirm = () => true;
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, { rpc: {
    reviews_list: () => ({ reviews: summaries }),
    stacks_remove: (input) => { removed = input; return { ok: true }; },
    reviews_open: (input) => { opened = input; return { review: { ...review, id: "opened-layer", number: 3 } }; },
  } });
  try {
    await slot.findAllByText("Approved layer");
    for (const label of ["Approved", "Merged", "Draft", "Open", "Closed"]) assert.equal(slot.getAllByRole("img", { name: label }).length, label === "Approved" ? 2 : 1);
    assert.ok(slot.getAllByRole("img", { name: "Approved" }).every((mark) => mark.className.includes("text-emerald-600")));
    assert.ok(slot.getByRole("img", { name: "Merged" }).className.includes("text-purple-600"));
    assert.ok(slot.getByLabelText("Diff: 60 additions, 12 deletions"));
    assert.ok(slot.getByLabelText("Diff: 10 additions, 2 deletions"));
    assert.ok(slot.getByLabelText("Diff: 40 additions, 8 deletions"));
    assert.equal(slot.getAllByRole("button", { name: "Remove stack reviews" }).length, 1);
    assert.equal(slot.getAllByRole("button", { name: "Remove review", exact: true }).length, 2);
    assert.equal(slot.queryByRole("button", { name: "Remove #1" }), null);
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: /Draft layer/ })); });
    assert.deepEqual(opened, { ref: "o/r#3" });
    assert.ok(slot.inspection.navigateCalls.some((call) => call.options?.subPath === "opened-layer"));
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Remove stack reviews" })); });
    assert.deepEqual(removed, { key: "gh:o/r#7" });
  } finally { slot.lifecycle.unmount(); window.confirm = previousConfirm; }
});

test("the PR header and stack navigation share status precedence and the menu removes the whole stack", async () => {
  HTMLElement.prototype.scrollIntoView = () => {};
  const entries = summaries.slice(0, 3).map((item) => ({ ...item, position: item.stack.position, merged: item.state === "MERGED", url: review.url, headRefName: "branch", baseRefName: "main", files: [], changedFiles: 0, reviewId: item.id, viewedCount: 0 }));
  const slot = renderSlot(app.navPanels[0], { subPath: "review" }, { rpc: {
    reviews_list: () => ({ reviews: summaries }),
    reviews_get: () => ({ ...detail, review: { ...review, reviewDecision: "APPROVED" }, stack: { number: 7, source: "github", baseRefName: "main", currentPosition: 1, entries } }),
    review_seen: () => ({ ok: true }),
  } });
  try {
    await slot.findByText("Approved");
    assert.ok(slot.getByRole("img", { name: "Approved" }));
    assert.ok(slot.getByRole("img", { name: "Merged" }));
    assert.ok(slot.getByRole("img", { name: "Draft" }));
    assert.ok(slot.getByRole("button", { name: "Remove stack" }));
    assert.equal(slot.queryByRole("button", { name: "Remove review", exact: true }), null);
  } finally { slot.lifecycle.unmount(); }
});

const stackDetail = () => ({ ...detail, stack: { number: 7, source: "github", baseRefName: "main", currentPosition: 1, entries: summaries.slice(0, 3).map((item) => ({ ...item, position: item.stack.position, merged: item.state === "MERGED", url: review.url, headRefName: "branch", baseRefName: "main", files: [], changedFiles: 0, reviewId: item.id, viewedCount: 0 })) } });
const mountReview = (data) => renderSlot(app.navPanels[0], { subPath: "review" }, { rpc: {
  reviews_list: () => ({ reviews: [] }), reviews_get: () => data, review_seen: () => ({ ok: true }),
  review_patch: () => ({ patch: "", file: data.files[0] ?? null }),
} });

test("sidebars auto-hide on small screens, preserve explicit choices through resize and remount, and need no dropdowns", async () => {
  window.localStorage.clear();
  HTMLElement.prototype.scrollIntoView = () => {};
  const previousWidth = window.innerWidth;
  window.innerWidth = 1200;
  let slot = mountReview(stackDetail());
  try {
    await slot.findByRole("complementary", { name: "Pull request stack" });
    assert.ok(slot.getByRole("complementary", { name: "Changed files" }));
    await resize(500);
    assert.equal(slot.queryByRole("complementary", { name: "Changed files" }), null);
    assert.equal(slot.queryByRole("complementary", { name: "Pull request stack" }), null);
    assert.equal(slot.queryByLabelText("Changed file"), null);
    assert.equal(slot.queryByLabelText("Pull request in stack"), null);
    fireEvent.click(slot.getByRole("button", { name: "Show file list" }));
    fireEvent.click(slot.getByRole("button", { name: "Show stack sidebar" }));
    await resize(1200); await resize(500);
    assert.ok(slot.getByRole("complementary", { name: "Changed files" }));
    assert.ok(slot.getByRole("complementary", { name: "Pull request stack" }));
    assert.equal(JSON.parse(window.localStorage.getItem("review-desk:file-tree")), true);
    assert.equal(JSON.parse(window.localStorage.getItem("review-desk:stack-sidebar")), true);
    fireEvent.click(slot.getByRole("button", { name: "Hide file list" }));
    await resize(1200);
    assert.equal(slot.queryByRole("complementary", { name: "Changed files" }), null);
    slot.lifecycle.unmount(); window.innerWidth = 500;
    slot = mountReview(stackDetail());
    await slot.findByRole("complementary", { name: "Pull request stack" });
    assert.equal(slot.queryByRole("complementary", { name: "Changed files" }), null);
    assert.ok(slot.getByLabelText("Diff: 60 additions, 12 deletions"));
    fireEvent.click(slot.getAllByRole("button", { name: "Hide stack sidebar" })[0]);
    assert.equal(slot.queryByRole("complementary", { name: "Pull request stack" }), null);
  } finally { slot.lifecycle.unmount(); window.innerWidth = previousWidth; window.localStorage.clear(); }
});

test("moved files appear at both explorer locations and selecting either keeps the sidebar open", async () => {
  window.localStorage.clear(); window.localStorage.setItem("review-desk:file-tree", "true");
  const previousWidth = window.innerWidth; window.innerWidth = 500;
  const moved = { path: "new/beta.ts", oldPath: "old/alpha.ts", status: "renamed", additions: 0, deletions: 0, binary: false, viewed: false, threadCount: 0, unresolvedCount: 0, pendingCount: 0 };
  const slot = mountReview({ ...detail, files: [moved, { ...moved, path: "added.ts", oldPath: null, status: "added" }, { ...moved, path: "deleted.ts", oldPath: null, status: "deleted" }] });
  try {
    await slot.findByRole("complementary", { name: "Changed files" });
    const old = await slot.findByRole("button", { name: /alpha.ts.*Deleted/ });
    const current = slot.getByRole("button", { name: /beta.ts.*Added/ });
    assert.equal(old.title, "old/alpha.ts → new/beta.ts");
    assert.equal(current.title, old.title);
    for (const row of [old, slot.getByRole("button", { name: /deleted.ts.*Deleted/ })]) {
      const marker = row.querySelector("[aria-label=Deleted]");
      assert.equal(marker.textContent, "D");
      assert.ok(marker.className.includes("text-red-600"));
    }
    for (const row of [current, slot.getByRole("button", { name: /added.ts.*Added/ })]) {
      const marker = row.querySelector("[aria-label=Added]");
      assert.equal(marker.textContent, "U");
      assert.ok(marker.className.includes("text-emerald-600"));
    }
    fireEvent.click(old);
    assert.ok(slot.getByRole("complementary", { name: "Changed files" }));
    fireEvent.click(current);
    assert.ok(slot.getByRole("complementary", { name: "Changed files" }));
    assert.equal(slot.queryByText("Renamed from old/alpha.ts"), null);
    const patches = slot.inspection.rpcCalls.filter((call) => call.method === "review_patch");
    assert.ok(patches.length > 0);
    assert.ok(patches.every((call) => call.input.path === "new/beta.ts"));
    fireEvent.change(slot.getByRole("textbox", { name: "Filter files" }), { target: { value: "old/alpha" } });
    assert.ok(slot.getByRole("button", { name: /alpha.ts.*Deleted/ }));
    assert.equal(slot.queryByRole("button", { name: /beta.ts.*Added/ }), null);
  } finally { slot.lifecycle.unmount(); window.innerWidth = previousWidth; window.localStorage.clear(); }
});

test("Recent refreshes on focus, reconnect and visible polling without accepting older responses", async () => {
  const previousInterval = window.setInterval;
  const previousClear = window.clearInterval;
  const timers = new Map();
  let nextTimer = 0;
  window.setInterval = (callback, delay) => { assert.equal(delay, 15_000); timers.set(++nextTimer, callback); return nextTimer; };
  window.clearInterval = (id) => timers.delete(id);
  let current = summaries;
  let deferred = null;
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, { rpc: {
    reviews_list: () => deferred ?? { reviews: current },
  } });
  try {
    await slot.findAllByText("Approved layer");
    let release;
    deferred = new Promise((resolve) => { release = resolve; });
    await act(async () => { window.dispatchEvent(new window.Event("focus")); });
    deferred = null;
    current = [{ ...summaries[0], title: "New PR title", additions: 99, stack: null }];
    await act(async () => { window.dispatchEvent(new window.Event("focus")); });
    await slot.findByText("New PR title");
    await act(async () => { release({ reviews: summaries }); });
    assert.equal(slot.queryByText("Approved layer"), null);
    assert.ok(slot.getByLabelText("Diff: 99 additions, 2 deletions"));
    current = [{ ...current[0], title: "Reconnected PR" }];
    await act(async () => {
      await slot.behavior.setRealtimeConnectionState("reconnecting");
      await slot.behavior.setRealtimeConnectionState("connected");
    });
    await slot.findByText("Reconnected PR");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    current = [{ ...current[0], title: "Polled PR" }];
    await act(async () => { for (const callback of timers.values()) callback(); });
    await slot.findByText("Polled PR");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    current = [{ ...current[0], title: "Hidden PR" }];
    await act(async () => { for (const callback of timers.values()) callback(); });
    assert.equal(slot.queryByText("Hidden PR"), null);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
    await slot.findByText("Hidden PR");
  } finally {
    slot.lifecycle.unmount();
    assert.equal(timers.size, 0);
    window.setInterval = previousInterval; window.clearInterval = previousClear;
    delete document.visibilityState;
  }
});

test("returning to a PR refreshes counts and reloads its patch after head or base changes", async () => {
  const file = { path: "a.ts", oldPath: null, status: "modified", additions: 1, deletions: 0, binary: false, viewed: false, threadCount: 0, unresolvedCount: 0, pendingCount: 0 };
  let current = { ...detail, threads: [], review: { ...review, additions: 1 }, files: [file] };
  let patches = 0;
  const slot = renderSlot(app.navPanels[0], { subPath: "review" }, { rpc: {
    reviews_list: () => ({ reviews: [] }), reviews_get: () => current, review_seen: () => ({ ok: true }),
    review_patch: () => { patches++; return { patch: "", file }; },
  } });
  try {
    await slot.findAllByLabelText("Diff: 1 additions, 0 deletions");
    const before = patches;
    current = { ...current, review: { ...current.review, headSha: "new-head", additions: 8 }, files: [{ ...file, additions: 8 }] };
    await act(async () => { window.dispatchEvent(new window.Event("focus")); });
    await slot.findAllByLabelText("Diff: 8 additions, 0 deletions");
    assert.equal(patches, before + 1);
    current = { ...current, review: { ...current.review, baseSha: "new-base", additions: 3 }, files: [{ ...file, additions: 3 }] };
    await act(async () => { window.dispatchEvent(new window.Event("focus")); });
    await slot.findAllByLabelText("Diff: 3 additions, 0 deletions");
    assert.equal(patches, before + 2);
  } finally { slot.lifecycle.unmount(); }
});
