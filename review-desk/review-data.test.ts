import assert from "node:assert/strict";
import { test } from "node:test";
import { hunkLineNumbers } from "./diff-lines.ts";
import { fetchConversation, fetchPrMetadata, fetchReviewThreads } from "./github-conversation.ts";

test("hunk lines stop at declared lengths and do not count file headers or a trailing newline", () => {
  const lines = hunkLineNumbers("--- a/file\n+++ b/file\n@@ -10,2 +10,2 @@\n unchanged\n-before\n+after\n\n");
  assert.deepEqual([...lines.old], [10, 11]);
  assert.deepEqual([...lines.new], [10, 11]);
  assert.equal(lines.new.has(12), false);
});

test("diff content beginning with ++ or -- remains a valid comment anchor", () => {
  const lines = hunkLineNumbers("@@ -1 +1 @@\n---old\n+++new\n\\ No newline at end of file\n");
  assert.deepEqual([...lines.old], [1]);
  assert.deepEqual([...lines.new], [1]);
  const added = hunkLineNumbers("@@ -0,0 +1,2 @@\n+one\n+two\n");
  assert.deepEqual([...added.old], []);
  assert.deepEqual([...added.new], [1, 2]);
});

const pageInfo = (endCursor: string | null = null) => ({ hasNextPage: endCursor !== null, endCursor });
const comment = (n: number) => ({ id: `C${n}`, databaseId: String(n), viewerCanUpdate: n === 101, author: n === 101 ? null : { login: "reviewer" }, body: `<!-- raw -->\nComment ${n}\n<details>Details</details>`, createdAt: "2026-09-29T00:00:00Z", url: `https://github.com/o/r/pull/1#discussion_r${n}` });
const thread = (id: string) => ({
  id, isResolved: false, isOutdated: false, path: "src/file.ts", line: 30, originalLine: 20,
  startLine: 28, originalStartLine: 18, diffSide: "LEFT", startDiffSide: "LEFT", subjectType: "LINE",
  comments: { pageInfo: pageInfo(), nodes: [comment(1)] },
});

test("review threads paginate both threads and replies and preserve GitHub coordinates and raw bodies", async () => {
  const calls: string[][] = [];
  const run = async (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args.includes("id=T1")) {
      assert.ok(args.includes("commentAfter=replies-100"));
      return { stdout: JSON.stringify({ data: { node: { comments: { pageInfo: pageInfo(), nodes: [comment(101)] } } } }) };
    }
    const secondPage = args.includes("after=threads-100");
    const nodes = secondPage
      ? [{ ...thread("T2"), subjectType: "FILE", line: null, originalLine: null, startLine: null, originalStartLine: null, startDiffSide: null, isResolved: true }]
      : [{ ...thread("T1"), isOutdated: true, comments: { pageInfo: pageInfo("replies-100"), nodes: Array.from({ length: 100 }, (_, i) => comment(i + 1)) } }];
    return { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: pageInfo(secondPage ? null : "threads-100"), nodes } } } } }) };
  };
  const threads = await fetchReviewThreads(run, "true", "123", 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[0][calls[0].indexOf("owner=true") - 1], "-f");
  assert.equal(calls[0][calls[0].indexOf("repo=123") - 1], "-f");
  assert.equal(calls[0][calls[0].indexOf("number=1") - 1], "-F");
  assert.equal(threads.length, 2);
  assert.equal(threads[0].comments.length, 101);
  assert.equal(threads[0].comments[100].body, comment(101).body);
  assert.equal(threads[0].comments[100].author, "ghost");
  assert.equal(threads[0].comments[100].databaseId, 101);
  assert.equal(threads[0].comments[100].canEdit, true);
  assert.equal(threads[0].side, "LEFT");
  assert.equal(threads[0].startSide, "LEFT");
  assert.equal(threads[0].line, 30);
  assert.equal(threads[0].originalLine, 20);
  assert.equal(threads[0].originalStartLine, 18);
  assert.equal(threads[0].isOutdated, true);
  assert.equal(threads[1].subjectType, "FILE");
  assert.equal(threads[1].line, null);
  assert.equal(threads[1].isResolved, true);
});

test("invalid GitHub pagination fails instead of silently truncating or looping forever", async () => {
  const run = async () => ({ stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: pageInfo("same"), nodes: [] } } } } }) });
  await assert.rejects(fetchReviewThreads(run, "o", "r", 1), /invalid pagination cursor/);
});

