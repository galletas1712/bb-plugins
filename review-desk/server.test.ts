import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { type ReviewSummary } from "./server";
import type { ChangedFile, GhPr, PrStack, OwnPrs } from "./host-contract";
import type { MergeResult } from "./merge-contract";

const pr = (number: number): GhPr => ({ number, title: `PR ${number}`, body: "Body", state: "OPEN", isDraft: false, url: `https://github.com/o/r/pull/${number}`, author: { login: "me" }, baseRefName: "main", headRefName: `branch-${number}`, headRefOid: `head-${number}`, baseRefOid: "base", additions: 0, deletions: 0, changedFiles: 0, reviewDecision: null, mergeable: null, updatedAt: "2026-10-06T00:00:00Z", createdAt: "2026-10-05T00:00:00Z", checks: [], labels: [], reviewers: [], assignees: [], commits: [] });
const stack = (numbers: number[]): PrStack => ({ number: 7, baseRefName: "main", source: "github", entries: numbers.map((number, i) => ({ position: i + 1, number, title: `PR ${number}`, state: "OPEN", isDraft: false, merged: false, url: pr(number).url, additions: 0, deletions: 0, changedFiles: 0, reviewDecision: null, headRefName: `branch-${number}`, headSha: `head-${number}`, baseRefName: "main", files: [] })) });

async function fixture() {
  let files: ChangedFile[] = [];
  const remotePrs = new Map<number, Partial<GhPr>>();
  let snapshot: PrStack | null = stack([1, 2, 3]);
  let onStack: (() => Promise<void> | void) | undefined;
  let onDetails: (() => Promise<void> | void) | undefined;
  let onStatus: (() => Promise<void> | void) | undefined;
  let onBatch: (() => Promise<void> | void) | undefined;
  let batchError: string | null = null;
  let onPrepare: ((number: number) => Promise<void> | void) | undefined;
  let onThreads: (() => Promise<void> | void) | undefined;
  let onConversation: (() => void) | undefined;
  let onRead: ((method: string, input: any) => Promise<unknown> | undefined) | undefined;
  let mergeResult: MergeResult = { status: "pending", requestId: "630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42", message: "Processing" };
  let own: OwnPrs = { login: "viewer", prs: [] };
  let ownError: string | null = null;
  let onOwn: (() => void) | undefined;
  const calls: { method: string; input: any }[] = [];
  let { bb, harness } = createFakePluginHost({ pluginId: "review-desk", sdk: { projects: { list: async () => [] }, hosts: { list: async () => [makeHostResponse({ id: "host", status: "connected" })] } }, experimental_callHostRpc: async ({ method, input }) => {
    const args = input as any;
    calls.push({ method, input });
    const override = onRead?.(method, args);
    if (override !== undefined) return await override;
    switch (method) {
      case "gh_merge_options": return { methods: ["squash"], defaultMethod: "squash", reason: null, headSha: `head-${args.number}`, baseRefName: "main", prs: [{ number: args.number, headSha: `head-${args.number}` }] };
      case "gh_description": return { body: remotePrs.get(args.number)?.body ?? "Body", canEdit: true };
      case "gh_merge": case "gh_merge_result": return mergeResult;
      case "gh_own_prs": onOwn?.(); if (ownError) throw new Error(ownError); return own;
      case "gh_pr_statuses": {
        const prs = args.prs.map((ref: { owner: string; repo: string; number: number }) => ({ ...pr(ref.number), ...remotePrs.get(ref.number), owner: ref.owner, repo: ref.repo }));
        await onBatch?.();
        if (batchError) throw new Error(batchError);
        return { prs };
      }
      case "gh_pr": case "gh_pr_status": {
        const result = { ...pr(args.number), ...remotePrs.get(args.number) };
        if (method === "gh_pr_status") await onStatus?.();
        return result;
      }
      case "gh_pr_details": await onDetails?.(); return { commits: [], labels: [], checks: [], reviewers: [], assignees: [] };
      case "repo_clone": return { repoPath: "/repo" };
      case "repo_prepare": await onPrepare?.(args.number); return { worktree: `/repo/${args.number}`, headSha: args.headSha, baseSha: remotePrs.get(args.number)?.baseRefOid ?? "base" };
      case "repo_release": return { ok: true };
      case "git_files": return { files };
      case "git_patch": return { patch: `patch ${args.baseSha}..${args.headSha}:${args.path}` };
      case "git_show": return { content: `${args.sha}:${args.path}`, binary: false };
      case "gh_threads": await onThreads?.(); return { threads: [] };
      case "gh_conversation": onConversation?.(); return { comments: [], reviews: [], events: [] };
      case "gh_stack": await onStack?.(); return { stack: args.stackNumber !== null || snapshot?.entries.some((entry) => entry.number === args.number) ? snapshot : null };
      default: throw new Error(`unexpected host call ${method}`);
    }
  } });
  await plugin(bb);
  const rpc = (method: string, input: unknown) => harness.behavior.callRpc(method, input);
  const open = async (number: number) => (await rpc("reviews_open", { ref: `o/r#${number}` }) as any).review;
  const list = async () => (await rpc("reviews_list", null) as { reviews: ReviewSummary[] }).reviews;
  return { get bb() { return bb; }, get harness() { return harness; }, reload: async () => { ({ bb, harness } = await harness.lifecycle.reload(plugin)); }, rpc, open, list, calls, onRead: (fn: typeof onRead) => { onRead = fn; }, setMergeResult: (result: MergeResult) => { mergeResult = result; }, setPr: (number: number, values: Partial<GhPr>) => remotePrs.set(number, values), setFiles: (next: ChangedFile[]) => { files = next; }, setStack: (next: PrStack | null) => { snapshot = next; }, onStack: (fn: typeof onStack) => { onStack = fn; }, onDetails: (fn: typeof onDetails) => { onDetails = fn; }, onStatus: (fn: typeof onStatus) => { onStatus = fn; }, setOwn: (next: OwnPrs) => { own = next; }, setOwnError: (error: string | null) => { ownError = error; }, onOwn: (fn: typeof onOwn) => { onOwn = fn; }, onBatch: (fn: typeof onBatch) => { onBatch = fn; }, setBatchError: (error: string | null) => { batchError = error; }, onPrepare: (fn: typeof onPrepare) => { onPrepare = fn; }, onThreads: (fn: typeof onThreads) => { onThreads = fn; }, onConversation: (fn: typeof onConversation) => { onConversation = fn; } };
}

