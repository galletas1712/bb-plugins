import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileDiff, listChanges } from "./changes.js";
import { clone, git, multiRepoProject, remote, useTempDir } from "./test-repos.js";
import { ensureWorkspace } from "./workspace.js";

const temp = useTempDir();

/** A workspace of alpha and beta on bb/task. */
async function workspace() {
  const { project, beta } = multiRepoProject(temp());
  const root = path.join(temp(), "ws");
  await ensureWorkspace({ root, projectPath: project, branch: "bb/task", repos: [{ name: "alpha", from: null }, { name: "beta", from: null }] });
  return { root, alpha: path.join(root, "alpha"), beta: path.join(root, "beta"), betaClone: beta };
}

describe("listChanges", () => {
  it("lists uncommitted changes per repo, including files in new folders and staged renames", async () => {
    const { root, alpha } = await workspace();
    writeFileSync(path.join(alpha, "README.md"), "edited\n");
    mkdirSync(path.join(alpha, "pkg", "deep"), { recursive: true });
    writeFileSync(path.join(alpha, "pkg", "deep", "new.py"), "x = 1\n");
    writeFileSync(path.join(alpha, "staged.txt"), "staged\n");
    git(alpha, "add", "staged.txt");
    git(alpha, "commit", "-q", "-m", "add staged");
    git(alpha, "mv", "staged.txt", "moved.txt");

    const repos = await listChanges(root, "working");

    expect(repos).toEqual([
      {
        name: "alpha",
        branch: "bb/task",
        base: null,
        files: [
          { path: "README.md", oldPath: null, status: "M" },
          { path: "moved.txt", oldPath: "staged.txt", status: "R" },
          { path: "pkg/deep/new.py", oldPath: null, status: "?" },
        ],
        truncated: false,
        error: null,
      },
      { name: "beta", branch: "bb/task", base: null, files: [], truncated: false, error: null },
    ]);
  });

  it("lists what the branch's commits changed since its base", async () => {
    const { root, alpha, beta } = await workspace();
    writeFileSync(path.join(alpha, "feature.ts"), "export {}\n");
    rmSync(path.join(alpha, "README.md"));
    git(alpha, "add", "-A");
    git(alpha, "commit", "-q", "-m", "feature");
    writeFileSync(path.join(alpha, "uncommitted.txt"), "not part of the branch yet\n");

    const [alphaChanges, betaChanges] = await listChanges(root, "branch");

    expect(alphaChanges).toMatchObject({
      branch: "bb/task",
      base: "origin/main",
      files: [
        { path: "README.md", status: "D" },
        { path: "feature.ts", status: "A" },
      ],
    });
    // beta compares against its fork's upstream, which the workspace fetch recorded.
    expect(betaChanges).toMatchObject({ base: "upstream/dev", files: [] });
    expect(git(beta, "rev-parse", "HEAD")).toBe(git(beta, "rev-parse", "upstream/dev"));
  });

  it("compares a branch with the commit it was told to start from", async () => {
    const { project, alpha: alphaClone } = multiRepoProject(temp());
    git(alphaClone, "checkout", "-q", "-b", "feature");
    writeFileSync(path.join(alphaClone, "feature.txt"), "already on the feature branch\n");
    git(alphaClone, "add", ".");
    git(alphaClone, "commit", "-q", "-m", "feature");
    const root = path.join(temp(), "ws");
    await ensureWorkspace({ root, projectPath: project, branch: "bb/task", repos: [{ name: "alpha", from: "feature" }] });
    writeFileSync(path.join(root, "alpha", "new.txt"), "new\n");
    git(path.join(root, "alpha"), "add", ".");
    git(path.join(root, "alpha"), "commit", "-q", "-m", "new");

    const [alpha] = await listChanges(root, "branch");

    expect(alpha).toMatchObject({
      base: `its start ${git(alphaClone, "rev-parse", "feature").slice(0, 10)}`,
      files: [{ path: "new.txt", status: "A" }],
    });
    const patch = await fileDiff({ root, repo: "alpha", path: "new.txt", oldPath: null, mode: "branch", untracked: false });
    expect(patch).toContain("+new");
  });

  it("treats a folder that is itself a repo as one repo", async () => {
    const solo = clone(temp(), remote(temp(), "solo"), path.join(temp(), "solo"));
    writeFileSync(path.join(solo, "README.md"), "edited\n");

    expect(await listChanges(solo, "working")).toMatchObject([
      { name: "solo", files: [{ path: "README.md", status: "M" }] },
    ]);
  });

  it("cuts a huge list short instead of failing every repo", async () => {
    const { root, alpha } = await workspace();
    const deep = path.join(alpha, "node_modules", "x".repeat(200));
    mkdirSync(deep, { recursive: true });
    for (let index = 0; index < 6000; index += 1) writeFileSync(path.join(deep, `file-${index}.js`), "");
    writeFileSync(path.join(alpha, "README.md"), "edited\n");

    const [alphaChanges, betaChanges] = await listChanges(root, "working");

    expect(alphaChanges).toMatchObject({ error: null, truncated: true });
    expect(alphaChanges!.files).toHaveLength(500);
    expect(alphaChanges!.files[0]).toEqual({ path: "README.md", oldPath: null, status: "M" });
    expect(betaChanges).toMatchObject({ name: "beta", error: null });
  });

  it("finds repos one folder down and the repo around a subfolder", async () => {
    const parent = path.join(temp(), "parent");
    mkdirSync(path.join(parent, "worktrees"), { recursive: true });
    const nested = clone(temp(), remote(temp(), "nested"), path.join(parent, "worktrees", "nested"));
    mkdirSync(path.join(nested, "src"));

    expect((await listChanges(parent, "working")).map((repo) => repo.name)).toEqual(["worktrees/nested"]);
    expect((await listChanges(path.join(nested, "src"), "working")).map((repo) => repo.name)).toEqual(["nested"]);
    writeFileSync(path.join(nested, "README.md"), "edited\n");
    const patch = await fileDiff({ root: parent, repo: "worktrees/nested", path: "README.md", oldPath: null, mode: "working", untracked: false });
    expect(patch).toContain("+edited");
  });

  it("reports a repo it cannot compare without failing the others", async () => {
    const { root, betaClone } = await workspace();
    git(betaClone, "remote", "remove", "upstream");
    git(betaClone, "remote", "remove", "origin");

    const [alpha, beta] = await listChanges(root, "branch");

    expect(alpha!.error).toBeNull();
    expect(beta!.error).toBe("This repo has no remote to compare against.");
  });
});

