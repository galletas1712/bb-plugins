import assert from "node:assert/strict";
import { test } from "node:test";
import { withGitHubCache } from "./github-cache";
import { withGitHubBackoff } from "./github-rate-limit";

const response = (status: number, values: Record<string, string>, body = "") => ({ stdout: `HTTP/2.0 ${status} Response\n${Object.entries(values).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n${body}`, stderr: "", code: status >= 400 ? 1 : 0 });
const path = "repos/o/r/issues/1/comments?per_page=100";
const next = "https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=2";

test("conditional reads restore cached bodies on 304 and replace them after a change", async () => {
  const calls: string[][] = [];
  const results = [response(200, { ETag: '"first"' }, '[{"body":"before"}]'), response(304, {}), response(200, { ETag: '"second"' }, '[{"body":"after"}]'), response(304, {})];
  const run = withGitHubCache(withGitHubBackoff(async (_cmd, args) => { calls.push(args); return results.shift()!; }));
  assert.deepEqual(JSON.parse((await run("gh", ["api", path])).stdout), [{ body: "before" }]);
  assert.deepEqual(JSON.parse((await run("gh", ["api", path])).stdout), [{ body: "before" }]);
  assert.ok(calls[1].includes('If-None-Match: "first"'));
  await run("gh", ["api", path]);
  assert.deepEqual(JSON.parse((await run("gh", ["api", path])).stdout), [{ body: "after" }]);
  assert.ok(calls[3].includes('If-None-Match: "second"'));
});

test("each page has its own ETag, unchanged pages preserve links, and removed pages disappear", async () => {
  const calls: string[][] = [];
  const results = [
    response(200, { ETag: '"page-one"', Link: `<${next}>; rel="next"` }, "[1]"), response(200, { ETag: '"page-two"' }, "[2]"),
    response(304, {}), response(200, { ETag: '"updated-page-two"' }, "[2,3]"),
    response(200, { ETag: '"only-page"' }, "[1]"),
  ];
  const run = withGitHubCache(withGitHubBackoff(async (_cmd, args) => { calls.push(args); return results.shift()!; }));
  const args = ["api", "--paginate", "--slurp", "-H", "X-GitHub-Api-Version: 2026-03-10", path];
  assert.deepEqual(JSON.parse((await run("gh", args)).stdout), [[1], [2]]);
  assert.deepEqual(JSON.parse((await run("gh", args)).stdout), [[1], [2, 3]]);
  assert.ok(calls[2].includes('If-None-Match: "page-one"'));
  assert.ok(calls[3].includes(next));
  assert.ok(calls[3].includes('If-None-Match: "page-two"'));
  assert.ok(calls[3].includes("X-GitHub-Api-Version: 2026-03-10"));
  assert.equal(calls[0].includes("--paginate"), false, "the rate-limit gate sees every individual page");
  assert.deepEqual(JSON.parse((await run("gh", args)).stdout), [[1]]);
  assert.equal(calls.length, 5);
});

test("identical requests share work, but API versions and repository locations do not share bodies", async () => {
  let release!: (value: ReturnType<typeof response>) => void;
  let count = 0;
  const run = withGitHubCache(withGitHubBackoff(async () => { count++; return new Promise((resolve) => { release = resolve; }); }));
  const a = run("gh", ["api", path]); const b = run("gh", ["api", path]);
  assert.equal(count, 1);
  release(response(200, { ETag: '"one"' }, "[]"));
  await Promise.all([a, b]);
  const c = run("gh", ["api", "-H", "X-GitHub-Api-Version: new", path]);
  release(response(200, {}, "[1]")); await c;
  const d = run("gh", ["api", path], { cwd: "/other" });
  release(response(200, {}, "[2]")); await d;
  assert.equal(count, 3);
});

test("conditional pagination obeys shared backoff and never returns a partial refresh on rate limiting", async () => {
  let count = 0;
  const run = withGitHubCache(withGitHubBackoff(async () => {
    count++;
    return count === 1 ? response(200, { ETag: '"one"', Link: `<${next}>; rel="next"` }, "[1]") : response(429, { "Retry-After": "300" }, '{"message":"secondary rate limit"}');
  }));
  await assert.rejects(run("gh", ["api", "--paginate", "--slurp", path]), /Requests paused/);
  await assert.rejects(run("gh", ["api", path], { allowFailure: true }), /Requests paused/);
  assert.equal(count, 2);
});

test("mutations and GraphQL bypass REST caching, errors retain allowFailure semantics", async () => {
  const calls: string[][] = [];
  let result = response(200, { ETag: '"one"' }, "[]");
  const run = withGitHubCache(withGitHubBackoff(async (_cmd, args) => { calls.push(args); return result; }));
  for (const args of [["api", "-X", "PATCH", path], ["api", path, "-f", "body=hello"], ["api", "graphql", "-f", "query={viewer{login}}"]]) {
    await run("gh", args); await run("gh", args);
  }
  assert.equal(calls.some((args) => args.some((arg) => arg.startsWith("If-None-Match:"))), false);
  result = response(403, {}, '{"message":"forbidden"}');
  assert.equal((await run("gh", ["api", path], { allowFailure: true })).code, 1);
  await assert.rejects(run("gh", ["api", path]), /forbidden/);
});
