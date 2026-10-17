import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clone, git, multiRepoProject as project, remote, useTempDir } from "./test-repos.js";
import { parseRepoSpec } from "./repo-spec.js";
import { ensureWorkspace, pickBranch, removeWorkspace, scanRepos } from "./workspace.js";

const temp = useTempDir();
const multiRepoProject = () => project(temp());

/** A workspace of `<repo>[@<from>]` specs on branch bb/task, created at `<tmp>/ws/<key>`. */
async function workspace(project: string, specs: string[], key = "thr_1") {
  const root = path.join(temp(), "ws", key);
  const created = await ensureWorkspace({ root, projectPath: project, branch: "bb/task", repos: specs.map(parseRepoSpec) });
  return { root, created };
}

describe("scanRepos", () => {
  it("offers each main clone with a remote", async () => {
    const { project, alpha, beta } = multiRepoProject();
    expect(await scanRepos(project)).toEqual([
      { name: "alpha", path: alpha },
      { name: "beta", path: beta },
    ]);
  });

  it("offers a project folder that is itself a repo", async () => {
    const solo = clone(temp(), remote(temp(), "solo"), path.join(temp(), "solo"));
    expect(await scanRepos(solo)).toEqual([{ name: "solo", path: solo }]);
  });
});

describe("ensureWorkspace", () => {
  it("creates worktrees from each upstream default branch in a folder that is not a repo", async () => {
    const { project, beta } = multiRepoProject();

    const { root, created } = await workspace(project, ["alpha", "beta"]);

    expect(created).toEqual(["alpha", "beta"]);
    expect(() => git(root, "rev-parse", "--show-toplevel")).toThrow();
    for (const name of ["alpha", "beta"]) {
      expect(git(path.join(root, name), "symbolic-ref", "--short", "HEAD")).toBe("bb/task");
    }
    // beta starts from upstream's dev, not the fork's main.
    expect(git(path.join(root, "beta"), "rev-parse", "HEAD")).toBe(git(beta, "rev-parse", "refs/remotes/upstream/dev"));
    // A plain push must not target the default branch.
    expect(() => git(path.join(root, "alpha"), "rev-parse", "--abbrev-ref", "@{upstream}")).toThrow();
    const agents = readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("| `alpha/` |");
    expect(agents).toContain("bb/task");
    expect(readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  });

  it("only creates what is missing, so repeating it or adding a repo is safe", async () => {
    const { project } = multiRepoProject();
    const { root } = await workspace(project, ["alpha"]);
    writeFileSync(path.join(root, "alpha", "work.txt"), "in progress\n");

    expect((await workspace(project, ["alpha"])).created).toEqual([]);
    expect((await workspace(project, ["alpha", "beta"])).created).toEqual(["beta"]);

    expect(readFileSync(path.join(root, "alpha", "work.txt"), "utf8")).toBe("in progress\n");
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain("| `beta/` |");
  });

  it("names the repos the project offers when one is unknown", async () => {
    const { project } = multiRepoProject();

    await expect(workspace(project, ["alpha", "gamma"])).rejects.toThrow(
      "Unknown repo gamma. The project offers: alpha, beta.",
    );
    expect(existsSync(path.join(temp(), "ws", "thr_1"))).toBe(false);
  });

  it("creates nothing when any fetch fails", async () => {
    const { project, beta } = multiRepoProject();
    git(beta, "remote", "set-url", "upstream", path.join(temp(), "missing.git"));

    await expect(workspace(project, ["alpha", "beta"])).rejects.toThrow(/Could not fetch beta/);
    expect(existsSync(path.join(temp(), "ws", "thr_1", "alpha"))).toBe(false);
  });

  it("ignores repo hooks that would fail the checkout", async () => {
    const { project, alpha } = multiRepoProject();
    const hook = path.join(alpha, ".git", "hooks", "post-checkout");
    writeFileSync(hook, "#!/bin/sh\nexit 2\n");
    chmodSync(hook, 0o755);

    expect((await workspace(project, ["alpha"])).created).toEqual(["alpha"]);
  });

  it("recreates a worktree whose checkout never finished", async () => {
    const { project } = multiRepoProject();
    const { root } = await workspace(project, ["alpha"]);
    const gitDir = git(path.join(root, "alpha"), "rev-parse", "--path-format=absolute", "--git-dir");
    writeFileSync(path.join(gitDir, "locked"), "initializing");
    rmSync(path.join(root, "alpha", "README.md"));

    expect((await workspace(project, ["alpha"])).created).toEqual(["alpha"]);
    expect(existsSync(path.join(root, "alpha", "README.md"))).toBe(true);
  });

  it("refuses a workspace folder inside another repo", async () => {
    const { project } = multiRepoProject();
    const outer = path.join(temp(), "dotfiles");
    mkdirSync(outer);
    git(outer, "init", "-q");

    await expect(
      ensureWorkspace({ root: path.join(outer, "ws"), projectPath: project, branch: "bb/task", repos: [{ name: "alpha", from: null }] }),
    ).rejects.toThrow(/is inside the git repo/);
  });

  it("re-adds a repo whose folder vanished while git still records it", async () => {
    const { project } = multiRepoProject();
    const { root } = await workspace(project, ["alpha"]);
    rmSync(path.join(root, "alpha"), { recursive: true, force: true });

    expect((await workspace(project, ["alpha"])).created).toEqual(["alpha"]);
    expect(git(path.join(root, "alpha"), "symbolic-ref", "--short", "HEAD")).toBe("bb/task");
  });

  it("refuses to overwrite a folder that is not a worktree", async () => {
    const { project } = multiRepoProject();
    mkdirSync(path.join(temp(), "ws", "thr_1", "alpha"), { recursive: true });

    await expect(workspace(project, ["alpha"])).rejects.toThrow(/exists but is not a worktree/);
  });
});

describe("pickBranch", () => {
  const user = userInfo().username;

  it("names the branch <user>/<slug> from bb's suggestion", async () => {
    const { project } = multiRepoProject();

    expect(await pickBranch(project, "bb/fix-restore-thr_ab12cd34")).toBe(`${user}/fix-restore`);
    expect(await pickBranch(project, "bb/fix-restore-thr_ab12cd34-2")).toBe(`${user}/fix-restore`);
  });

  it("adds a suffix while any repo has the name, locally or on a remote", async () => {
    const { project, alpha, beta } = multiRepoProject();
    git(alpha, "branch", `${user}/fix`);
    git(beta, "push", "-q", "origin", `HEAD:refs/heads/${user}/fix-2`);
    git(beta, "fetch", "-q", "origin");

    expect(await pickBranch(project, "bb/fix-thr_1")).toBe(`${user}/fix-3`);
  });
});

describe("start points", () => {
  /** alpha's remote gains a branch, a tag, and pull request 7, each one commit past main. */
  function published() {
    const { project, alpha } = multiRepoProject();
    const commit = (name: string) => {
      git(alpha, "checkout", "-q", "--detach", "main");
      writeFileSync(path.join(alpha, `${name}.txt`), `${name}\n`);
      git(alpha, "add", ".");
      git(alpha, "commit", "-q", "-m", name);
      return git(alpha, "rev-parse", "HEAD");
    };
    const remoteBranch = commit("pushed");
    git(alpha, "push", "-q", "origin", "HEAD:refs/heads/pushed");
    const tag = commit("tagged");
    git(alpha, "push", "-q", "origin", "HEAD:refs/tags/v1");
    const pr = commit("pr");
    git(alpha, "push", "-q", "origin", "HEAD:refs/pull/7/head");
    git(alpha, "checkout", "-q", "main");
    // Only the remote has these now.
    git(alpha, "update-ref", "-d", "refs/remotes/origin/pushed");
    return { project, alpha, remoteBranch, tag, pr };
  }

  it.each([
    ["origin/pushed", "remoteBranch"],
    ["pushed", "remoteBranch"],
    ["v1", "tag"],
    ["#7", "pr"],
    ["origin#7", "pr"],
  ] as const)("starts a new branch from %s", async (from, expected) => {
    const repo = published();

    await workspace(repo.project, [`alpha@${from}`]);

    const dir = path.join(temp(), "ws", "thr_1", "alpha");
    expect(git(dir, "symbolic-ref", "--short", "HEAD")).toBe("bb/task");
    expect(git(dir, "rev-parse", "HEAD")).toBe(repo[expected]);
    expect(git(repo.alpha, "config", "branch.bb/task.workspacesStart")).toBe(repo[expected]);
    expect(readFileSync(path.join(temp(), "ws", "thr_1", "AGENTS.md"), "utf8")).toContain(`| \`${from}\` |`);
  });

  it("starts from a branch that is checked out elsewhere without touching it", async () => {
    const { project, alpha } = multiRepoProject();
    git(alpha, "checkout", "-q", "-b", "in-use");
    writeFileSync(path.join(alpha, "wip.txt"), "the main clone's own work\n");

    await workspace(project, ["alpha@in-use"]);

    expect(git(path.join(temp(), "ws", "thr_1", "alpha"), "rev-parse", "HEAD")).toBe(git(alpha, "rev-parse", "in-use"));
    expect(git(alpha, "symbolic-ref", "--short", "HEAD")).toBe("in-use");
    expect(readFileSync(path.join(alpha, "wip.txt"), "utf8")).toBe("the main clone's own work\n");
  });

  it("names the start point and repo it cannot find", async () => {
    const { project } = multiRepoProject();

    await expect(workspace(project, ["alpha@nope"])).rejects.toThrow(/Could not find nope in alpha: origin has no refs\/heads\/nope or refs\/tags\/nope/);
    await expect(workspace(project, ["alpha@fork#3"])).rejects.toThrow(/there is no remote fork/);
  });
});

describe("removeWorkspace", () => {
  it("deletes the folder with uncommitted work and keeps the branch with its commits", async () => {
    const { project, alpha, beta } = multiRepoProject();
    const { root } = await workspace(project, ["alpha", "beta"]);
    writeFileSync(path.join(root, "alpha", "committed.txt"), "kept\n");
    git(path.join(root, "alpha"), "add", ".");
    git(path.join(root, "alpha"), "commit", "-q", "-m", "kept");
    writeFileSync(path.join(root, "alpha", "draft.txt"), "lost\n");
    writeFileSync(path.join(root, "scratch.log"), "deleted with the folder\n");

    await removeWorkspace(root);

    expect(existsSync(root)).toBe(false);
    expect(git(alpha, "log", "-1", "--format=%s", "bb/task")).toBe("kept");
    expect(() => git(alpha, "rev-parse", "bb/task:draft.txt")).toThrow();
    expect(git(alpha, "worktree", "list", "--porcelain")).not.toContain(root);
    expect(git(beta, "branch", "--list", "bb/task")).toBe("bb/task");
  });

  it("restores a removed workspace on its kept branch, without fetching", async () => {
    const { project, alpha } = multiRepoProject();
    const { root } = await workspace(project, ["alpha"]);
    writeFileSync(path.join(root, "alpha", "new.txt"), "done\n");
    git(path.join(root, "alpha"), "add", ".");
    git(path.join(root, "alpha"), "commit", "-q", "-m", "done");
    await removeWorkspace(root);
    git(alpha, "remote", "set-url", "origin", path.join(temp(), "offline.git"));

    const restored = await workspace(project, ["alpha"], "thr_1-2");

    expect(restored.created).toEqual(["alpha"]);
    expect(readFileSync(path.join(restored.root, "alpha", "new.txt"), "utf8")).toBe("done\n");
  });

  it("restores a branch deleted locally from its pushed copy", async () => {
    const { project, alpha } = multiRepoProject();
    const { root } = await workspace(project, ["alpha"]);
    const repo = path.join(root, "alpha");
    writeFileSync(path.join(repo, "feature.txt"), "pr\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "feature");
    git(repo, "push", "-q", "origin", "bb/task");
    await removeWorkspace(root);
    git(alpha, "branch", "-D", "bb/task");

    const restored = await workspace(project, ["alpha"], "thr_1-2");
    expect(git(path.join(restored.root, "alpha"), "log", "-1", "--format=%s")).toBe("feature");
  });

  it("refuses to delete a worktree whose repository moved", async () => {
    const { project, alpha } = multiRepoProject();
    const { root } = await workspace(project, ["alpha"]);
    renameSync(alpha, `${alpha}-moved`);

    await expect(removeWorkspace(root)).rejects.toThrow(/repository cannot be found/);
    expect(existsSync(path.join(root, "alpha", "README.md"))).toBe(true);
  });

  it("leaves other tools' worktree entries alone, even ones git would prune", async () => {
    const { project, alpha } = multiRepoProject();
    // Another tool's entry whose recorded path git cannot find, so `git worktree prune` would delete it.
    const elsewhere = path.join(alpha, ".git", "worktrees", "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(path.join(elsewhere, "gitdir"), "/no/such/place/.git\n");
    writeFileSync(path.join(elsewhere, "commondir"), "../..\n");
    writeFileSync(path.join(elsewhere, "HEAD"), `${git(alpha, "rev-parse", "HEAD")}\n`);

    const { root } = await workspace(project, ["alpha"]);
    await removeWorkspace(root);

    expect(readFileSync(path.join(elsewhere, "gitdir"), "utf8")).toBe("/no/such/place/.git\n");
    // alpha-wt, the project's own linked worktree, still works too.
    expect(git(path.join(project, "alpha-wt"), "rev-parse", "--show-toplevel")).toBe(path.join(project, "alpha-wt"));
  });

  it("does nothing for a workspace that is already gone", async () => {
    await expect(removeWorkspace(path.join(temp(), "ws", "missing"))).resolves.toBeUndefined();
  });
});
