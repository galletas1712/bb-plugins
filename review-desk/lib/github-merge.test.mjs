import assert from "node:assert/strict";
import { test } from "node:test";
import { mergePr, readMergeOptions, readMergeResult } from "./github-merge.ts";

const ref = { owner: "o", repo: "r", number: 2 };
const pr = { number: 2, headRefOid: "head-2", state: "OPEN", isDraft: false, baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", stack: null };
const repository = (pullRequest = pr, extra = {}) => ({ data: { repository: { mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: false, viewerPermission: "WRITE", pullRequest, ...extra } } });
const expected = { headSha: "head-2", baseRefName: "main", prs: [{ number: 2, headSha: "head-2" }] };
const stub = (responses) => {
  const calls = [];
  return { calls, run: async (cmd, args, options) => {
    calls.push({ cmd, args, payload: options?.input ? JSON.parse(options.input) : null });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, "unexpected GitHub request");
    return { stdout: JSON.stringify(response) };
  } };
};

test("merge options reflect repository methods, permissions, and GitHub blockers", async () => {
  assert.deepEqual(await readMergeOptions(stub([repository()]).run, ref), { ...expected, methods: ["squash"], reason: null });
  const all = await readMergeOptions(stub([repository(pr, { mergeCommitAllowed: true, rebaseMergeAllowed: true })]).run, ref);
  assert.deepEqual(all.methods, ["merge", "squash", "rebase"]);
  for (const [changed, repoExtra, reason] of [
    [{ state: "MERGED" }, {}, /closed or merged/], [{ state: "CLOSED" }, {}, /closed or merged/],
    [{ isDraft: true }, {}, /draft/], [{}, { viewerPermission: "READ" }, /permission/],
    [{}, { squashMergeAllowed: false }, /does not allow/], [{ mergeable: "CONFLICTING" }, {}, /conflicts/],
    [{ mergeStateStatus: "BLOCKED" }, {}, /requirements/], [{ mergeStateStatus: "BEHIND" }, {}, /requirements/],
    [{ mergeable: "UNKNOWN" }, {}, /checking/],
  ]) {
    const fake = stub([repository({ ...pr, ...changed }, repoExtra)]);
    await assert.rejects(mergePr(fake.run, { ...ref, expected, method: "squash" }), reason);
    assert.equal(fake.calls.length, 1, "blocked merges must never mutate GitHub");
  }
});

test("native stack merge scope includes open downstack layers in order and excludes layers above", async () => {
  const nodes = [3, 1, 2, 0].map((n) => ({ position: n, pullRequest: { ...pr, number: n, headRefOid: `head-${n}`, state: n === 0 ? "MERGED" : "OPEN" } }));
  const stacked = { ...pr, baseRefName: "branch-1", stack: { baseRefName: "main", entries: { pageInfo: { hasNextPage: false }, nodes } } };
  const current = await readMergeOptions(stub([repository(stacked)]).run, ref);
  assert.deepEqual(current.prs, [{ number: 1, headSha: "head-1" }, { number: 2, headSha: "head-2" }]);
  assert.equal(current.baseRefName, "main");
  nodes.find((n) => n.position === 1).pullRequest.isDraft = true;
  assert.match((await readMergeOptions(stub([repository(stacked)]).run, ref)).reason, /draft/);
  stacked.stack.entries.pageInfo.hasNextPage = true;
  await assert.rejects(readMergeOptions(stub([repository(stacked)]).run, ref), /complete merge scope/);
});

test("submission rechecks method, head, destination and downstack scope before requesting a merge", async () => {
  for (const changed of [
    { ...expected, headSha: "old" }, { ...expected, baseRefName: "different" },
    { ...expected, prs: [{ number: 1, headSha: "head-1" }, ...expected.prs] },
    { ...expected, prs: [{ number: 2, headSha: "old" }] },
  ]) {
    const fake = stub([repository()]);
    await assert.rejects(mergePr(fake.run, { ...ref, expected: changed, method: "squash" }), /changed/);
    assert.equal(fake.calls.length, 1);
  }
  const fake = stub([repository()]);
  await assert.rejects(mergePr(fake.run, { ...ref, expected, method: "merge" }), /no longer allowed/);
  assert.equal(fake.calls.length, 1);
});

test("merge requests pin the head, name the action, never bypass rules, and track async outcomes", async () => {
  const requestId = "630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42";
  const fake = stub([repository(), { status: "pending", details: { uuid: requestId, message: "Merge request enqueued." } }, { status: "failed", details: { message: "Required checks failed." } }]);
  assert.deepEqual(await mergePr(fake.run, { ...ref, expected, method: "squash" }), { status: "pending", requestId, message: "Merge request enqueued." });
  assert.deepEqual(fake.calls[1].args, ["api", "-H", "X-GitHub-Api-Version: 2026-03-10", "-X", "PUT", "repos/o/r/pulls/2/merge-async", "--input", "-"]);
  assert.deepEqual(fake.calls[1].payload, { sha: "head-2", merge_method: "squash", merge_action: "direct_merge", bypass_rules: false });
  assert.deepEqual(await readMergeResult(fake.run, { ...ref, requestId }), { status: "failed", requestId: null, message: "Required checks failed." });
  assert.equal(fake.calls[2].args.at(-1), `repos/o/r/pulls/2/merge-async/${requestId}`);
  for (const status of ["merged", "enqueued"]) assert.equal((await readMergeResult(stub([{ status }]).run, { ...ref, requestId })).status, status);
  await assert.rejects(readMergeResult(stub([{ status: "unexpected" }]).run, { ...ref, requestId }), /unknown merge result/);
  await assert.rejects(readMergeResult(stub([{ status: "pending" }]).run, { ...ref, requestId }), /request ID/);
  await assert.rejects(mergePr(stub([repository(), new Error("Branch rules forbid merging")]).run, { ...ref, expected, method: "squash" }), /Branch rules/);
  await assert.rejects(readMergeOptions(stub([{ errors: [{ message: "Forbidden" }] }]).run, ref), /Forbidden/);
});
