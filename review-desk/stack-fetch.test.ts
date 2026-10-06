import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchPullRequestStack, type GhRun } from "./stack-fetch.ts";

const pageInfo = (endCursor: string | null = null) => ({ hasNextPage: endCursor !== null, endCursor });
const result = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "", code: 0 });
const variable = (args: string[], name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const pr = (number: number) => ({
  number, title: `PR ${number}`, state: "OPEN", isDraft: false, url: `https://github.com/o/r/pull/${number}`,
  additions: 1, deletions: 0, changedFiles: 1, reviewDecision: null,
  headRefName: `branch-${number}`, headRefOid: `sha-${number}`, baseRefName: number === 1 ? "main" : `branch-${number - 1}`, mergedAt: null,
  files: { pageInfo: pageInfo(), nodes: [{ path: `file-${number}.ts` }] },
});
const stackPage = (number: number, after: string | null, pullRequest = pr(number)) => result({
  data: { repository: { pullRequest: { stack: {
    number: 7, baseRefName: "main", entries: {
      pageInfo: pageInfo(after), nodes: [{ position: number, pullRequest }],
    },
  } } } },
});
const input = { owner: "o", repo: "r", number: 1, stackNumber: null };

test("native stacks fetch beyond five pages and paginate files inside each layer", async () => {
  const run: GhRun = async (_cmd, args) => {
    const query = variable(args, "query") ?? "";
    const after = variable(args, "after");
    if (query.includes("files(first: 100, after:")) {
      assert.equal(after, "files-100");
      return result({ data: { repository: { pullRequest: { files: {
        pageInfo: pageInfo(), nodes: [{ path: "file-101.ts" }],
      } } } } });
    }
    const number = after ? Number(after) + 1 : 1;
    const entry = number === 1 ? {
      ...pr(1), title: "Improve stacked pull requests", changedFiles: 101,
      files: { pageInfo: pageInfo("files-100"), nodes: Array.from({ length: 100 }, (_, i) => ({ path: `file-${i + 1}.ts` })) },
    } : pr(number);
    return stackPage(number, number === 6 ? null : String(number), entry);
  };
  const stack = await fetchPullRequestStack(run, input);
  assert.deepEqual(stack?.entries.map((entry) => entry.number), [1, 2, 3, 4, 5, 6]);
  assert.equal(stack?.entries[0].files.length, 101);
  assert.equal(stack?.entries[0].files.at(-1), "file-101.ts");
});

test("native stack and nested file pagination reject repeating cursors", async () => {
  await assert.rejects(fetchPullRequestStack(async () => stackPage(1, "same"), input), /invalid pagination cursor/);
  const run: GhRun = async (_cmd, args) => {
    if ((variable(args, "query") ?? "").includes("files(first: 100, after:")) {
      return result({ data: { repository: { pullRequest: { files: {
        pageInfo: pageInfo("same"), nodes: [],
      } } } } });
    }
    return stackPage(1, null, { ...pr(1), files: { pageInfo: pageInfo("same"), nodes: [] } });
  };
  await assert.rejects(fetchPullRequestStack(run, input), /invalid pagination cursor/);
});

test("REST fallback paginates, tolerates unavailable API versions, and fetches every PR's review decision", async () => {
  const viewedPrs: number[] = [];
  const run: GhRun = async (_cmd, args) => {
    if (args.includes("graphql")) return result({ errors: [{ message: "Cannot query field 'stack' on type 'PullRequest'" }] });
    if (args[0] === "pr") {
      const number = Number(args[2]);
      viewedPrs.push(number);
      assert.ok(args[args.indexOf("--json") + 1].split(",").includes("reviewDecision"));
      return result({ ...pr(number), changedFiles: 2, reviewDecision: number === 2 ? "APPROVED" : null });
    }
    if (args.some((arg) => arg.startsWith("X-GitHub-Api-Version:"))) return { stdout: "", stderr: "Unsupported API version", code: 1 };
    assert.ok(args.includes("--paginate"));
    assert.ok(args.includes("--slurp"));
    if (args.some((arg) => arg.includes("/files?"))) {
      return result([[{ filename: "first.ts" }], [{ filename: "last.ts" }]]);
    }
    const pull_requests = [1, 2].map((number) => ({
      number, title: `PR ${number}`, state: "open", draft: false, merged_at: null,
      html_url: `https://github.com/o/r/pull/${number}`, additions: 1, deletions: 0, changed_files: 2,
      head: { ref: `branch-${number}`, sha: `sha-${number}` }, base: { ref: "main" },
    }));
    return args.includes("repos/o/r/stacks/7")
      ? result(pull_requests.map((pr) => ({ number: 7, base: { ref: "main" }, pull_requests: [pr] })))
      : result([[{ number: 7, base: { ref: "main" }, pull_requests }]]);
  };
  const stack = await fetchPullRequestStack(run, input);
  assert.equal(stack?.source, "github");
  assert.equal(stack?.entries.length, 2);
  assert.deepEqual(stack?.entries[1].files, ["first.ts", "last.ts"]);
  assert.deepEqual(stack?.entries.map((entry) => entry.reviewDecision), [null, "APPROVED"]);
  assert.deepEqual(viewedPrs.sort(), [1, 2]);
  viewedPrs.length = 0;
  const explicit = await fetchPullRequestStack(run, { ...input, number: null, stackNumber: 7 });
  assert.deepEqual(explicit?.entries.map((entry) => entry.number), [1, 2]);
  assert.equal(explicit?.entries[1].reviewDecision, "APPROVED");
  assert.deepEqual(viewedPrs.sort(), [1, 2]);
  const failedDecision: GhRun = (cmd, args, options) => args[0] === "pr" && args[2] === "2"
    ? Promise.resolve({ stdout: "", stderr: "GitHub unavailable", code: 1 })
    : run(cmd, args, options);
  await assert.rejects(fetchPullRequestStack(failedDecision, input), /Could not fetch PR #2 in the stack/);
});

test("inferred stacks search every connection page and walk past forty linked PRs", async () => {
  const run: GhRun = async (_cmd, args) => {
    const query = variable(args, "query") ?? "";
    if (args[0] === "pr") return result(pr(1));
    if (args[0] === "repo") return result({ defaultBranchRef: { name: "main" } });
    if (query.includes("stack {")) return result({ errors: [{ message: "Cannot query field 'stack' on type 'PullRequest'" }] });
    if (query.includes("pullRequests(")) {
      const current = Number(variable(args, "ref")?.replace("branch-", ""));
      const second = variable(args, "after") === "next";
      return result({ data: { repository: { pullRequests: {
        pageInfo: pageInfo(!second && current < 42 ? "next" : null),
        nodes: second && current < 42 ? [pr(current + 1)] : [],
      } } } });
    }
    if (args.some((arg) => arg.includes("/files?"))) {
      assert.ok(args.includes("--paginate"));
      return result([[{ filename: "file.ts" }]]);
    }
    return { stdout: "", stderr: "404 Not Found", code: 1 };
  };
  const stack = await fetchPullRequestStack(run, input);
  assert.equal(stack?.source, "inferred");
  assert.equal(stack?.entries.length, 42);
  assert.equal(stack?.entries.at(-1)?.number, 42);
});

test("a failed later file page is surfaced rather than treated as a complete stack", async () => {
  const run: GhRun = async (_cmd, args) => {
    if ((variable(args, "query") ?? "").includes("files(first: 100, after:")) {
      return result({ errors: [{ message: "Rate limit exceeded" }] });
    }
    return stackPage(1, null, { ...pr(1), files: { pageInfo: pageInfo("next"), nodes: [] } });
  };
  await assert.rejects(fetchPullRequestStack(run, input), /Could not fetch all files.*Rate limit exceeded/);
});

test("a native stack remains a stack when only one layer remains", async () => {
  const run: GhRun = async () => stackPage(1, null);
  const found = await fetchPullRequestStack(run, input);
  assert.equal(found?.number, 7);
  assert.equal(found?.entries.length, 1);
});
