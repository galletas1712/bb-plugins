import assert from "node:assert/strict";
import { test } from "node:test";
import { withGitHubBackoff } from "./github-rate-limit";

const ok = { stdout: '{"data":{"ok":true}}', stderr: "", code: 0 };
const limited = { stdout: '{"errors":[{"type":"RATE_LIMITED","message":"API rate limit already exceeded"}]}', stderr: "", code: 0 };
const headers = (status: number, values: Record<string, string>, body: string) => `HTTP/2.0 ${status} Response\n${Object.entries(values).map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n${body}`;
function fixture() {
  let time = Date.UTC(2026, 9, 17);
  const calls: { cmd: string; args: string[]; options: unknown }[] = [];
  let respond: () => Promise<typeof ok> = async () => ok;
  const run = withGitHubBackoff(async (cmd, args, options) => { calls.push({ cmd, args, options }); return respond(); }, { now: () => time, random: () => 0 });
  return { run, calls, advance: (ms: number) => { time += ms; }, now: () => time, respond: (fn: typeof respond) => { respond = fn; } };
}
const api = ["api", "graphql", "--input", "-"];

test("rate limits back off exponentially to 15 minutes, then reset after recovery", async () => {
  const f = fixture();
  f.respond(async () => limited);
  for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
    await assert.rejects(f.run("gh", api), /rate limit/);
    const count = f.calls.length;
    f.advance(delay - 1);
    await assert.rejects(f.run("gh", api, { allowFailure: true }), /Requests paused/);
    assert.equal(f.calls.length, count);
    f.advance(1);
  }
  f.respond(async () => ok);
  assert.deepEqual(await f.run("gh", api), ok);
  f.respond(async () => limited);
  await assert.rejects(f.run("gh", api), /rate limit/);
  f.advance(60_000);
  f.respond(async () => ok);
  assert.deepEqual(await f.run("gh", api), ok);
});

test("respects Retry-After and primary reset, including GraphQL HTTP 200 errors", async () => {
  for (const [status, values, delay] of [
    [429, { "Retry-After": "300" }, 300_000],
    [403, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Date.UTC(2026, 9, 17) / 1000 + 3600) }, 3_600_000],
    [200, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Date.UTC(2026, 9, 17) / 1000 + 1800) }, 1_800_000],
    [429, { "Retry-After": new Date(Date.UTC(2026, 9, 17) + 600_000).toUTCString() }, 600_000],
  ] as [number, Record<string, string>, number][]) {
    const f = fixture();
    f.respond(async () => ({ ...limited, stdout: headers(status, values, limited.stdout) }));
    await assert.rejects(f.run("gh", api), /rate limit/);
    f.advance(delay - 1);
    await assert.rejects(f.run("gh", api), /Requests paused/);
    assert.equal(f.calls.length, 1);
    f.advance(1);
    f.respond(async () => ok);
    await f.run("gh", api);
    assert.equal(f.calls.length, 2);
  }
});

test("ordinary permission failures and rate-limit text inside successful comments do not pause GitHub", async () => {
  const f = fixture();
  const forbidden = { stdout: headers(403, {}, '{"message":"Resource not accessible by integration"}'), stderr: "gh: forbidden (HTTP 403)", code: 1 };
  f.respond(async () => forbidden);
  assert.equal((await f.run("gh", api, { allowFailure: true })).code, 1);
  await assert.rejects(f.run("gh", api), /Resource|forbidden/);
  f.respond(async () => ({ ...ok, stdout: headers(200, {}, JSON.stringify({ body: "API rate limit exceeded\n[HTTP/2.0 403 Forbidden\nX-Test: x\n\n" })) }));
  assert.deepEqual(JSON.parse((await f.run("gh", api)).stdout), { body: "API rate limit exceeded\n[HTTP/2.0 403 Forbidden\nX-Test: x\n\n" });
  assert.equal(f.calls.length, 3);
  f.respond(async () => ({ ...ok, stdout: '{"errors":[{"message":"Could not resolve repository o/rate-limit-demo"}]}' }));
  await f.run("gh", api);
  await f.run("gh", api);
});

