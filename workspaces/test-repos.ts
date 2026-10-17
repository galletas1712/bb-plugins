import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";

// Keep the developer's git config (signing, hooks, identity) out of the tests.
const emptyConfig = path.join(mkdtempSync(path.join(tmpdir(), "workspaces-config-")), "gitconfig");
writeFileSync(emptyConfig, "");
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: "utf8" }).trim();
}

/** A fresh temp folder per test, removed afterwards. */
export function useTempDir(): () => string {
  let dir = "";
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "workspaces-test-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return () => dir;
}

/** A bare remote under `tmp` whose default branch is `branch`, holding one commit. */
export function remote(tmp: string, name: string, branch = "main"): string {
  const bare = path.join(tmp, "remotes", `${name}.git`);
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "-q", "--bare", "-b", branch);
  const seed = path.join(tmp, "seed", name);
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", branch);
  writeFileSync(path.join(seed, "README.md"), `${name}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "push", "-q", bare, branch);
  return bare;
}

export function clone(tmp: string, url: string, dir: string): string {
  git(tmp, "clone", "-q", url, dir);
  return realpathSync(dir);
}

/**
 * project/
 *   alpha/       origin = alpha (default main)
 *   beta/        origin = a stale fork, upstream = beta (default dev)
 *   alpha-wt/    linked worktree of alpha: not offered
 *   loose/       repo without a remote: not offered
 *   notes/       plain folder: not offered
 */
export function multiRepoProject(tmp: string) {
  const project = path.join(tmp, "project");
  mkdirSync(project);
  const alpha = clone(tmp, remote(tmp, "alpha"), path.join(project, "alpha"));
  const beta = clone(tmp, remote(tmp, "beta-fork"), path.join(project, "beta"));
  git(beta, "remote", "add", "upstream", remote(tmp, "beta", "dev"));
  git(alpha, "worktree", "add", "-q", path.join(project, "alpha-wt"));
  const loose = path.join(project, "loose");
  mkdirSync(loose);
  git(loose, "init", "-q");
  mkdirSync(path.join(project, "notes"));
  return { project: realpathSync(project), alpha, beta };
}