test("merge RPCs use the saved PR identity and only hide a review after confirmed GitHub success", async () => {
  const f = await fixture();
  try {
    const review = await f.open(1);
    await f.rpc("pending_add", { reviewId: review.id, path: "a.ts", line: 1, side: "RIGHT", body: "Retain this draft" });
    const options = await f.rpc("review_merge_options", { reviewId: review.id }) as any;
    const input = { reviewId: review.id, method: "squash", expected: { headSha: options.headSha, baseRefName: options.baseRefName, prs: options.prs } };
    const pending = await f.rpc("review_merge", input) as MergeResult;
    assert.equal(pending.status, "pending");
    assert.ok((await f.list()).some((pr) => pr.number === 1));
    assert.deepEqual(f.calls.find((call) => call.method === "gh_merge")?.input, { owner: "o", repo: "r", number: 1, method: "squash", expected: input.expected });
    f.setMergeResult({ status: "failed", requestId: null, message: "Required reviews missing" });
    assert.equal((await f.rpc("review_merge_result", { reviewId: review.id, requestId: pending.requestId }) as MergeResult).status, "failed");
    assert.ok((await f.list()).some((pr) => pr.number === 1));
    f.setMergeResult({ status: "merged", requestId: null, message: "Merged" });
    await f.rpc("review_merge_result", { reviewId: review.id, requestId: pending.requestId });
    assert.equal((await f.list()).some((pr) => pr.number === 1), false);
    assert.equal(f.bb.storage.database().prepare<[string], { state: string }>("SELECT state FROM reviews WHERE id = ?").get(review.id)?.state, "MERGED");
    assert.equal(f.bb.storage.database().prepare<[string], { n: number }>("SELECT count(*) AS n FROM pending WHERE review_id = ?").get(review.id)?.n, 1);
    // Even stale OPEN metadata, including scans after reload, cannot undo a merge.
    await f.reload();
    const service = f.harness.behavior.runService("scan-pr-status");
    f.onBatch(() => service.controller.abort());
    await service.done;
    assert.equal((await f.list()).some((pr) => pr.number === 1), false);
    await assert.rejects(f.rpc("review_merge", { ...input, reviewId: "missing" }), /not found/);
    await assert.rejects(f.rpc("review_merge", { ...input, method: "admin" }));
  } finally { await f.harness.lifecycle.dispose(); }
});

test("cached merge actions survive reload, return while GitHub is slow, and refresh before confirmation", async () => {
  const f = await fixture(); const now = Date.now; let clock = now(); Date.now = () => clock;
  let release!: (value: unknown) => void;
  try {
    f.setStack(null);
    const review = await f.open(1);
    const original = await f.rpc("review_merge_options", { reviewId: review.id }) as any;
    await f.rpc("review_description", { reviewId: review.id });
    await f.reload();
    const calls = () => f.calls.filter((call) => call.method === "gh_merge_options").length;
    const before = calls();
    assert.deepEqual(await f.rpc("review_merge_options", { reviewId: review.id }), original);
    assert.equal(calls(), before);
    clock += 16_000;
    f.onRead((method) => method === "gh_merge_options" ? new Promise((resolve) => { release = resolve; }) : undefined);
    assert.deepEqual(await f.rpc("review_merge_options", { reviewId: review.id }), original);
    assert.deepEqual(await f.rpc("review_merge_options", { reviewId: review.id }), original);
    assert.equal(calls(), before + 1, "share one refresh across cached readers");
    let settled = false;
    const fresh = f.rpc("review_merge_options", { reviewId: review.id, refresh: true }).then((value) => { settled = true; return value; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "confirmation must wait for fresh GitHub options");
    const next = { ...original, reason: "Mark draft pull requests ready before merging." };
    release(next);
    assert.deepEqual(await fresh, next);
    clock += 16_000;
    f.onRead((method) => method === "gh_merge_options" ? Promise.reject(new Error("GitHub unavailable")) : undefined);
    assert.deepEqual(await f.rpc("review_merge_options", { reviewId: review.id }), next);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await f.rpc("review_merge_options", { reviewId: review.id }), next, "failed refresh retains last good data");
  } finally { release?.(null); Date.now = now; await f.harness.lifecycle.dispose(); }
});