test("GitHub error codes, HTTP 429 without headers, and jitter are supported", async () => {
  for (const result of [
    { ...limited, stdout: '{"errors":[{"type":"RATE_LIMIT","code":"graphql_rate_limit"}]}' },
    { stdout: "", stderr: "HTTP 429", code: 1 },
  ]) {
    let time = Date.UTC(2026, 9, 17);
    let calls = 0;
    const run = withGitHubBackoff(async () => { calls++; return result; }, { now: () => time, random: () => 0.5 });
    await assert.rejects(run("gh", api), /Requests paused/);
    time += 62_999;
    await assert.rejects(run("gh", api), /Requests paused/);
    assert.equal(calls, 1);
    time++;
    await assert.rejects(run("gh", api), /Requests paused/);
    assert.equal(calls, 2);
  }
});

test("preserves paginated slurp bodies, empty mutation responses, and stdin", async () => {
  const f = fixture();
  f.respond(async () => ({ ...ok, stdout: `[${headers(200, {}, '[{"body":"first"}]')}\n,${headers(200, {}, '[{"body":"second"}]')}]` }));
  const result = await f.run("gh", ["api", "--paginate", "--slurp", "repos/o/r/issues/1/comments"], { input: "original input" });
  assert.deepEqual(JSON.parse(result.stdout), [[{ body: "first" }], [{ body: "second" }]]);
  assert.ok(f.calls[0].args.includes("--include"));
  assert.deepEqual(f.calls[0].options, { input: "original input", allowFailure: true });
  f.respond(async () => ({ ...ok, stdout: headers(204, {}, "") }));
  assert.equal((await f.run("gh", ["api", "-X", "DELETE", "repos/o/r/comments/1"])).stdout, "");
});

test("failed pagination and headerless gh commands trigger the same gate, while git still works", async () => {
  for (const [args, result] of [
    [["api", "--paginate", "--slurp", "repos/o/r/issues/1/comments"], { stdout: `[${headers(200, {}, "[]")},${headers(429, { "Retry-After": "120" }, '{"message":"secondary rate limit"}')}`, stderr: "gh: secondary rate limit", code: 1 }],
    [["pr", "view", "1"], { stdout: "", stderr: "GraphQL: API rate limit already exceeded", code: 1 }],
  ] as [string[], typeof ok][]) {
    const f = fixture();
    f.respond(async () => result);
    await assert.rejects(f.run("gh", args, { allowFailure: true }), /Requests paused/);
    await assert.rejects(f.run("gh", ["repo", "view", "o/r"]), /Requests paused/);
    assert.equal(f.calls.length, 1);
    f.respond(async () => ok);
    await f.run("git", ["diff"]);
    assert.equal(f.calls.length, 2);
  }
});

test("concurrent failures coalesce, earlier successes cannot reset the pause, and only one probe runs", async () => {
  const f = fixture();
  const pending: ((result: typeof ok) => void)[] = [];
  f.respond(() => new Promise((resolve) => pending.push(resolve)));
  const first = f.run("gh", api);
  const second = f.run("gh", api);
  const third = f.run("gh", api);
  pending[0](limited);
  await assert.rejects(first, /rate limit/);
  pending[1](limited);
  await assert.rejects(second, /rate limit/);
  pending[2](ok);
  await third;
  await assert.rejects(f.run("gh", api), /Requests paused/);
  f.advance(60_000);
  const probe = f.run("gh", api);
  await assert.rejects(f.run("gh", api), /Requests paused/);
  assert.equal(f.calls.length, 4);
  pending[3](ok);
  await probe;
  f.respond(async () => ok);
  await f.run("gh", api);
  assert.equal(f.calls.length, 5);
});

test("last successful request can exhaust quota without losing its data, and mutations are never replayed", async () => {
  const f = fixture();
  f.respond(async () => ({ ...ok, stdout: headers(200, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(f.now() / 1000 + 3600) }, ok.stdout) }));
  assert.deepEqual(await f.run("gh", api), ok);
  await assert.rejects(f.run("gh", ["api", "-X", "PUT", "repos/o/r/pulls/1/merge"]), /Requests paused/);
  assert.equal(f.calls.length, 1);
  f.advance(3_600_000);
  f.respond(async () => limited);
  await assert.rejects(f.run("gh", ["api", "-X", "PUT", "repos/o/r/pulls/1/merge"]), /Requests paused/);
  assert.equal(f.calls.length, 2);
});