test("conversation includes all REST pages and leaves published review text untouched", async () => {
  const raw = "<!-- author comment -->\n## Summary\n<details><summary>More</summary>Full text</details>";
  const issueComment = { id: 1, node_id: "IC1", user: { login: "author" }, body: raw, created_at: "2026-09-29T00:00:00Z", html_url: "https://github.com/o/r/pull/1#issuecomment-1" };
  const review = { id: 2, node_id: "R2", user: { login: "reviewer" }, body: raw, state: "COMMENTED", submitted_at: "2026-09-29T00:00:00Z", html_url: "https://github.com/o/r/pull/1#pullrequestreview-2" };
  const run = async (_cmd: string, args: string[]) => {
    if (args.includes("graphql")) return { stdout: JSON.stringify({ data: { nodes: [{ id: "IC1", viewerCanUpdate: true }, { id: "R2", viewerCanUpdate: false }] } }) };
    assert.ok(args.includes("--paginate"));
    assert.ok(args.includes("--slurp"));
    if (args.at(-1)?.includes("/timeline?")) {
      const event = { event: "labeled", actor: { login: "author" }, label: { name: "bug" }, created_at: "2026-09-29T00:00:00Z" };
      return { stdout: JSON.stringify([Array.from({ length: 100 }, (_, id) => ({ ...event, id })), [{ ...event, id: 100 }, { ...event, id: 101, event: "commented" }]]) };
    }
    return { stdout: JSON.stringify(args.at(-1)?.includes("/issues/") ? [[issueComment], [{ ...issueComment, id: 3 }]] : [[review], [{ ...review, id: 4 }, { ...review, id: 5, state: "PENDING" }]]) };
  };
  const conversation = await fetchConversation(run, "o", "r", 1);
  assert.deepEqual(conversation.comments.map((c) => c.id), [1, 3]);
  assert.deepEqual(conversation.reviews.map((r) => r.id), [2, 4]);
  assert.equal(conversation.comments[0].body, raw);
  assert.equal(conversation.comments[0].nodeId, "IC1");
  assert.equal(conversation.comments[0].canEdit, true);
  assert.equal(conversation.reviews[0].canEdit, false);
  assert.equal(conversation.reviews[1].body, raw);
  assert.equal(conversation.events.length, 101);
  assert.equal(conversation.events[100].details, "bug");
  assert.equal(conversation.events[100].actor, "author");
});

test("metadata fetches more than 250 commits and every page of labels, requests and checks", async () => {
  const commits = (start: number) => Array.from({ length: 100 }, (_, index) => ({ commit: { oid: `sha${start + index}`, messageHeadline: `Commit ${start + index}`, committedDate: "2026-09-29T00:00:00Z", author: { name: "Author", user: { login: "author" } } } }));
  const connection = <T,>(nodes: T[], cursor: string | null = null) => ({ nodes, pageInfo: pageInfo(cursor) });
  const checks = (cursor: string | null) => ({ headCommit: { nodes: [{ commit: { statusCheckRollup: { contexts: connection([{ name: cursor ? "build" : "lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null }], cursor) } } }] } });
  const run = async (_cmd: string, args: string[]) => {
    let pr;
    if (args.includes("after=commits-100")) pr = { commits: connection(commits(100), "commits-200") };
    else if (args.includes("after=commits-200")) pr = { commits: connection(commits(200)) };
    else if (args.includes("after=labels-100")) pr = { labels: connection([{ name: "last label" }]) };
    else if (args.includes("after=requests-100")) pr = { reviewRequests: connection([{ requestedReviewer: { name: "review team" } }]) };
    else if (args.includes("after=checks-100")) pr = checks(null);
    else pr = {
      commits: connection(commits(0), "commits-100"),
      labels: connection(Array.from({ length: 100 }, (_, n) => ({ name: `label-${n}` })), "labels-100"),
      assignees: connection([{ login: "author" }]),
      latestReviews: connection([{ author: { login: "reviewer" }, state: "APPROVED" }]),
      reviewRequests: connection([{ requestedReviewer: { login: "reviewer" } }], "requests-100"),
      ...checks("checks-100"),
    };
    return { stdout: JSON.stringify({ data: { repository: { pullRequest: pr } } }) };
  };
  const metadata = await fetchPrMetadata(run, "o", "r", 1);
  assert.equal(metadata.commits.length, 300);
  assert.equal(metadata.commits[299].sha, "sha299");
  assert.equal(metadata.labels.length, 101);
  assert.equal(metadata.checks.length, 2);
  assert.deepEqual(metadata.assignees, ["author"]);
  assert.deepEqual(metadata.reviewers, [{ login: "reviewer", state: "REQUESTED" }, { login: "review team", state: "REQUESTED" }]);
});

test("a failed timeline request fails the conversation fetch instead of returning partial data", async () => {
  const run = async (_cmd: string, args: string[]) => {
    if (args.at(-1)?.includes("/timeline?")) throw new Error("GitHub rate limit");
    return { stdout: "[[]]" };
  };
  await assert.rejects(fetchConversation(run, "o", "r", 1), /GitHub rate limit/);
});
