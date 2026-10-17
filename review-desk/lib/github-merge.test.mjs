import assert from "node:assert/strict";
import { test } from "node:test";
import { mergePr, readMergeOptions, readMergeResult } from "./github-merge.ts";

const ref = { owner: "o", repo: "r", number: 2 };
const pr = { number: 2, headRefOid: "head-2", state: "OPEN", isDraft: false, baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", stack: null };
const repository = (pullRequest = pr, extra = {}) => ({ data: { repository: { mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: false, viewerPermission: "WRITE", viewerDefaultMergeMethod: "MERGE", pullRequest, ...extra } } });
const expected = { headSha: "head-2", baseRefName: "main", prs: [{ number: 2, headSha: "head-2" }] };
const stub = (responses, rules = [[]]) => {
  const calls = [];
  return { calls, run: async (cmd, args, options) => {
    calls.push({ cmd, args, payload: options?.input ? JSON.parse(options.input) : null });
    if (args.some((arg) => arg.includes("/rules/branches/"))) {
      if (rules instanceof Error) throw rules;
      return { stdout: JSON.stringify(rules) };
    }
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, "unexpected GitHub request");
    return { stdout: JSON.stringify(response) };
  } };
};

test("repository policy and branch rules are shared across PRs for ten minutes, with fresh merge validation", async () => {
  const original = Date.now; let clock = original(); Date.now = () => clock;
  try {
    const fake = stub([repository(), { data: { repository: { pullRequest: { ...pr, number: 3 } } } }, repository(), repository()]);
    await readMergeOptions(fake.run, ref);
    const next = await readMergeOptions(fake.run, { ...ref, number: 3 });
    assert.equal(next.defaultMethod, "squash");
    assert.equal(fake.calls.filter((call) => call.args.some((arg) => arg.includes("/rules/branches/"))).length, 1);
    assert.ok(!fake.calls.filter((call) => call.payload)[1].payload.query.includes("viewerPermission"));
    await readMergeOptions(fake.run, ref, true);
    assert.equal(fake.calls.filter((call) => call.args.some((arg) => arg.includes("/rules/branches/"))).length, 2);
    clock += 601_000;
    await readMergeOptions(fake.run, ref);
    assert.equal(fake.calls.filter((call) => call.args.some((arg) => arg.includes("/rules/branches/"))).length, 3);
  } finally { Date.now = original; }
});

test("a changed target branch has separate policy and failed branch reads can recover", async () => {
  const fake = stub([repository(), repository({ ...pr, baseRefName: "release" })]);
  await readMergeOptions(fake.run, ref); await readMergeOptions(fake.run, ref);
  assert.equal(fake.calls.filter((call) => call.args.some((arg) => arg.includes("/rules/branches/"))).length, 2);
  const failed = stub([repository(), repository()], new Error("GitHub unavailable"));
  await assert.rejects(readMergeOptions(failed.run, ref), /unavailable/);
  await assert.rejects(readMergeOptions(failed.run, ref), /unavailable/);
  assert.equal(failed.calls.filter((call) => call.args.some((arg) => arg.includes("/rules/branches/"))).length, 2);
});

test("merge options reflect repository methods, permissions, and GitHub blockers", async () => {
  assert.deepEqual(await readMergeOptions(stub([repository()]).run, ref), { ...expected, methods: ["squash"], defaultMethod: "squash", reason: null });
  const all = await readMergeOptions(stub([repository(pr, { mergeCommitAllowed: true, rebaseMergeAllowed: true })]).run, ref);
  assert.deepEqual(all.methods, ["merge", "squash", "rebase"]);
  for (const [changed, repoExtra, reason] of [
    [{ state: "MERGED" }, {}, /closed or merged/], [{ state: "CLOSED" }, {}, /closed or merged/],
    [{ isDraft: true }, {}, /draft/], [{}, { viewerPermission: "READ" }, /permission/],
    [{}, { squashMergeAllowed: false }, /do not allow/], [{ mergeable: "CONFLICTING" }, {}, /conflicts/],
    [{ mergeStateStatus: "BLOCKED" }, {}, /requirements/], [{ mergeStateStatus: "BEHIND" }, {}, /requirements/],
    [{ mergeable: "UNKNOWN" }, {}, /checking/],
  ]) {
    const fake = stub([repository({ ...pr, ...changed }, repoExtra)]);
    await assert.rejects(mergePr(fake.run, { ...ref, expected, method: "squash" }), reason);
    assert.equal(fake.calls.filter((call) => call.args.includes("PUT")).length, 0, "blocked merges must never mutate GitHub");
  }
});

