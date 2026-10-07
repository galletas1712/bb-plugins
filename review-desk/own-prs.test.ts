import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchOwnPullRequests } from "./own-prs";
import type { GhRun } from "./stack-fetch";

const node = (number: number, repo = "r") => ({ number, title: `PR ${number}`, state: "OPEN", isDraft: number === 2, headRefOid: `head-${number}`, additions: number, deletions: 0, reviewDecision: number === 2 ? "APPROVED" : null, updatedAt: "2026-10-07T00:00:00Z", repository: { name: repo, owner: { login: "o" } } });
const page = (nodes: unknown[], cursor: string | null = null, login = "viewer") => ({ stdout: JSON.stringify({ data: { viewer: { login, pullRequests: { nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } } } } }), stderr: "", code: 0 });

test("authored discovery includes drafts across repos and every page beyond search's 1000-result cap", async () => {
  let pages = 0;
  const run: GhRun = async (_cmd, args) => {
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
  const result = await fetchOwnPullRequests(async () => page([node(1), node(1), node(1, "other"), { ...node(2), state: "CLOSED" }, { ...node(3), state: "MERGED" }]));
  assert.deepEqual(result.prs.map((pr) => `${pr.repo}#${pr.number}`), ["r#1", "other#1"]);
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