test("patches use immutable revisions, hydrate the selected file, persist, and disappear with a removed review", async () => {
  const f = await fixture();
  let release!: (value: unknown) => void;
  try {
    f.setStack(null); f.setFiles([{ path: "a.md", oldPath: null, status: "modified", additions: 1, deletions: 1, binary: false }]);
    const review = await f.open(1);
    const input = { reviewId: review.id, path: "a.md", revision: { base: "base", head: "head-1", oldPath: null } };
    const first = await f.rpc("review_patch", input) as any;
    await f.reload();
    const calls = () => f.calls.filter((call) => call.method === "git_patch").length;
    const before = calls();
    assert.equal((await f.rpc("review_patch", input) as any).patch, first.patch);
    assert.equal(calls(), before);
    const detail = await f.rpc("reviews_get", { reviewId: review.id, path: "a.md" }) as any;
    assert.deepEqual(detail.initialPatch, { path: "a.md", patch: first.patch, contents: null });
    f.setPr(1, { headRefOid: "head-new", updatedAt: "2026-10-17T12:00:00Z" });
    await f.rpc("reviews_sync", { reviewId: review.id });
    const next = await f.rpc("review_patch", { ...input, revision: { ...input.revision, head: "head-new" } }) as any;
    assert.notEqual(next.patch, first.patch);
    assert.equal((await f.rpc("review_patch", input) as any).patch, first.patch);
    assert.equal(calls(), before + 1);
    f.onRead((method) => method === "gh_merge_options" ? new Promise((resolve) => { release = resolve; }) : undefined);
    const pending = f.rpc("review_merge_options", { reviewId: review.id, refresh: true });
    await new Promise((resolve) => setImmediate(resolve));
    await f.rpc("reviews_remove", { reviewId: review.id });
    release({ methods: ["squash"], defaultMethod: "squash", reason: null, headSha: "head-new", baseRefName: "main", prs: [{ number: 1, headSha: "head-new" }] });
    await pending;
    assert.equal(f.bb.storage.database().prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM read_cache WHERE review_id = ?").get(review.id)?.n, 0, "late responses cannot restore removed cache data");
  } finally { release?.(null); await f.harness.lifecycle.dispose(); }
});

test("Recent includes unopened layers and refreshed metadata, preserves detached drafts, and survives reload", async () => {
  const f = await fixture();
  try {
    const first = await f.open(1);
    await f.rpc("pending_add", { reviewId: first.id, path: "a.ts", line: 1, side: "RIGHT", body: "Keep this draft" });
    assert.deepEqual((await f.list()).map((r) => r.number).sort(), [1, 2, 3]);
    assert.equal((await f.list()).find((r) => r.number === 2)?.id, null);
    assert.equal(f.calls.filter((call) => call.method === "repo_prepare").length, 1);
    const next = stack([2, 3, 4]);
    next.entries[0] = { ...next.entries[0], title: "Renamed and approved", reviewDecision: "APPROVED" };
    next.entries[1] = { ...next.entries[1], state: "MERGED", merged: true };
    next.entries[2].isDraft = true;
    f.setStack(next);
    await f.rpc("reviews_sync", { reviewId: first.id });
    const listed = await f.list();
    assert.deepEqual(listed.filter((r) => r.stack).map((r) => r.number).sort(), [2, 4]);
    assert.equal(listed.find((r) => r.number === 2)?.title, "Renamed and approved");
    assert.equal(listed.find((r) => r.number === 2)?.reviewDecision, "APPROVED");
    assert.equal(listed.find((r) => r.number === 3), undefined);
    assert.equal(listed.find((r) => r.number === 4)?.stack?.position, 2);
    assert.equal(listed.find((r) => r.number === 4)?.stack?.size, 2);
    assert.equal(listed.find((r) => r.number === 4)?.isDraft, true);
    assert.equal(listed.find((r) => r.number === 1)?.stack, null);
    assert.equal(listed.find((r) => r.number === 1)?.pendingCount, 1);
    await f.reload();
    assert.deepEqual((await f.list()).filter((r) => r.stack).map((r) => r.number).sort(), [2, 4]);
    assert.equal(f.calls.filter((call) => call.method === "repo_prepare").length, 2);
  } finally { await f.harness.lifecycle.dispose(); }
});

test("background refresh follows the stack number after every opened PR leaves", async () => {
  const f = await fixture(); const now = Date.now;
  try {
    const first = await f.open(1);
    f.setStack(stack([2, 3]));
    await f.rpc("reviews_sync", { reviewId: first.id });
    f.setStack(stack([4, 5]));
    Date.now = () => now() + 120_000;
    const service = f.harness.behavior.runService("sync-stacks");
    f.onStack(() => { if (f.calls.at(-1)?.input.stackNumber === 7) service.controller.abort(); });
    await service.done;
    assert.deepEqual((await f.list()).filter((r) => r.stack).map((r) => r.number).sort(), [4, 5]);
    assert.ok(f.calls.some((call) => call.method === "gh_stack" && call.input.stackNumber === 7 && call.input.number === null));
  } finally { Date.now = now; await f.harness.lifecycle.dispose(); }
});

test("stack removal is atomic, includes every opened layer, and also applies through a layer's removal RPC", async () => {
  const f = await fixture();
  try {
    const first = await f.open(1); await f.open(2);
    const db = f.bb.storage.database();
    db.exec("CREATE TRIGGER fail_removal BEFORE DELETE ON reviews WHEN OLD.number = 2 BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    await assert.rejects(f.rpc("stacks_remove", { key: "gh:o/r#7" }), /test failure/);
    assert.equal((await f.list()).length, 3);
    assert.equal(f.calls.filter((call) => call.method === "repo_release").length, 0);
    db.exec("DROP TRIGGER fail_removal");
    await f.rpc("reviews_remove", { reviewId: first.id });
    assert.deepEqual(await f.list(), []);
    assert.equal(f.calls.filter((call) => call.method === "repo_release").length, 2);
    await f.reload();
    assert.deepEqual(await f.list(), []);
  } finally { await f.harness.lifecycle.dispose(); }
});

test("an in-flight stack refresh cannot resurrect a removed stack", async () => {
  const f = await fixture();
  try {
    const first = await f.open(1);
    let release!: () => void; let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    f.onStack(() => new Promise<void>((resolve) => { release = resolve; entered(); }));
    const syncing = f.rpc("reviews_sync", { reviewId: first.id });
    await enteredPromise;
    await f.rpc("stacks_remove", { key: "gh:o/r#7" });
    release(); await syncing;
    assert.deepEqual(await f.list(), []);
  } finally { await f.harness.lifecycle.dispose(); }
});

test("legacy stack caches migrate without losing unopened layers or reappearing after removal", async () => {
  const f = await fixture();
  try {
    await f.open(1);
    const db = f.bb.storage.database();
    db.exec("DELETE FROM tracked_stacks");
    db.prepare("UPDATE stack_cache SET json = ? WHERE number = 1").run(JSON.stringify(stack([1, 2, 3])));
    await f.reload();
    assert.equal((await f.list()).length, 3);
    await f.rpc("stacks_remove", { key: "gh:o/r#7" });
    await f.reload();
    assert.deepEqual(await f.list(), []);
  } finally { await f.harness.lifecycle.dispose(); }
});

test("moving a PR between native stacks preserves both stacks and inferred stacks retain their identity", async () => {
  const f = await fixture();
  try {
    await f.open(1);
    const { createStackStore } = await import("./stack-store");
    const store = createStackStore(f.bb.storage.database());
    store.save("o", "r", { ...stack([3, 4]), number: 8 }, "host");
    assert.deepEqual(store.get("gh:o/r#7")?.stack.entries.map((entry) => entry.number), [1, 2]);
    assert.equal(store.forPr("o", "r", 3)?.key, "gh:o/r#8");
    const key = store.save("o", "r", { ...stack([20, 21]), number: null, source: "inferred" }, "host");
    store.save("o", "r", { ...stack([21, 22]), number: null, source: "inferred" }, "host", key);
    assert.deepEqual(store.get(key)?.stack.entries.map((entry) => entry.number), [21, 22]);
    assert.equal(store.forPr("o", "r", 20), undefined);
  } finally { await f.harness.lifecycle.dispose(); }
});

test("remaining layers have contiguous positions when GitHub retains old position numbers", async () => {
  const f = await fixture();
  try {
    await f.open(1);
    const { createStackStore } = await import("./stack-store");
    const store = createStackStore(f.bb.storage.database());
    const snapshot = stack([2, 4]);
    snapshot.entries[0].position = 2; snapshot.entries[1].position = 4;
    store.save("o", "r", snapshot, "host");
    assert.deepEqual((await f.list()).filter((r) => r.stack).map((r) => r.stack?.position).sort(), [1, 2]);
  } finally { await f.harness.lifecycle.dispose(); }
});

test("PR and stack summaries use rename-aware cached totals and retain GitHub totals for unopened layers", async () => {
  const f = await fixture();
  try {
    f.setFiles([
      { path: "new/pure.ts", oldPath: "old/pure.ts", status: "renamed", additions: 0, deletions: 0, binary: false },
      { path: "new/edited.ts", oldPath: "old/edited.ts", status: "renamed", additions: 3, deletions: 2, binary: false },
    ]);
    const snapshot = stack([1, 2, 3]);
    f.setPr(1, { additions: 1000, deletions: 1000 });
    snapshot.entries[0].additions = 1000; snapshot.entries[0].deletions = 1000;
    snapshot.entries[1].additions = 17; snapshot.entries[1].deletions = 5;
    f.setStack(snapshot);
    const first = await f.open(1);
    await f.rpc("reviews_sync", { reviewId: first.id });
    const list = await f.list();
    assert.equal(list.find((r) => r.number === 1)?.additions, 3);
    assert.equal(list.find((r) => r.number === 1)?.deletions, 2);
    assert.equal(list.find((r) => r.number === 2)?.additions, 17);
    const detail = await f.rpc("reviews_get", { reviewId: first.id }) as any;
    assert.equal(detail.review.additions, 3); assert.equal(detail.review.deletions, 2);
    assert.equal(detail.stack.entries[0].additions, 3); assert.equal(detail.stack.entries[0].deletions, 2);
    f.setStack(stack([2, 3]));
    await f.rpc("reviews_sync", { reviewId: first.id });
    assert.equal((await f.list()).find((r) => r.number === 1)?.additions, 3);
    f.setFiles([]);
    f.setPr(1, { baseRefName: "different-base" });
    await f.rpc("reviews_sync", { reviewId: first.id });
    assert.equal((await f.list()).find((r) => r.number === 1)?.additions, 0);
  } finally { await f.harness.lifecycle.dispose(); }
});

test("base-tip pushes refresh the diff with an unchanged head and forced sync repairs a stale cache", async () => {
  const f = await fixture(); const now = Date.now;
  try {
    f.setFiles([{ path: "a.ts", oldPath: null, status: "modified", additions: 1, deletions: 0, binary: false }]);
    f.setStack(stack([1]));
    const first = await f.open(1);
    f.setPr(1, { baseRefOid: "new-base", additions: 9 });
    f.setFiles([{ path: "a.ts", oldPath: null, status: "modified", additions: 9, deletions: 0, binary: false }]);
    Date.now = () => now() + 20_000;
    const service = f.harness.behavior.runService("sync-open-reviews");
    f.onDetails(() => service.controller.abort());
    await service.done;
    const detail = await f.rpc("reviews_get", { reviewId: first.id }) as any;
    assert.equal(detail.review.headSha, first.headSha);
    assert.equal(detail.review.baseSha, "new-base");
    assert.equal(detail.review.additions, 9);
    assert.equal(f.calls.filter((call) => call.method === "repo_prepare").length, 2);
    // A merge-base cache from a different comparison must never be reused.
    const db = f.bb.storage.database();
    db.prepare("UPDATE files_cache SET base_sha = 'old-base', json = '[]' WHERE review_id = ?").run(first.id);
    assert.equal((await f.rpc("reviews_get", { reviewId: first.id }) as any).files[0].additions, 9);
    f.setFiles([{ path: "a.ts", oldPath: null, status: "modified", additions: 12, deletions: 0, binary: false }]);
    await f.rpc("reviews_sync", { reviewId: first.id });
    assert.equal((await f.rpc("reviews_get", { reviewId: first.id }) as any).review.additions, 12);
  } finally { Date.now = now; await f.harness.lifecycle.dispose(); }
});

test("stack polling updates membership and counts while review details are blocked", async () => {
  const f = await fixture(); const now = Date.now;
  let release!: () => void;
  try {
    f.setStack(stack([1]));
    const first = await f.open(1);
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { entered = resolve; });
    f.onDetails(() => new Promise<void>((resolve) => { release = resolve; entered(); }));
    f.setPr(1, { additions: 8, headRefOid: "pushed-head" });
    f.setFiles([{ path: "a.ts", oldPath: null, status: "added", additions: 8, deletions: 0, binary: false }]);
    Date.now = () => now() + 20_000;
    const reviews = f.harness.behavior.runService("sync-open-reviews");
    await pending;
    // File counts are published before the heavy query finishes.
    assert.equal((await f.rpc("reviews_get", { reviewId: first.id }) as any).review.additions, 8);
    const next = stack([1, 2, 3, 4]);
    Date.now = () => now() + 40_000;
    next.entries[0].headSha = "pushed-head";
    next.entries[0].additions = 11; // Same head, newer remote comparison.
    next.entries[3].additions = 29;
    next.entries[3].reviewDecision = "APPROVED";
    f.setStack(next);
    const stacks = f.harness.behavior.runService("sync-stacks");
    f.onStack(() => stacks.controller.abort());
    await stacks.done;
    const list = await f.list();
    assert.equal(list.find((r) => r.number === 1)?.additions, 11);
    assert.equal(list.find((r) => r.number === 4)?.additions, 29);
    assert.equal(list.find((r) => r.number === 4)?.reviewDecision, "APPROVED");
    assert.equal(f.calls.filter((call) => call.method === "gh_stack").at(-1)?.input.metadataOnly, true);
    reviews.controller.abort(); release(); await reviews.done;
  } finally { release?.(); Date.now = now; await f.harness.lifecycle.dispose(); }
});

test("a manual refresh waits for a normal sync and then fetches the latest push", async () => {
  const f = await fixture(); const now = Date.now;
  let release!: () => void;
  try {
    const first = await f.open(1);
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { entered = resolve; });
    f.onStatus(() => new Promise<void>((resolve) => { release = resolve; entered(); }));
    Date.now = () => now() + 20_000;
    await f.rpc("reviews_get", { reviewId: first.id });
    await pending;
    const manual = f.rpc("reviews_sync", { reviewId: first.id });
    f.setPr(1, { headRefOid: "pushed-head" });
    f.onStatus(undefined); release();
    const result = await manual as any;
    assert.equal(result.review.headSha, "pushed-head");
    assert.equal(result.headChanged, true);
  } finally { release?.(); Date.now = now; await f.harness.lifecycle.dispose(); }
});

