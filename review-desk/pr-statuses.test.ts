import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchPrStatuses } from "./pr-statuses";

const status = (number: number) => ({ number, title: `PR ${number}`, body: "Description", state: "OPEN", isDraft: false, url: `https://github.com/o/r/pull/${number}`, author: { login: "me" }, baseRefName: "main", headRefName: `branch-${number}`, headRefOid: `head-${number}`, baseRefOid: "base", additions: 1, deletions: 0, changedFiles: 1, reviewDecision: null, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", updatedAt: "2026-10-15T00:00:00Z", createdAt: "2026-10-01T00:00:00Z" });

test("one scalar query scans a batch across repositories and retains closed and reopened states", async () => {
  const refs = Array.from({ length: 50 }, (_, i) => ({ owner: "o", repo: i % 2 ? "other" : "r", number: i + 1 }));
  let calls = 0;
  const result = await fetchPrStatuses(async (cmd, args) => {
    calls++; assert.equal(cmd, "gh"); assert.ok(args.includes("graphql"));
    const query = args.find((arg) => arg.startsWith("query="))!;
    assert.equal((query.match(/pullRequest\(number:/g) ?? []).length, 50);
    assert.match(query, /mergeStateStatus/);
    assert.ok(!query.includes("commits(") && !query.includes("files("));
    return { stdout: JSON.stringify({ data: Object.fromEntries(refs.map((pr, i) => [`r${i}`, { pullRequest: { ...status(pr.number), state: i === 0 ? "CLOSED" : i === 1 ? "MERGED" : "OPEN" } }])) }), stderr: "", code: 0 };
  }, refs);
  assert.equal(calls, 1);
  assert.equal(result.prs[0].mergeStateStatus, "CLEAN");
  assert.equal(result.prs[0].state, "CLOSED"); assert.equal(result.prs[1].state, "MERGED");
  assert.equal(result.prs[2].state, "OPEN"); assert.equal(result.prs[1].repo, "other");
});

test("failed scans do not misclassify missing PRs and inaccessible PRs do not block the rest of a batch", async () => {
  const refs = [{ owner: "o", repo: "r", number: 1 }];
  await assert.rejects(fetchPrStatuses(async () => ({ stdout: "", stderr: "GitHub unavailable", code: 1 }), refs), /GitHub unavailable/);
  await assert.rejects(fetchPrStatuses(async () => ({ stdout: JSON.stringify({ errors: [{ message: "Forbidden" }] }), stderr: "", code: 1 }), refs), /Forbidden/);
  const partial = await fetchPrStatuses(async () => ({ stdout: JSON.stringify({ data: { r0: null, r1: { pullRequest: status(2) } }, errors: [{ message: "Forbidden" }] }), stderr: "", code: 1 }), [...refs, { ...refs[0], number: 2 }]);
  assert.deepEqual(partial.prs.map((pr) => pr.number), [2]);
  assert.ok(partial.errors.some((error) => error.includes("Forbidden")));
  assert.ok(partial.errors.some((error) => error.includes("o/r#1")));
});
