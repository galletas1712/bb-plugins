import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const name of ["window", "document", "HTMLElement", "Element", "Node", "DOMRect", "MutationObserver", "customElements", "localStorage"]) globalThis[name] = dom.window[name];
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const observers = new Set();
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; }
  observe(element) { this.element = element; observers.add(this); }
  disconnect() { observers.delete(this); }
};
window.ResizeObserver = globalThis.ResizeObserver;
const resize = async (width) => act(() => {
  for (const observer of observers) {
    observer.element.getBoundingClientRect = () => ({ width });
    observer.callback([{ target: observer.element, contentRect: { width, height: 600 }, borderBoxSize: [{ inlineSize: width, blockSize: 600 }] }]);
  }
});
const { fireEvent, act } = await import("@testing-library/react");
const { loadPluginApp, renderSlot: sdkRenderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const mergeOptions = { methods: ["squash"], reason: null, headSha: "head", baseRefName: "main", prs: [{ number: 1, headSha: "head" }] };
const renderSlot = (slot, props, options) => sdkRenderSlot(slot, props, { ...options, rpc: { review_merge_options: () => mergeOptions, ...options?.rpc } });
const app = await loadPluginApp(() => import("../app.tsx"));

const comment = (id, author, body, replyToId = null) => ({ id, author, body, replyToId, databaseId: 1, createdAt: "2026-10-05T00:00:00Z", url: null, canEdit: author === "me" });
const thread = (id, comments, isResolved = false) => ({ id, comments, isResolved, isOutdated: false, path: "file.ts", line: 1, originalLine: 1, startLine: null, originalStartLine: null, startSide: null, subjectType: "LINE", side: "RIGHT" });
const review = { id: "review", owner: "o", repo: "r", number: 1, title: "Review", body: "Description", state: "OPEN", isDraft: false, url: "https://github.com/o/r/pull/1", author: "me", baseRefName: "main", headRefName: "branch", headSha: "head", baseSha: "base", additions: 0, deletions: 0, changedFiles: 0, reviewDecision: null, mergeable: null, labels: [], checks: [], reviewers: [], assignees: [], commits: [], createdAt: "2026-10-05T00:00:00Z", worktree: "/repo", environmentId: null, hostId: "host", syncedAt: 0, ghUpdatedAt: "2026-10-05T00:00:00Z" };
const detail = { review, files: [], pending: [], notes: [], seen: { prevHead: null, seenHead: null }, stack: null, syncError: null, threads: [thread("active", [comment("reply", "me", "Reply body", "original"), comment("original", "other", "Original body")]), thread("resolved", [comment("hidden", "other", "Resolved body")], true)] };

test("compact Markdown toolbar offers three icon modes, keeps source coordinates, and restores the wide view", async () => {
  window.localStorage.clear();
  const file = { path: "readme.md", oldPath: null, status: "modified", additions: 1, deletions: 1, binary: false, viewed: false, threadCount: 0, unresolvedCount: 0, pendingCount: 0 };
  const slot = renderSlot(app.navPanels[0], { subPath: "review" }, { rpc: {
    reviews_list: () => ({ reviews: [] }), reviews_get: () => ({ ...detail, files: [file], threads: [] }), review_seen: () => ({ ok: true }),
    review_patch: () => ({ patch: "", file }),
    commit_file: ({ sha }) => ({ content: sha === "base" ? "# Before\n\nOld paragraph.\n" : "# After\n\nNew paragraph.\n", binary: false }),
  } });
  try {
    await slot.findByRole("group", { name: "Markdown diff view" });
    await slot.findByText("No textual diff.");
    const header = slot.getByRole("heading", { level: 1 }).closest("header");
    assert.equal(header.querySelectorAll('a[href="https://github.com/o/r/pull/1"]').length, 1);
    assert.ok(header.querySelector('[aria-label="Merge pull request"]'));
    assert.equal(slot.queryByRole("combobox", { name: "Diff style" }), null);
    assert.equal(slot.queryByRole("button", { name: "Synchronize scrolling" }), null);
    assert.equal(slot.queryByRole("button", { name: "Display settings" }), null);
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Rendered diff", exact: true })); });
    await slot.findAllByLabelText("Added content");
    assert.equal(slot.queryByText("+ Added"), null);
    assert.equal(slot.queryByText("− Removed"), null);
    assert.equal(slot.queryByText("Unchanged"), null);
    const old = slot.getByRole("button", { name: "Open old source lines 1 to 1" });
    assert.equal(old.parentElement.dataset.sourceSide, "deletions");
    assert.equal(old.parentElement.dataset.sourceStart, "1");
    await act(async () => { fireEvent.click(old); });
    assert.equal(slot.getByRole("button", { name: "Source diff", exact: true }).getAttribute("aria-pressed"), "true");
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Source and rendered", exact: true })); });
    assert.ok(slot.getByRole("separator", { name: "Resize source and rendered panes" }));
    await resize(420);
    assert.equal(slot.getByRole("button", { name: "Source diff", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(slot.getByRole("button", { name: "Source and rendered", exact: true }).disabled, true);
    await resize(1200);
    assert.equal(slot.getByRole("button", { name: "Source and rendered", exact: true }).getAttribute("aria-pressed"), "true");
    assert.ok(slot.getByRole("separator", { name: "Resize source and rendered panes" }));
  } finally { slot.lifecycle.unmount(); window.localStorage.clear(); }
});

test("squash-only repositories name the action and require confirmation before merging the reviewed head", async () => {
  let merged = null;
  const slot = renderSlot(app.navPanels[0], { subPath: "review" }, { rpc: {
    reviews_list: () => ({ reviews: [] }), reviews_get: () => detail, review_seen: () => ({ ok: true }),
    review_merge: (input) => { merged = input; return { status: "merged", requestId: null, message: "Merged" }; },
  } });
  try {
    const button = await slot.findByRole("button", { name: "Squash and merge", exact: true });
    assert.equal(button.disabled, false);
    assert.equal(slot.queryByRole("combobox", { name: "Merge method" }), null);
    await act(async () => { fireEvent.click(button); });
    assert.equal(merged, null);
    assert.ok(slot.getByRole("region", { name: "Confirm merge" }).textContent.includes("#1 into main"));
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Confirm squash and merge" })); });
    assert.deepEqual(merged, { reviewId: "review", method: "squash", expected: { headSha: "head", baseRefName: "main", prs: [{ number: 1, headSha: "head" }] } });
    assert.equal(slot.inspection.navigateCalls.length, 1);
    assert.equal(slot.inspection.navigateCalls[0].options?.subPath, undefined);
  } finally { slot.lifecycle.unmount(); }
});

test("merge method selection and confirmation show every native downstack PR affected", async () => {
  let merges = 0;
  const slot = renderSlot(app.navPanels[0], { subPath: "review" }, { rpc: {
    reviews_list: () => ({ reviews: [] }), reviews_get: () => detail, review_seen: () => ({ ok: true }),
    review_merge_options: () => ({ ...mergeOptions, methods: ["merge", "squash", "rebase"], prs: [{ number: 2, headSha: "h2" }, { number: 1, headSha: "head" }] }),
    review_merge: () => { merges++; throw new Error("GitHub branch rules rejected this merge"); },
  } });
  try {
    fireEvent.change(await slot.findByRole("combobox", { name: "Merge method" }), { target: { value: "rebase" } });
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Rebase and merge 2 PRs" })); });
    const panel = slot.getByRole("region", { name: "Confirm merge" });
    assert.ok(panel.textContent.includes("#2, #1 into main"));
    assert.ok(panel.textContent.includes("2 open PRs"));
    fireEvent.click(slot.getByRole("button", { name: "Cancel", exact: true }));
    assert.equal(merges, 0);
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Rebase and merge 2 PRs" })); });
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Confirm rebase and merge" })); });
    assert.ok(slot.getByRole("alert").textContent.includes("branch rules rejected"));
    assert.equal(slot.inspection.navigateCalls.length, 0);
    assert.equal(merges, 1);
  } finally { slot.lifecycle.unmount(); }
});

test("merge stays disabled for blockers or a head that has not been reviewed", async () => {
  for (const options of [{ ...mergeOptions, reason: "Mark draft pull requests ready before merging." }, { ...mergeOptions, headSha: "new-head" }]) {
    const slot = renderSlot(app.navPanels[0], { subPath: "review" }, { rpc: {
      reviews_list: () => ({ reviews: [] }), reviews_get: () => detail, review_seen: () => ({ ok: true }), review_merge_options: () => options,
    } });
    try {
      assert.equal((await slot.findByRole("button", { name: "Squash and merge", exact: true })).disabled, true);
      assert.ok(slot.getByRole("button", { name: "Squash and merge", exact: true }).title.includes(options.reason ?? "Refresh the PR to review its latest changes before merging."));
      assert.equal(slot.queryByText("Refresh merge options"), null);
    } finally { slot.lifecycle.unmount(); }
  }
});

test("async merges stay pending until GitHub reports success or a failure", async () => {
  const requestId = "630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42";
  const slot = renderSlot(app.navPanels[0], { subPath: "review" }, { rpc: {
    reviews_list: () => ({ reviews: [] }), reviews_get: () => detail, review_seen: () => ({ ok: true }),
    review_merge: () => ({ status: "pending", requestId, message: "Merge request enqueued." }),
    review_merge_result: (input) => { assert.deepEqual(input, { reviewId: "review", requestId }); return { status: "failed", requestId: null, message: "Required checks failed." }; },
  } });
  try {
    const button = await slot.findByRole("button", { name: "Squash and merge", exact: true });
    await act(async () => { fireEvent.click(button); });
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Confirm squash and merge" })); });
    assert.equal(slot.getByRole("button", { name: "Merging…" }).disabled, true);
    assert.equal(slot.inspection.navigateCalls.length, 0);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1700)); });
    assert.ok(slot.getByRole("alert").textContent.includes("Required checks failed."));
    assert.equal(slot.inspection.navigateCalls.length, 0);
  } finally { slot.lifecycle.unmount(); }
});

