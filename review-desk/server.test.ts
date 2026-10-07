import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { type ReviewSummary } from "./server";
import type { ChangedFile, GhPr, PrStack, OwnPrs } from "./host-contract";

const pr = (number: number): GhPr => ({ number, title: `PR ${number}`, body: "Body", state: "OPEN", isDraft: false, url: `https://github.com/o/r/pull/${number}`, author: { login: "me" }, baseRefName: "main", headRefName: `branch-${number}`, headRefOid: `head-${number}`, baseRefOid: "base", additions: 0, deletions: 0, changedFiles: 0, reviewDecision: null, mergeable: null, updatedAt: "2026-10-06T00:00:00Z", createdAt: "2026-10-05T00:00:00Z", checks: [], labels: [], reviewers: [], assignees: [], commits: [] });
const stack = (numbers: number[]): PrStack => ({ number: 7, baseRefName: "main", source: "github", entries: numbers.map((number, i) => ({ position: i + 1, number, title: `PR ${number}`, state: "OPEN", isDraft: false, merged: false, url: pr(number).url, additions: 0, deletions: 0, changedFiles: 0, reviewDecision: null, headRefName: `branch-${number}`, headSha: `head-${number}`, baseRefName: "main", files: [] })) });

async function fixture() {
  let files: ChangedFile[] = [];
  const remotePrs = new Map<number, Partial<GhPr>>();
  let snapshot: PrStack | null = stack([1, 2, 3]);
  let onStack: (() => Promise<void> | void) | undefined;
  let onDetails: (() => Promise<void> | void) | undefined;
  let onStatus: (() => Promise<void> | void) | undefined;
  let own: OwnPrs = { login: "viewer", prs: [] };
  let ownError: string | null = null;
  let onOwn: (() => void) | undefined;
  const calls: { method: string; input: any }[] = [];
  let { bb, harness } = createFakePluginHost({ pluginId: "review-desk", sdk: { projects: { list: async () => [] }, hosts: { list: async () => [makeHostResponse({ id: "host", status: "connected" })] } }, experimental_callHostRpc: async ({ method, input }) => {
    const args = input as any;
    calls.push({ method, input });
    switch (method) {
      case "gh_own_prs": onOwn?.(); if (ownError) throw new Error(ownError); return own;
      case "gh_pr": case "gh_pr_status": {
        const result = { ...pr(args.number), ...remotePrs.get(args.number) };
        if (method === "gh_pr_status") await onStatus?.();
        return result;
      }
      case "gh_pr_details": await onDetails?.(); return { commits: [], labels: [], checks: [], reviewers: [], assignees: [] };
      case "repo_clone": return { repoPath: "/repo" };
      case "repo_prepare": return { worktree: `/repo/${args.number}`, headSha: args.headSha, baseSha: remotePrs.get(args.number)?.baseRefOid ?? "base" };
      case "repo_release": return { ok: true };
      case "git_files": return { files };
      case "gh_threads": return { threads: [] };
      case "gh_conversation": return { comments: [], reviews: [], events: [] };
      case "gh_stack": await onStack?.(); return { stack: args.stackNumber !== null || snapshot?.entries.some((entry) => entry.number === args.number) ? snapshot : null };
      default: throw new Error(`unexpected host call ${method}`);
    }
  } });
  await plugin(bb);
  const rpc = (method: string, input: unknown) => harness.behavior.callRpc(method, input);
  const open = async (number: number) => (await rpc("reviews_open", { ref: `o/r#${number}` }) as any).review;
  const list = async () => (await rpc("reviews_list", null) as { reviews: ReviewSummary[] }).reviews;
  return { get bb() { return bb; }, get harness() { return harness; }, reload: async () => { ({ bb, harness } = await harness.lifecycle.reload(plugin)); }, rpc, open, list, calls, setPr: (number: number, values: Partial<GhPr>) => remotePrs.set(number, values), setFiles: (next: ChangedFile[]) => { files = next; }, setStack: (next: PrStack | null) => { snapshot = next; }, onStack: (fn: typeof onStack) => { onStack = fn; }, onDetails: (fn: typeof onDetails) => { onDetails = fn; }, onStatus: (fn: typeof onStatus) => { onStatus = fn; }, setOwn: (next: OwnPrs) => { own = next; }, setOwnError: (error: string | null) => { ownError = error; }, onOwn: (fn: typeof onOwn) => { onOwn = fn; } };
}

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
    assert.deepEqual(listed.filter((r) => r.stack).map((r) => r.number).sort(), [2, 3, 4]);
    assert.equal(listed.find((r) => r.number === 2)?.title, "Renamed and approved");
    assert.equal(listed.find((r) => r.number === 2)?.reviewDecision, "APPROVED");
    assert.equal(listed.find((r) => r.number === 3)?.state, "MERGED");
    assert.equal(listed.find((r) => r.number === 4)?.isDraft, true);
    assert.equal(listed.find((r) => r.number === 1)?.stack, null);
    assert.equal(listed.find((r) => r.number === 1)?.pendingCount, 1);
    await f.reload();
    assert.deepEqual((await f.list()).filter((r) => r.stack).map((r) => r.number).sort(), [2, 3, 4]);
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
