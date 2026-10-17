import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchOwnPullRequests } from "./own-prs";
import type { GhRun } from "./stack-fetch";

const node = (number: number, repo = "r") => ({ number, title: `PR ${number}`, state: "OPEN", isDraft: number === 2, headRefOid: `head-${number}`, additions: number, deletions: 0, reviewDecision: number === 2 ? "APPROVED" : null, updatedAt: "2026-10-07T00:00:00Z", repository: { name: repo, owner: { login: "o" } } });
const page = (nodes: unknown[], cursor: string | null = null, login = "viewer") => ({ stdout: JSON.stringify({ data: { viewer: { login, pullRequests: { nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } } } } }), stderr: "", code: 0 });
const requestedPage = (nodes: unknown[], cursor: string | null = null, login = "viewer", issueCount = nodes.length) => ({ stdout: JSON.stringify({ data: { viewer: { login }, requested: { nodes, issueCount, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } } } }), stderr: "", code: 0 });
const requested = (args: string[]) => args.some((arg) => arg.includes("user-review-requested:"));

test("authored discovery includes drafts across repos and every page beyond search's 1000-result cap", async () => {
  let pages = 0;
  const run: GhRun = async (_cmd, args) => {
    if (requested(args)) return requestedPage([]);
    assert.ok(args.includes("graphql"));
    assert.match(args.find((arg) => arg.startsWith("query="))!, /viewer[\s\S]*states: OPEN/);
    const index = Number(args.find((arg) => arg.startsWith("after="))?.slice(6) ?? 0);
    pages++;
    return page(Array.from({ length: 100 }, (_, n) => node(index * 100 + n + 1, index % 2 ? "other" : "r")), index < 10 ? String(index + 1) : null);
  };
  const result = await fetchOwnPullRequests(run);
  assert.equal(pages, 11);
  assert.equal(result.login, "viewer");
  assert.equal(result.prs.length, 1100);
  assert.equal(result.prs[1].isDraft, true);
  assert.equal(result.prs[1].reviewDecision, "APPROVED");
  assert.equal(result.prs[100].repo, "other");
});

test("discovery excludes completed PRs and distinguishes equal PR numbers in different repositories", async () => {
  const result = await fetchOwnPullRequests(async (_cmd, args) => requested(args) ? requestedPage([]) : page([node(1), node(1), node(1, "other"), { ...node(2), state: "CLOSED" }, { ...node(3), state: "MERGED" }]));
  assert.deepEqual(result.prs.map((pr) => `${pr.repo}#${pr.number}`), ["r#1", "other#1"]);
});

test("personal review requests paginate independently and join authored PRs without team requests", async () => {
  const searches: string[] = [];
  const run: GhRun = async (_cmd, args) => {
    if (!requested(args)) return args.includes("after=authored-next") ? page([node(1)]) : page([node(1)], "authored-next");
    const query = args.find((arg) => arg.startsWith("query="))!;
    assert.match(query, /is:pr is:open user-review-requested:@me/);
    assert.doesNotMatch(query, /[\s"]review-requested:|team-review-requested:|review-involves:/);
    searches.push(query);
    if (args.includes("after=next")) return requestedPage([node(3, "other"), { ...node(4), state: "CLOSED" }, { ...node(5), state: "MERGED" }]);
    assert.equal(args.some((arg) => arg.startsWith("after=")), false);
    return requestedPage([node(1), node(2)], "next");
  };
  const result = await fetchOwnPullRequests(run);
  assert.equal(searches.length, 2);
  assert.deepEqual(result.prs.map((pr) => `${pr.repo}#${pr.number}`), ["r#1", "r#2", "other#3"]);
  assert.equal(result.prs[1].isDraft, true);
});

test("failed, truncated or invalid requested results never publish a partial discovery snapshot", async () => {
  const discover = (response: GhRun) => fetchOwnPullRequests(async (cmd, args, options) => requested(args) ? response(cmd, args, options) : page([node(1)]));
  await assert.rejects(discover(async () => ({ stdout: "", stderr: "Search unavailable", code: 1 })), /Search unavailable/);
  await assert.rejects(discover(async () => ({ stdout: JSON.stringify({ errors: [{ message: "Forbidden" }] }), stderr: "", code: 0 })), /Forbidden/);
  await assert.rejects(discover(async () => requestedPage([], null, "other-account")), /changed the account/);
  await assert.rejects(discover(async () => requestedPage([node(2)], "repeat")), /invalid pagination cursor/);
  await assert.rejects(discover(async () => requestedPage([node(2)], null, "viewer", 1001)), /1,000 personal review requests/);
  await assert.rejects(discover(async (_cmd, args) => args.includes("after=next")
    ? { stdout: "", stderr: "Second page failed", code: 1 } : requestedPage([node(2)], "next")), /Second page failed/);
});

test("failed or invalid later pages never return an incomplete authored list", async () => {
  const run: GhRun = async (_cmd, args) => args.some((arg) => arg.startsWith("after="))
    ? { stdout: "", stderr: "GitHub unavailable", code: 1 } : page([node(1)], "next");
  await assert.rejects(fetchOwnPullRequests(run), /GitHub unavailable/);
  await assert.rejects(fetchOwnPullRequests(async () => page([node(1)], "repeat")), /invalid pagination cursor/);
  await assert.rejects(fetchOwnPullRequests(async () => ({ stdout: JSON.stringify({ errors: [{ message: "Forbidden" }] }), stderr: "", code: 0 })), /Forbidden/);
  const changingAccount: GhRun = async (_cmd, args) => args.some((arg) => arg.startsWith("after=")) ? page([node(2)], null, "other-viewer") : page([node(1)], "next");
  await assert.rejects(fetchOwnPullRequests(changingAccount), /changed the account/);
});