test("empty and HTML-comment-only review summaries are activity rows while real comments keep their disclosures", async () => {
  const states = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"];
  const slot = renderSlot(app.navPanels[0], { subPath: "review" }, { rpc: {
    reviews_list: () => ({ reviews: [] }), reviews_get: () => detail, review_seen: () => ({ ok: true }), review_description: () => ({ body: review.body, canEdit: false }),
    review_conversation: () => ({ comments: [], reviews: [
      ...states.map((state, index) => ({ id: index, nodeId: `empty-${index}`, state, body: index % 2 ? "<!-- metadata -->\n " : " ", author: `reviewer-${index}`, submittedAt: review.createdAt, canEdit: false, url: review.url })),
      { id: 5, nodeId: "with-text", state: "COMMENTED", body: "Real summary", author: "summary-author", submittedAt: review.createdAt, canEdit: true, url: review.url },
    ], events: [], fetchedAt: 0 }),
  } });
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Conversation", exact: true }));
    await slot.findByText("Real summary");
    for (const text of ["approved these changes", "requested changes", "reviewed", "had their review dismissed"]) assert.equal(slot.getByText(text).closest("details"), null);
    assert.ok(slot.getByText("Real summary").closest("details"));
    assert.equal(slot.queryByText("No message."), null);
    assert.ok(slot.getByRole("button", { name: "Edit comment by summary-author" }));
  } finally { slot.lifecycle.unmount(); }
});

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
    assert.equal(slot.queryByText("No message."), null);
    assert.equal(slot.getByText("approved these changes").closest("details"), null);
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
    await slot.findAllByRole("img", { name: "Approved" });
    assert.equal(slot.getAllByRole("img", { name: "Approved" }).length, 2);
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

