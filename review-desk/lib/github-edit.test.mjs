import assert from "node:assert/strict";
import { test } from "node:test";
import { commentPermissions, editBody, readDescription } from "./github-edit.ts";

const pr = { owner: "Owner", repo: "Repo", number: 7 };
const node = (type, body = "Original", viewerCanUpdate = true) => ({ id: "node-id", __typename: type, body, viewerCanUpdate, viewerDidAuthor: true, scope: { number: 7, repository: { nameWithOwner: "owner/repo" } } });
const stub = (responses) => {
  const calls = [];
  return { calls, run: async (cmd, args, options) => {
    calls.push({ cmd, args, payload: JSON.parse(options.input) });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, "unexpected GitHub request");
    return { stdout: JSON.stringify(response) };
  } };
};

for (const [kind, type, inputType, idField] of [
  ["comment", "IssueComment", "UpdateIssueCommentInput", "id"],
  ["review", "PullRequestReview", "UpdatePullRequestReviewInput", "pullRequestReviewId"],
  ["inline", "PullRequestReviewComment", "UpdatePullRequestReviewCommentInput", "pullRequestReviewCommentId"],
]) test(`editing ${kind} checks the PR and routes to its GitHub mutation`, async () => {
  const fake = stub([{ data: { node: node(type) } }, { data: { edit: { updated: { body: "Saved" } } } }]);
  const result = await editBody(fake.run, { ...pr, target: { kind, id: "node-id" }, body: "Saved", expectedBody: "Original" });
  assert.deepEqual(result, { body: "Saved" });
  assert.ok(fake.calls[1].payload.query.includes(inputType));
  assert.deepEqual(fake.calls[1].payload.variables.input, { [idField]: "node-id", body: "Saved" });
  assert.deepEqual(fake.calls[1].args, ["api", "graphql", "--input", "-"]);
});

test("description editing supports an empty description", async () => {
  const fake = stub([{ data: { repository: { pullRequest: node("PullRequest") } } }, { data: { edit: { updated: { body: "" } } } }]);
  assert.deepEqual(await editBody(fake.run, { ...pr, target: { kind: "description" }, body: "", expectedBody: "Original" }), { body: "" });
  assert.deepEqual(fake.calls[1].payload.variables.input, { pullRequestId: "node-id", body: "" });
});

test("fresh permission and external edits prevent mutations", async () => {
  for (const [current, message] of [[node("IssueComment", "Original", false), /cannot edit/], [node("IssueComment", "Changed externally"), /changed on GitHub/]]) {
    const fake = stub([{ data: { node: current } }]);
    await assert.rejects(editBody(fake.run, { ...pr, target: { kind: "comment", id: "node-id" }, body: "Saved", expectedBody: "Original" }), message);
    assert.equal(fake.calls.length, 1);
  }
});

test("maintainer permissions cannot edit another author's comments, reviews, or replies", async () => {
  for (const [kind, type] of [["comment", "IssueComment"], ["review", "PullRequestReview"], ["inline", "PullRequestReviewComment"]]) {
    const fake = stub([{ data: { node: { ...node(type), viewerDidAuthor: false } } }]);
    await assert.rejects(editBody(fake.run, { ...pr, target: { kind, id: "node-id" }, body: "Saved", expectedBody: "Original" }), /only edit your own comments/);
    assert.equal(fake.calls.length, 1);
  }
});

test("wrong type, PR, repository, or missing comment prevents mutations", async () => {
  for (const current of [null, node("PullRequestReview"), { ...node("IssueComment"), scope: { number: 8, repository: { nameWithOwner: "owner/repo" } } }, { ...node("IssueComment"), scope: { number: 7, repository: { nameWithOwner: "elsewhere/repo" } } }]) {
    const fake = stub([{ data: { node: current } }]);
    await assert.rejects(editBody(fake.run, { ...pr, target: { kind: "comment", id: "node-id" }, body: "Saved", expectedBody: "Original" }), /does not belong/);
    assert.equal(fake.calls.length, 1);
  }
});

test("blank comments are rejected but literal Markdown is preserved", async () => {
  const empty = stub([{ data: { node: node("IssueComment") } }]);
  await assert.rejects(editBody(empty.run, { ...pr, target: { kind: "comment", id: "node-id" }, body: " \n", expectedBody: "Original" }), /cannot be empty/);
  assert.equal(empty.calls.length, 1);
  const markdown = '  ```sh\n$(secret) `literal`\n```\n';
  const fake = stub([{ data: { node: node("IssueComment") } }, { data: { edit: { updated: { body: markdown } } } }]);
  await editBody(fake.run, { ...pr, target: { kind: "comment", id: "node-id" }, body: markdown, expectedBody: "Original" });
  assert.equal(fake.calls[1].payload.variables.input.body, markdown);
});

test("GitHub API errors propagate without reporting success", async () => {
  const fake = stub([{ data: { node: node("IssueComment") } }, { errors: [{ message: "GitHub rejected the edit" }], data: null }]);
  await assert.rejects(editBody(fake.run, { ...pr, target: { kind: "comment", id: "node-id" }, body: "Saved", expectedBody: "Original" }), /GitHub rejected/);
});

test("description permissions use the current gh identity", async () => {
  const fake = stub([{ data: { repository: { pullRequest: node("PullRequest", "Body", false) } } }]);
  assert.deepEqual(await readDescription(fake.run, pr), { body: "Body", canEdit: false });
  assert.deepEqual(fake.calls[0].payload.variables, pr);
});

test("comment permissions batch old history and handle deleted nodes", async () => {
  const ids = Array.from({ length: 101 }, (_, index) => `id-${index}`);
  const fake = stub([{ data: { nodes: [{ id: "id-0", viewerCanUpdate: true, viewerDidAuthor: true }, { id: "id-1", viewerCanUpdate: true, viewerDidAuthor: false }, null] } }, { data: { nodes: [{ id: "id-100", viewerCanUpdate: false, viewerDidAuthor: true }] } }]);
  const permissions = await commentPermissions(fake.run, ids);
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].payload.variables.ids.length, 100);
  assert.deepEqual(fake.calls[1].payload.variables.ids, ["id-100"]);
  assert.equal(permissions.get("id-0"), true);
  assert.equal(permissions.get("id-1"), false);
  assert.equal(permissions.get("id-100"), false);
});
