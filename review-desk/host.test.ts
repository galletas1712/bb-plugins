import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
    const { files } = await harness.experimental_call("git_files", { worktree: repo, baseSha: base, headSha: git("rev-parse", "HEAD") });
    assert.equal(files.length, 2);
    assert.ok(files.every((file) => file.status === "renamed" && file.oldPath !== null));
    assert.deepEqual(diffStats(files), { additions: 2, deletions: 1 });
    assert.deepEqual(diffStats(files.filter((file) => file.path === "new/pure.txt")), { additions: 0, deletions: 0 });
  } finally { await harness.experimental_dispose(); rmSync(repo, { recursive: true, force: true }); }
});