test("unopened authored PRs can be opened or removed and discovery errors leave cached reviews visible", async () => {
  const own = { ...summaries[3], id: null, title: "Authored draft", isDraft: true };
  let removed = null; let opened = null;
  const previousConfirm = window.confirm; window.confirm = () => true;
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, { rpc: {
    reviews_list: () => ({ reviews: [own], discoveryError: "GitHub temporarily unavailable" }),
    reviews_open: (input) => { opened = input; return { review }; },
    reviews_remove: (input) => { removed = input; return { ok: true }; },
  } });
  try {
    await slot.findByText("Authored draft");
    assert.ok(slot.getByText("GitHub temporarily unavailable"));
    assert.ok(slot.getByRole("img", { name: "Draft" }));
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: /Authored draft/ })); });
    assert.deepEqual(opened, { ref: "o/r#4" });
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Remove review", exact: true })); });
    assert.deepEqual(removed, { owner: "o", repo: "r", number: 4 });
  } finally { slot.lifecycle.unmount(); window.confirm = previousConfirm; }
});

test("repository groups sort by latest PR activity and nest stacks independently of standalone PRs", async () => {
  const base = summaries[3];
  let reviews = [
    { ...base, owner: "same", repo: "shared", number: 10, title: "Older standalone", updatedAt: 100 },
    { ...summaries[0], owner: "same", repo: "shared", title: "Stack bottom", updatedAt: 150, stack: { key: "gh:same/shared#7", number: 7, position: 1, size: 2 } },
    { ...summaries[2], owner: "same", repo: "shared", title: "Stack top", updatedAt: 300, stack: { key: "gh:same/shared#7", number: 7, position: 2, size: 2 } },
    { ...base, owner: "other", repo: "shared", number: 11, title: "Other owner's PR", updatedAt: 200 },
  ];
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, { rpc: { reviews_list: () => ({ reviews }) } });
  try {
    await slot.findByRole("heading", { name: "same/shared" });
    assert.deepEqual(slot.getAllByRole("heading", { level: 2 }).map((el) => el.textContent), ["same/shared", "other/shared"]);
    const repo = slot.getByLabelText("Repository same/shared");
    const stack = slot.getByLabelText("Stack 7 in same/shared");
    assert.equal(repo.open, true);
    assert.equal(stack.open, false);
    assert.equal(stack.closest("ul").parentElement, repo);
    assert.equal(slot.getByText("Older standalone").closest("details"), repo);
    assert.equal(slot.getByText("Stack bottom").closest("details"), stack);
    assert.ok(stack.compareDocumentPosition(slot.getByText("Older standalone")) & Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(slot.getAllByLabelText("Diff: 40 additions, 8 deletions").length > 0);
    fireEvent.click(stack.querySelector("summary"));
    assert.equal(stack.open, true);
    const layers = [...stack.querySelectorAll("ul button")];
    assert.ok(layers[0].textContent.includes("Stack bottom"));
    assert.ok(layers[1].textContent.includes("Stack top"));
    assert.equal(stack.parentElement.querySelectorAll('button[aria-label="Remove stack reviews"]').length, 1);
    assert.equal(stack.querySelector('button[aria-label^="Remove"]'), null);
    fireEvent.click(repo.querySelector("summary"));
    assert.equal(repo.open, false);
    assert.equal(slot.getByLabelText("Repository other/shared").open, true);
    reviews = reviews.map((pr) => pr.owner === "other" ? { ...pr, updatedAt: 400 } : pr);
    await act(async () => { window.dispatchEvent(new window.Event("focus")); });
    assert.deepEqual(slot.getAllByRole("heading", { level: 2 }).map((el) => el.textContent), ["other/shared", "same/shared"]);
    assert.equal(slot.getByLabelText("Repository same/shared"), repo);
    assert.equal(repo.open, false);
    assert.equal(stack.open, true);
  } finally { slot.lifecycle.unmount(); }
});