test("GitHub's preferred merge method is used only when the repository and branch permit it", async () => {
  const response = repository(pr, { mergeCommitAllowed: true, rebaseMergeAllowed: true, viewerDefaultMergeMethod: "REBASE" });
  assert.equal((await readMergeOptions(stub([response]).run, ref)).defaultMethod, "rebase");
  const rules = [[{ type: "pull_request", parameters: { allowed_merge_methods: ["squash"] } }]];
  assert.equal((await readMergeOptions(stub([response], rules).run, ref)).defaultMethod, "squash");
  const disabled = repository(pr, { squashMergeAllowed: false });
  assert.equal((await readMergeOptions(stub([disabled]).run, ref)).defaultMethod, null);
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
    assert.equal(fake.calls.filter((call) => call.args.includes("PUT")).length, 0);
  }
  const fake = stub([repository()]);
  await assert.rejects(mergePr(fake.run, { ...ref, expected, method: "merge" }), /no longer allowed/);
  assert.equal(fake.calls.filter((call) => call.args.includes("PUT")).length, 0);
});

test("merge requests pin the head, name the action, never bypass rules, and track async outcomes", async () => {
  const requestId = "630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42";
  const fake = stub([repository(), { status: "pending", details: { uuid: requestId, message: "Merge request enqueued." } }, { status: "failed", details: { message: "Required checks failed." } }]);
  assert.deepEqual(await mergePr(fake.run, { ...ref, expected, method: "squash" }), { status: "pending", requestId, message: "Merge request enqueued." });
  const mutation = fake.calls.find((call) => call.args.includes("PUT"));
  assert.deepEqual(mutation.args, ["api", "-H", "X-GitHub-Api-Version: 2026-03-10", "-X", "PUT", "repos/o/r/pulls/2/merge-async", "--input", "-"]);
  assert.deepEqual(mutation.payload, { sha: "head-2", merge_method: "squash", merge_action: "direct_merge", bypass_rules: false });
  assert.deepEqual(await readMergeResult(fake.run, { ...ref, requestId }), { status: "failed", requestId: null, message: "Required checks failed." });
  assert.equal(fake.calls.at(-1).args.at(-1), `repos/o/r/pulls/2/merge-async/${requestId}`);
  for (const status of ["merged", "enqueued"]) assert.equal((await readMergeResult(stub([{ status }]).run, { ...ref, requestId })).status, status);
  await assert.rejects(readMergeResult(stub([{ status: "unexpected" }]).run, { ...ref, requestId }), /unknown merge result/);
  await assert.rejects(readMergeResult(stub([{ status: "pending" }]).run, { ...ref, requestId }), /request ID/);
  await assert.rejects(mergePr(stub([repository(), new Error("Branch rules forbid merging")]).run, { ...ref, expected, method: "squash" }), /Branch rules/);
  await assert.rejects(readMergeOptions(stub([{ errors: [{ message: "Forbidden" }] }]).run, ref), /Forbidden/);
});

test("merge methods intersect repository settings and every active target-branch rule page", async () => {
  const response = repository(pr, { mergeCommitAllowed: true, rebaseMergeAllowed: true });
  const pullRequestRule = (allowed) => ({ type: "pull_request", parameters: { allowed_merge_methods: allowed } });
  const fake = stub([response], [[pullRequestRule(["merge", "squash"]), { type: "required_signatures" }], [pullRequestRule(["squash", "rebase"])]]);
  assert.deepEqual((await readMergeOptions(fake.run, ref)).methods, ["squash"]);
  assert.ok(fake.calls[1].args.includes("--paginate"));
  assert.equal(fake.calls[1].args.at(-1), "repos/o/r/rules/branches/main?per_page=100");
  assert.deepEqual((await readMergeOptions(stub([response], [[{ type: "required_linear_history" }]]).run, ref)).methods, ["squash", "rebase"]);
  const incompatible = await readMergeOptions(stub([repository()], [[pullRequestRule(["rebase"])]]).run, ref);
  assert.deepEqual(incompatible.methods, []);
  assert.match(incompatible.reason, /do not allow a common merge method/);
  const queue = await readMergeOptions(stub([response], [[{ type: "merge_queue", parameters: { merge_method: "SQUASH" } }]]).run, ref);
  assert.deepEqual(queue.methods, ["squash"]);
  assert.match(queue.reason, /requires a merge queue/);
  const branch = stub([repository({ ...pr, baseRefName: "release/v1" })]);
  await readMergeOptions(branch.run, ref);
  assert.match(branch.calls[1].args.at(-1), /branches\/release%2Fv1\?/);
});

test("native stacks use the final destination's rules and submissions recheck method restrictions", async () => {
  const stacked = { ...pr, baseRefName: "branch-1", stack: { baseRefName: "main", entries: { pageInfo: { hasNextPage: false }, nodes: [{ position: 1, pullRequest: pr }] } } };
  const response = repository(stacked, { mergeCommitAllowed: true, rebaseMergeAllowed: true });
  const fake = stub([response], [[{ type: "pull_request", parameters: { allowed_merge_methods: ["squash"] } }]]);
  await assert.rejects(mergePr(fake.run, { ...ref, expected, method: "merge" }), /no longer allowed/);
  assert.equal(fake.calls[1].args.at(-1), "repos/o/r/rules/branches/main?per_page=100");
  assert.equal(fake.calls.filter((call) => call.args.includes("PUT")).length, 0);
  await assert.rejects(readMergeOptions(stub([repository()], new Error("Branch rules unavailable")).run, ref), /Branch rules unavailable/);
});