const ownPr = (number: number, repo = "r"): OwnPrs["prs"][number] => ({ owner: "o", repo, number, title: `Own PR ${number}`, state: "OPEN", isDraft: false, headSha: `head-${number}`, additions: number, deletions: 0, reviewDecision: null, updatedAt: "2026-10-07T00:00:00Z" });

test("all authored open PRs appear lazily, deduplicate stacks and local reviews, survive reload, and retire without losing drafts", async () => {
  const f = await fixture(); const now = Date.now;
  let clock = now();
  Date.now = () => clock;
  const poll = async () => {
    clock += 20_000;
    const service = f.harness.behavior.runService("sync-own-prs");
    f.onOwn(() => service.controller.abort());
    await service.done; f.onOwn(undefined);
  };
  try {
    await f.open(1);
    f.setOwn({ login: "viewer", prs: [ownPr(1), { ...ownPr(4), isDraft: true, reviewDecision: "APPROVED" }, ownPr(4, "other"), { ...ownPr(5), state: "CLOSED" }, { ...ownPr(6), state: "MERGED" }] });
    const listed = await f.list();
    assert.equal(listed.filter((pr) => pr.repo === "r" && pr.number === 1).length, 1);
    assert.equal(listed.find((pr) => pr.repo === "r" && pr.number === 4)?.isDraft, true);
    assert.equal(listed.find((pr) => pr.repo === "r" && pr.number === 4)?.id, null);
    assert.equal(listed.filter((pr) => pr.number === 4).length, 2);
    assert.equal(listed.some((pr) => pr.number === 5 || pr.number === 6), false);
    assert.equal(f.calls.filter((call) => call.method === "repo_prepare").length, 1);
    f.setPr(4, { author: { login: "viewer" } });
    const opened = await f.open(4);
    await f.rpc("pending_add", { reviewId: opened.id, path: "a.ts", line: 1, side: "RIGHT", body: "Preserve my draft" });
    assert.equal((await f.list()).filter((pr) => pr.repo === "r" && pr.number === 4).length, 1);
    await f.reload();
    assert.equal((await f.list()).find((pr) => pr.repo === "r" && pr.number === 4)?.id, opened.id);
    f.setOwn({ login: "viewer", prs: [ownPr(1), ownPr(7)] });
    await poll();
    const next = await f.list();
    assert.ok(next.some((pr) => pr.number === 7));
    assert.equal(next.some((pr) => pr.number === 4), false);
    assert.equal(f.bb.storage.database().prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM pending WHERE review_id = ?").get(opened.id)?.n, 1);
  } finally { Date.now = now; await f.harness.lifecycle.dispose(); }
});

test("automatic discovery respects removal of unopened PRs and entire stacks, and retains data on failure", async () => {
  const f = await fixture(); const now = Date.now;
  let clock = now(); Date.now = () => clock;
  const poll = async () => {
    clock += 20_000;
    const service = f.harness.behavior.runService("sync-own-prs");
    f.onOwn(() => service.controller.abort());
    await service.done; f.onOwn(undefined);
  };
  try {
    await f.open(1);
    f.setOwn({ login: "viewer", prs: [ownPr(1), ownPr(2), ownPr(3), ownPr(4)] });
    await f.list();
    await f.rpc("reviews_remove", { owner: "o", repo: "r", number: 4 });
    await f.rpc("stacks_remove", { key: "gh:o/r#7" });
    await poll();
    assert.deepEqual(await f.list(), []);
    await f.reload();
    assert.deepEqual(await f.list(), []);
    f.setOwn({ login: "viewer", prs: [ownPr(8)] });
    await poll();
    f.setOwnError("GitHub unavailable");
    await poll();
    const result = await f.rpc("reviews_list", null) as any;
    assert.equal(result.discoveryError, "GitHub unavailable");
    assert.equal(result.reviews[0].number, 8);
    f.setOwnError(null);
    await poll();
    assert.equal((await f.rpc("reviews_list", null) as any).discoveryError, null);
  } finally { Date.now = now; await f.harness.lifecycle.dispose(); }
});

test("review activity comes from GitHub rather than opening or syncing the local review", async () => {
  const f = await fixture(); const now = Date.now;
  try {
    const first = await f.open(1);
    const manual = await f.open(9);
    f.setOwn({ login: "viewer", prs: [{ ...ownPr(1), updatedAt: "2026-10-10T00:00:00Z" }, { ...ownPr(2), updatedAt: "2026-10-09T00:00:00Z" }] });
    const before = await f.list();
    assert.equal(before.find((pr) => pr.number === 1)?.updatedAt, Date.parse("2026-10-10T00:00:00Z"));
    assert.equal(before.find((pr) => pr.number === 2)?.updatedAt, Date.parse("2026-10-09T00:00:00Z"));
    assert.equal(before.find((pr) => pr.number === 9)?.updatedAt, Date.parse("2026-10-06T00:00:00Z"));
    Date.now = () => now() + 60_000;
    await f.rpc("reviews_sync", { reviewId: first.id });
    await f.rpc("reviews_sync", { reviewId: manual.id });
    const after = await f.list();
    for (const number of [1, 2, 9]) assert.equal(after.find((pr) => pr.number === number)?.updatedAt, before.find((pr) => pr.number === number)?.updatedAt);
  } finally { Date.now = now; await f.harness.lifecycle.dispose(); }
});

test("merged layers and completed stacks disappear from every read model without deleting drafts", async () => {
  const f = await fixture();
  try {
    const first = await f.open(1); const second = await f.open(2);
    await f.rpc("pending_add", { reviewId: first.id, path: "a.ts", line: 1, side: "RIGHT", body: "Keep after merge" });
    const mixed = stack([1, 2, 3]);
    mixed.entries[0].merged = true; // GitHub's merged flag also hides a stale OPEN state.
    mixed.entries[0].additions = 1000;
    mixed.entries[1].additions = 7;
    mixed.entries[2].state = "CLOSED";
    f.setStack(mixed); f.setPr(1, { state: "MERGED" });
    await f.rpc("reviews_sync", { reviewId: first.id });
    const visible = await f.list();
    assert.deepEqual(visible.map((pr) => pr.number), [2]);
    assert.equal(visible[0].additions, 7);
    assert.deepEqual(visible[0].stack, { number: 7, position: 1, size: 1, key: "gh:o/r#7" });
    const detail = await f.rpc("reviews_get", { reviewId: second.id }) as any;
    assert.deepEqual(detail.stack.entries.map((pr: any) => pr.number), [2]);
    assert.equal(detail.stack.entries[0].additions, 7);
    assert.equal(detail.stack.currentPosition, 1);
    await assert.rejects(f.rpc("reviews_get", { reviewId: first.id }), /closed/);
    const merged = stack([1, 2, 3]);
    for (const pr of merged.entries) pr.state = "MERGED";
    f.setStack(merged); f.setPr(2, { state: "MERGED" });
    await f.rpc("reviews_sync", { reviewId: second.id });
    assert.deepEqual(await f.list(), []);
    const preparations = f.calls.filter((call) => call.method === "repo_prepare").length;
    await assert.rejects(f.rpc("reviews_open", { ref: "o/r/stack/7" }), /No open pull requests/);
    await assert.rejects(f.open(1), /merged or closed/);
    assert.equal(f.calls.filter((call) => call.method === "repo_prepare").length, preparations);
    await f.reload();
    assert.deepEqual(await f.list(), []);
    const db = f.bb.storage.database();
    assert.equal(db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM pending WHERE review_id = ?").get(first.id)?.n, 1);
    assert.equal(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM tracked_stacks").get()?.n, 1);
    // Tracking stays intact so adding a new open layer brings the stack back.
    f.setStack({ ...merged, entries: [...merged.entries, { ...stack([5]).entries[0], position: 4 }] });
    await f.rpc("reviews_sync", { reviewId: second.id });
    const reopened = await f.list();
    assert.deepEqual(reopened.map((pr) => pr.number), [5]);
    assert.equal(reopened[0].stack?.size, 1);
    assert.equal(reopened[0].stack?.position, 1);
  } finally { await f.harness.lifecycle.dispose(); }
});

test("local merge status overrides stale authored and stack snapshots and standalone completed PRs stay hidden", async () => {
  const f = await fixture();
  try {
    const first = await f.open(1); const standalone = await f.open(4);
    f.setOwn({ login: "viewer", prs: [ownPr(4)] });
    await f.list();
    // A status refresh may learn of the merge before either bulk snapshot refreshes.
    const db = f.bb.storage.database();
    db.prepare("UPDATE reviews SET state = 'MERGED' WHERE id IN (?, ?)").run(first.id, standalone.id);
    assert.deepEqual((await f.list()).map((pr) => pr.number).sort(), [2, 3]);
    const second = await f.open(2);
    const detail = await f.rpc("reviews_get", { reviewId: second.id }) as any;
    assert.deepEqual(detail.stack.entries.map((pr: any) => pr.number), [2, 3]);
    assert.equal(detail.stack.currentPosition, 1);
    f.setPr(9, { state: "CLOSED" });
    await assert.rejects(f.open(9), /merged or closed/);
    f.setPr(10, { state: "MERGED" });
    await assert.rejects(f.open(10), /merged or closed/);
    assert.equal(f.calls.some((call) => call.method === "repo_prepare" && [9, 10].includes(call.input.number)), false);
  } finally { await f.harness.lifecycle.dispose(); }
});

test("minute prefetch warms files and conversation, and an unchanged head needs no further Git preparation", async () => {
  const f = await fixture(); const now = Date.now;
  let clock = now(); Date.now = () => clock;
  const prefetch = async () => {
    const service = f.harness.behavior.runService("sync-open-reviews");
    f.onConversation(() => service.controller.abort());
    await service.done; f.onConversation(undefined);
  };
  try {
    f.setStack(null); f.setOwn({ login: "viewer", prs: [ownPr(10)] });
    await prefetch();
    const first = (await f.list())[0];
    assert.ok(first.id);
    assert.equal(f.calls.filter((c) => c.method === "repo_prepare").length, 1);
    assert.equal(f.calls.filter((c) => c.method === "gh_pr_details").length, 1);
    assert.equal(f.calls.filter((c) => c.method === "gh_pr_statuses").length, 1);
    assert.equal(f.calls.filter((c) => c.method === "gh_pr_status").length, 0);
    const before = f.calls.length;
    const opened = await f.open(10);
    const detail = await f.rpc("reviews_get", { reviewId: opened.id }) as any;
    assert.equal(detail.review.id, first.id);
    assert.deepEqual(detail.threads, []);
    assert.equal(f.calls.length, before);
    const db = f.bb.storage.database();
    assert.ok(db.prepare("SELECT json FROM conversation_cache WHERE review_id = ?").get(first.id));
    clock += 6 * 60_000;
    await prefetch();
    assert.equal(f.calls.filter((c) => c.method === "repo_prepare").length, 1);
    assert.equal(f.calls.filter((c) => c.method === "git_files").length, 1);
  } finally { Date.now = now; await f.harness.lifecycle.dispose(); }
});

test("minute prefetch warms merge actions, permissions, patches and Markdown content before opening a PR", async () => {
  const f = await fixture();
  let service: ReturnType<typeof f.harness.behavior.runService> | undefined;
  try {
    f.setStack(null); f.setOwn({ login: "viewer", prs: [ownPr(10)] });
    f.setFiles(["a.md", "b.ts"].map((path) => ({ path, oldPath: null, status: "modified", additions: 1, deletions: 1, binary: false })));
    f.onRead((method, input) => {
      if (method !== "git_patch") return;
      if (input.path === "b.ts") service!.controller.abort();
      return Promise.resolve({ patch: `prefetched ${input.path}` });
    });
    service = f.harness.behavior.runService("sync-open-reviews");
    await service.done;
    const review = (await f.list())[0];
    assert.ok(review.id);
    const before = f.calls.length;
    const detail = await f.rpc("reviews_get", { reviewId: review.id, path: "a.md" }) as any;
    assert.equal(detail.mergeOptions.defaultMethod, "squash");
    assert.equal(detail.description.canEdit, true);
    assert.deepEqual(detail.conversation.comments, []);
    assert.deepEqual(detail.initialPatch, { path: "a.md", patch: "prefetched a.md", contents: { oldContent: "base:a.md", newContent: "head-10:a.md" } });
    await f.rpc("review_patch", { reviewId: review.id, path: "b.ts" });
    await f.rpc("commit_file", { reviewId: review.id, sha: "base", path: "a.md" });
    await f.rpc("commit_file", { reviewId: review.id, sha: "head-10", path: "a.md" });
    assert.equal(f.calls.length, before, "opening prefetched resources makes no host or GitHub calls");
  } finally { service?.controller.abort(); await f.harness.lifecycle.dispose(); }
});

test("foreground opens share pending preparation and cached opens do not wait for heavy refreshes", { timeout: 8000 }, async () => {
  const f = await fixture(); let releasePrepare!: () => void; let releaseDetails!: () => void;
  let service: ReturnType<typeof f.harness.behavior.runService> | undefined;
  try {
    f.setStack(null); f.setOwn({ login: "viewer", prs: [ownPr(1)] });
    let prepared!: () => void; const preparing = new Promise<void>((r) => { prepared = r; });
    let loading!: () => void; const details = new Promise<void>((r) => { loading = r; });
    f.onPrepare(() => new Promise<void>((r) => { releasePrepare = r; prepared(); }));
    f.onDetails(() => new Promise<void>((r) => { releaseDetails = r; loading(); }));
    service = f.harness.behavior.runService("sync-open-reviews");
    await preparing;
    const clicked = f.open(1);
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(f.calls.filter((c) => c.method === "repo_prepare").length, 1);
    releasePrepare();
    const first = await clicked;
    await details;
    let returned = false;
    const cached = f.open(1).then((r) => { returned = true; return r; });
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(returned, true);
    assert.equal((await cached).id, first.id);
    service.controller.abort(); releaseDetails(); await service.done;
  } finally { service?.controller.abort(); releasePrepare?.(); releaseDetails?.(); await f.harness.lifecycle.dispose(); }
});

test("removing an unopened PR during prefetch cannot recreate it", async () => {
  const f = await fixture(); let release!: () => void;
  let service: ReturnType<typeof f.harness.behavior.runService> | undefined;
  try {
    f.setStack(null); f.setOwn({ login: "viewer", prs: [ownPr(1)] });
    let entered!: () => void; const pending = new Promise<void>((r) => { entered = r; });
    f.onPrepare(() => new Promise<void>((r) => { release = r; entered(); }));
    service = f.harness.behavior.runService("sync-open-reviews");
    await pending;
    await f.rpc("reviews_remove", { owner: "o", repo: "r", number: 1 });
    service.controller.abort(); release(); await service.done;
    assert.deepEqual(await f.list(), []);
    assert.equal(f.calls.filter((c) => c.method === "repo_release").length, 1);
    assert.equal(f.bb.storage.database().prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM reviews").get()?.n, 0);
  } finally { service?.controller.abort(); release?.(); await f.harness.lifecycle.dispose(); }
});

test("independent status scans close and reopen PRs while Git preparation is blocked", async () => {
  const f = await fixture(); let release!: () => void;
  let prefetch: ReturnType<typeof f.harness.behavior.runService> | undefined;
  const scan = async () => {
    const service = f.harness.behavior.runService("scan-pr-status");
    f.onBatch(() => service.controller.abort());
    await service.done; f.onBatch(undefined);
  };
  try {
    f.setStack(null);
    const second = await f.open(2);
    await f.rpc("pending_add", { reviewId: second.id, path: "a.ts", line: 1, side: "RIGHT", body: "Keep through reopening" });
    f.setOwn({ login: "viewer", prs: [ownPr(1)] });
    let entered!: () => void; const pending = new Promise<void>((r) => { entered = r; });
    f.onPrepare((number) => number === 1 ? new Promise<void>((r) => { release = r; entered(); }) : undefined);
    prefetch = f.harness.behavior.runService("sync-open-reviews");
    await pending;
    const before = f.calls.filter((c) => c.method === "repo_prepare").length;
    f.setPr(2, { state: "CLOSED" }); await scan();
    assert.equal((await f.list()).some((pr) => pr.number === 2), false);
    f.setPr(2, { state: "OPEN", updatedAt: "2026-10-08T00:00:00Z" }); await scan();
    assert.equal((await f.list()).find((pr) => pr.number === 2)?.id, second.id);
    assert.equal(f.calls.filter((c) => c.method === "repo_prepare").length, before);
    const db = f.bb.storage.database();
    assert.equal(db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM pending WHERE review_id = ?").get(second.id)?.n, 1);
    prefetch.controller.abort(); release(); await prefetch.done;
  } finally { prefetch?.controller.abort(); release?.(); await f.harness.lifecycle.dispose(); }
});

test("a late heavy refresh cannot undo a closure learned by a status scan", async () => {
  const f = await fixture(); let release!: () => void;
  let prefetch: ReturnType<typeof f.harness.behavior.runService> | undefined;
  try {
    f.setStack(null); f.setOwn({ login: "viewer", prs: [ownPr(1)] });
    let entered!: () => void; const pending = new Promise<void>((r) => { entered = r; });
    f.onDetails(() => new Promise<void>((r) => { release = r; entered(); }));
    prefetch = f.harness.behavior.runService("sync-open-reviews");
    await pending;
    f.setPr(1, { state: "CLOSED", updatedAt: "2026-10-08T00:00:00Z" });
    const scan = f.harness.behavior.runService("scan-pr-status");
    f.onBatch(() => scan.controller.abort()); await scan.done;
    prefetch.controller.abort(); release(); await prefetch.done;
    assert.deepEqual(await f.list(), []);
    assert.equal(f.bb.storage.database().prepare<[], { state: string }>("SELECT state FROM reviews WHERE number = 1").get()?.state, "CLOSED");
  } finally { prefetch?.controller.abort(); release?.(); await f.harness.lifecycle.dispose(); }
});

test("status scans batch tracked refs and retain last good state after an API failure", async () => {
  const f = await fixture();
  const scan = async () => {
    const service = f.harness.behavior.runService("scan-pr-status");
    f.onBatch(() => service.controller.abort());
    await service.done; f.onBatch(undefined);
  };
  try {
    f.setStack(null); f.setOwn({ login: "viewer", prs: Array.from({ length: 75 }, (_, i) => ownPr(i + 1)) });
    await f.list(); await scan();
    const batches = f.calls.filter((c) => c.method === "gh_pr_statuses");
    assert.deepEqual(batches.map((c) => c.input.prs.length), [50, 25]);
    f.setBatchError("GitHub unavailable"); await scan();
    const failed = await f.rpc("reviews_list", null) as any;
    assert.equal(failed.reviews.length, 75);
    assert.equal(failed.discoveryError, "GitHub unavailable");
    f.setBatchError(null); await scan();
    assert.equal((await f.rpc("reviews_list", null) as any).discoveryError, null);
  } finally { await f.harness.lifecycle.dispose(); }
});

test("standalone stack discovery is cached for a minute instead of repeating on every UI poll", async () => {
  const f = await fixture(); const now = Date.now;
  let clock = now(); Date.now = () => clock;
  try {
    f.setStack(null); await f.open(1);
    const count = () => f.calls.filter((c) => c.method === "gh_stack").length;
    assert.equal(count(), 1);
    clock += 20_000; await f.list(); await new Promise<void>((r) => setImmediate(r));
    assert.equal(count(), 1);
    clock += 41_000; await f.list(); await new Promise<void>((r) => setImmediate(r));
    assert.equal(count(), 2);
  } finally { Date.now = now; await f.harness.lifecycle.dispose(); }
});
