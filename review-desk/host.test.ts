import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import host from "./host";
import { diffStats } from "./lib/diff-stats";

test("rename-aware git totals exclude pure moves and count edits to renamed files", async () => {
  const repo = mkdtempSync(join(tmpdir(), "review-desk-moves-"));
  const harness = experimental_createHostEntryHarness(host);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
    writeFileSync(join(repo, "pure.txt"), lines); writeFileSync(join(repo, "edited.txt"), lines + "before\n");
    git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "Base");
    const base = git("rev-parse", "HEAD");
    mkdirSync(join(repo, "new"));
    renameSync(join(repo, "pure.txt"), join(repo, "new/pure.txt"));
    renameSync(join(repo, "edited.txt"), join(repo, "new/edited.txt"));
    writeFileSync(join(repo, "new/edited.txt"), lines + "after\nextra\n");
    git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "Moves and edits");
    const { files } = await harness.experimental_call("git_files", { repoPath: repo, baseSha: base, headSha: git("rev-parse", "HEAD") });
    assert.equal(files.length, 2);
    assert.ok(files.every((file) => file.status === "renamed" && file.oldPath !== null));
    assert.deepEqual(diffStats(files), { additions: 2, deletions: 1 });
    assert.deepEqual(diffStats(files.filter((file) => file.path === "new/pure.txt")), { additions: 0, deletions: 0 });
  } finally { await harness.experimental_dispose(); rmSync(repo, { recursive: true, force: true }); }
});

test("parallel preparations share a repository, read PR revisions without a checkout, and never prune unrelated worktrees", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-desk-prefetch-"));
  const repo = join(root, "repo"); const origin = join(root, "origin");
  mkdirSync(repo); mkdirSync(origin);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const harness = experimental_createHostEntryHarness(host);
  try {
    git(origin, "init", "--bare", "-q");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.com");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git(repo, "add", "."); git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "Base");
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "remote", "add", "origin", origin); git(repo, "push", "origin", "main");
    const unrelated = join(root, "other-tools-worktree");
    git(repo, "worktree", "add", "--detach", unrelated, base);
    rmSync(unrelated, { recursive: true, force: true }); // Simulate a registered path unavailable on this host.
    writeFileSync(join(repo, "file.txt"), "first\n");
    git(repo, "add", "."); git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "First PR");
    const first = git(repo, "rev-parse", "HEAD"); git(repo, "push", "origin", "HEAD:refs/pull/1/head");
    writeFileSync(join(repo, "file.txt"), "second\n");
    git(repo, "add", "."); git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "Second PR");
    const second = git(repo, "rev-parse", "HEAD"); git(repo, "push", "origin", "HEAD:refs/pull/2/head");
    git(repo, "reset", "-q", "--hard", base);
    const prepare = (number: number, headSha: string) => harness.experimental_call("repo_prepare", { repoPath: repo, number, headSha, baseRefName: "main" });
    const results = await Promise.all([prepare(1, first), prepare(2, second)]);
    assert.deepEqual(results, [{ headSha: first, baseSha: base }, { headSha: second, baseSha: base }]);
    const show = (sha: string) => harness.experimental_call("git_show", { repoPath: repo, sha, path: "file.txt" });
    assert.deepEqual(await show(first), { content: "first\n", binary: false });
    assert.deepEqual(await show(second), { content: "second\n", binary: false });
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "base\n", "the checkout is never touched");
    assert.ok(git(repo, "worktree", "list", "--porcelain").includes(`worktree ${unrelated}\n`));
  } finally { await harness.experimental_dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("plugin-owned clones with a checkout become bare in place and keep their objects", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-desk-bare-"));
  const data = join(root, "data"); const origin = join(root, "origin"); const seed = join(root, "seed");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const harness = experimental_createHostEntryHarness(host, { experimental_paths: { dataDir: data, tempDir: join(root, "tmp") } });
  try {
    mkdirSync(origin); mkdirSync(seed); mkdirSync(join(data, "repos"), { recursive: true });
    git(origin, "init", "--bare", "-q");
    git(seed, "init", "-q", "-b", "main");
    git(seed, "config", "user.name", "Test"); git(seed, "config", "user.email", "test@example.com");
    writeFileSync(join(seed, "file.txt"), "base\n");
    git(seed, "add", "."); git(seed, "-c", "commit.gpgsign=false", "commit", "-qm", "Base");
    const base = git(seed, "rev-parse", "HEAD");
    writeFileSync(join(seed, "file.txt"), "head\n");
    git(seed, "-c", "commit.gpgsign=false", "commit", "-qam", "PR");
    const head = git(seed, "rev-parse", "HEAD");
    git(seed, "push", "-q", origin, `${base}:refs/heads/main`, "HEAD:refs/pull/1/head");
    const clone = join(data, "repos", "o__r");
    git(root, "clone", "-q", origin, clone);
    const worktree = join(data, "worktrees", "o__r__1");
    git(clone, "worktree", "add", "-q", "--detach", worktree, base);

    await harness.experimental_call("repo_release", { repoPath: clone, worktree });
    assert.equal(git(clone, "rev-parse", "--is-bare-repository"), "true");
    assert.ok(!existsSync(worktree) && !existsSync(join(clone, ".git")) && !existsSync(join(clone, "file.txt")));
    assert.deepEqual(await harness.experimental_call("repo_clone", { owner: "o", repo: "r", dest: "" }), { repoPath: clone });
    assert.deepEqual(await harness.experimental_call("repo_prepare", { repoPath: clone, number: 1, headSha: head, baseRefName: "main" }), { headSha: head, baseSha: base });

    const interrupted = join(data, "repos", "o__s");
    git(root, "clone", "-q", origin, interrupted);
    renameSync(join(interrupted, ".git"), join(data, "repos", ".o__s.bare"));
    assert.deepEqual(await harness.experimental_call("repo_clone", { owner: "o", repo: "s", dest: "" }), { repoPath: interrupted });
    assert.equal(git(interrupted, "rev-parse", "--is-bare-repository"), "true");
    assert.ok(!existsSync(join(data, "repos", ".o__s.bare")) && !existsSync(join(interrupted, "file.txt")));
  } finally { await harness.experimental_dispose(); rmSync(root, { recursive: true, force: true }); }
});