describe("fileDiff", () => {
  it("returns tracked, untracked, renamed, and branch patches", async () => {
    const { root, alpha } = await workspace();
    writeFileSync(path.join(alpha, "README.md"), "edited\n");
    writeFileSync(path.join(alpha, "new.txt"), "hello\n");
    const file = { root, repo: "alpha", oldPath: null };

    expect(await fileDiff({ ...file, path: "README.md", mode: "working", untracked: false })).toContain("+edited");
    expect(await fileDiff({ ...file, path: "new.txt", mode: "working", untracked: true })).toContain("+hello");

    git(alpha, "add", "-A");
    git(alpha, "commit", "-q", "-m", "work");
    renameSync(path.join(alpha, "new.txt"), path.join(alpha, "renamed.txt"));
    git(alpha, "add", "-A");
    const renamed = await fileDiff({ ...file, path: "renamed.txt", oldPath: "new.txt", mode: "working", untracked: false });
    expect(renamed).toContain("rename from new.txt");

    expect(await fileDiff({ ...file, path: "README.md", mode: "branch", untracked: false })).toContain("+edited");
  });

  it("returns both sides of a rewritten rename, and diffs file names as names, not globs", async () => {
    const { root, alpha } = await workspace();
    mkdirSync(path.join(alpha, "pages"));
    writeFileSync(path.join(alpha, "pages", "[Id].tsx"), "one\n");
    writeFileSync(path.join(alpha, "pages", "I.tsx"), "two\n");
    git(alpha, "add", "-A");
    git(alpha, "commit", "-q", "-m", "pages");
    git(alpha, "mv", "README.md", "GUIDE.md");
    writeFileSync(path.join(alpha, "GUIDE.md"), "completely different\ncontent\n");
    writeFileSync(path.join(alpha, "pages", "[Id].tsx"), "one edited\n");
    writeFileSync(path.join(alpha, "pages", "I.tsx"), "two edited\n");
    const file = { root, repo: "alpha", mode: "working" as const, untracked: false };

    const renamed = await fileDiff({ ...file, path: "GUIDE.md", oldPath: "README.md" });
    expect(renamed!.split(/^(?=diff --git )/m)).toHaveLength(2);
    const bracketed = await fileDiff({ ...file, path: "pages/[Id].tsx", oldPath: null });
    expect(bracketed).toContain("+one edited");
    expect(bracketed).not.toContain("two edited");
  });

  it("diffs staged files in a repo with no commits yet", async () => {
    const fresh = path.join(temp(), "fresh");
    mkdirSync(fresh);
    git(fresh, "init", "-q");
    writeFileSync(path.join(fresh, "a.txt"), "first\n");
    git(fresh, "add", "a.txt");

    expect(await fileDiff({ root: fresh, repo: "fresh", path: "a.txt", oldPath: null, mode: "working", untracked: false })).toContain("+first");
  });

  it("reports an untracked folder it cannot diff instead of showing no changes", async () => {
    const { root, alpha } = await workspace();
    mkdirSync(path.join(alpha, "nested"));
    git(path.join(alpha, "nested"), "init", "-q");

    await expect(
      fileDiff({ root, repo: "alpha", path: "nested/", oldPath: null, mode: "working", untracked: true }),
    ).rejects.toThrow(/Could not access/);
  });

  it("returns null for a patch too large to show", async () => {
    const { root, alpha } = await workspace();
    writeFileSync(path.join(alpha, "big.txt"), "line\n".repeat(200_000));

    expect(await fileDiff({ root, repo: "alpha", path: "big.txt", oldPath: null, mode: "working", untracked: true })).toBeNull();
  });

  it("refuses paths outside the repo and repos outside the folder", async () => {
    const { root } = await workspace();
    const file = { root, oldPath: null, mode: "working" as const, untracked: true };

    await expect(fileDiff({ ...file, repo: "alpha", path: "../beta/README.md" })).rejects.toThrow(/not a path inside/);
    await expect(fileDiff({ ...file, repo: "alpha", path: "/etc/passwd" })).rejects.toThrow(/not a path inside/);
    await expect(fileDiff({ ...file, repo: "..", path: "x" })).rejects.toThrow(/no repo named/);
  });
});
