import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { SAFE_NAME } from "./contract.js";
import type { RepoEntry } from "./repo-spec.js";
import { START_CONFIG, baseRemote, git, toplevel, tryGit } from "./git.js";
import { keyedQueue } from "./queue.js";

/** A main clone the project offers. */
export interface Repo {
  name: string;
  path: string;
}

const FETCH_TIMEOUT_MS = 5 * 60_000;
// Checkouts take minutes on big repos.
const SLOW_TIMEOUT_MS = 10 * 60_000;
// Repo hooks (git-lfs stubs, pre-commit) are for people, not for our bookkeeping.
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

/** A thread's workspace folder: `<dataDir>/workspaces/<pathKey>`. */
export function workspaceRoot(dataDir: string, pathKey: string): string {
  if (!SAFE_NAME.test(pathKey)) {
    throw new Error(`"${pathKey}" is not a valid workspace key`);
  }
  return path.join(dataDir, "workspaces", pathKey);
}

/**
 * Lists the main clones a project offers, sorted by name. A project folder
 * that is itself a repo offers just that repo. Otherwise every direct child
 * that owns a `.git` directory and has a remote is a candidate. Linked
 * worktrees (a `.git` file) are skipped, since they are checkouts of a repo
 * that is listed on its own.
 */
export async function scanRepos(projectPath: string): Promise<Repo[]> {
  const project = await realpath(projectPath);
  if ((await toplevel(project)) === project) {
    if (!(await hasRemote(project))) return [];
    const name = path.basename(project);
    return [{ name: SAFE_NAME.test(name) ? name : "repo", path: project }];
  }
  const entries = await readdir(project, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && SAFE_NAME.test(entry.name))
      .map(async (entry): Promise<Repo | null> => {
        const dir = path.join(project, entry.name);
        const dotGit = await lstat(path.join(dir, ".git")).catch(() => null);
        if (!dotGit?.isDirectory()) return null;
        if ((await toplevel(dir)) !== dir || !(await hasRemote(dir))) return null;
        return { name: entry.name, path: dir };
      }),
  );
  return candidates
    .filter((repo): repo is Repo => repo !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The thread's branch: `<user>/<slug>`, where the slug is bb's suggested
 * branch name without its `bb/` prefix and thread id. A `-2`, `-3`, ...
 * suffix keeps it unused, locally and on every remote, in every repo the
 * project offers, so repos added later can take the same name.
 */
export async function pickBranch(projectPath: string, suggested: string): Promise<string> {
  const user = userInfo().username.replace(/[^A-Za-z0-9._-]+/g, "-");
  const slug = suggested.replace(/^.*\//, "").replace(/-thr_[a-z0-9]+(?:-\d+)?$/, "") || "work";
  const repos = await scanRepos(projectPath);
  for (let n = 1; ; n += 1) {
    const branch = n === 1 ? `${user}/${slug}` : `${user}/${slug}-${n}`;
    const taken = await Promise.all(repos.map((repo) => branchIsTaken(repo.path, branch)));
    if (!taken.includes(true)) return branch;
  }
}

/**
 * Makes `root` hold a worktree of every listed repo on `branch` and
 * rewrites the agent instructions. Only missing worktrees are created. Each
 * reuses `branch` when the repo has it (a restore), resumes a copy of it on
 * a remote, or else starts it where the entry's `from` says, by default a
 * fresh fetch of the repo's upstream default branch. Every fetch finishes
 * before any worktree is created, so a network failure leaves nothing
 * half-built. Returns the names of the worktrees it created.
 */
export async function ensureWorkspace(args: {
  root: string;
  projectPath: string;
  branch: string;
  repos: readonly RepoEntry[];
  signal?: AbortSignal;
}): Promise<string[]> {
  const { root, branch, signal } = args;
  const entries = pick(await scanRepos(args.projectPath), args.repos);
  await mkdir(root, { recursive: true });
  // bb would treat the folder as part of that repo and show its git UI.
  const enclosing = await toplevel(root);
  if (enclosing !== null) {
    throw new Error(`The workspace folder ${root} is inside the git repo ${enclosing}.`);
  }
  const missing: Picked[] = [];
  for (const entry of entries) {
    if (!(await clearUnfinishedWorktree(path.join(root, entry.repo.name)))) missing.push(entry);
  }
  const starts = await Promise.all(
    missing.map(({ repo, from }) => withRepoLock(mainGitDir(repo), () => startPoint(repo, branch, from, signal))),
  );
  await Promise.all(
    missing.map(({ repo }, index) =>
      withRepoLock(mainGitDir(repo), () =>
        addWorktree({ repo, dir: path.join(root, repo.name), branch, start: starts[index]!, signal }),
      ),
    ),
  );
  await writeInstructions(root, args.projectPath, branch, entries);
  return missing.map(({ repo }) => repo.name);
}

/**
 * Removes the workspace like bb's own Worktree provider does: each worktree
 * is deleted with its uncommitted work, and its branch stays. Committing and
 * pushing is the agent's job. Everything else in the folder is deleted too.
 */
export async function removeWorkspace(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (entries === null) return;
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    const dotGit = entry.isDirectory() ? await lstat(path.join(dir, ".git")).catch(() => null) : null;
    if (dotGit === null) continue;
    const worktree = await inspectWorktree(dir);
    if (worktree === null) {
      if (dotGit.isFile()) {
        throw new Error(`${dir} is a worktree whose repository cannot be found. Put the repository back and removal will retry.`);
      }
      // A clone the agent made itself. AGENTS.md says it goes with the folder.
      continue;
    }
    await withRepoLock(worktree.commonDir, () => deleteWorktree(dir, worktree));
  }
  await rm(root, { recursive: true, force: true });
}

interface Picked {
  repo: Repo;
  from: string | null;
}

/** Resolves entries against the project's repos, naming every unknown one. A repo listed twice keeps its first entry. */
function pick(available: readonly Repo[], entries: readonly RepoEntry[]): Picked[] {
  const byName = new Map(available.map((repo) => [repo.name, repo]));
  const unknown = entries.map(({ name }) => name).filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    const offered = available.map((repo) => repo.name).join(", ") || "none";
    throw new Error(`Unknown repo ${unknown.join(", ")}. The project offers: ${offered}.`);
  }
  const picked = new Map<string, Picked>();
  for (const { name, from } of entries) {
    if (!picked.has(name)) picked.set(name, { repo: byName.get(name)!, from });
  }
  return [...picked.values()];
}

async function hasRemote(dir: string): Promise<boolean> {
  return (await baseRemote(dir)) !== null;
}

function mainGitDir(repo: Repo): string {
  return path.join(repo.path, ".git");
}

interface Worktree {
  /** The repo's shared `.git` directory. */
  commonDir: string;
  /** This worktree's own entry, `<commonDir>/worktrees/<name>`. */
  gitDir: string;
  finished: boolean;
}

/**
 * Describes the linked worktree rooted at `dir`, or returns null when `dir`
 * is not one. `finished` is false while `git worktree add` holds its
 * "initializing" lock, which a crashed add leaves behind.
 */
async function inspectWorktree(dir: string): Promise<Worktree | null> {
  const dotGit = await lstat(path.join(dir, ".git")).catch(() => null);
  if (!dotGit?.isFile()) return null;
  const paths = await tryGit(dir, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
  ]);
  if (paths === null) return null;
  const [top, gitDir, commonDir] = paths.trim().split("\n");
  if (
    top !== (await realpath(dir)) ||
    gitDir === undefined ||
    commonDir === undefined ||
    path.dirname(gitDir) !== path.join(commonDir, "worktrees")
  ) {
    return null;
  }
  const lock = await readFile(path.join(gitDir, "locked"), "utf8").catch(() => null);
  return { commonDir, gitDir, finished: lock?.trim() !== "initializing" };
}

/**
 * Deletes a worktree's folder and its own entry under `.git/worktrees`.
 * Never `git worktree prune`: that deletes every entry git judges gone,
 * including other tools' live worktrees whose recorded paths it misreads,
 * and the next `worktree add` then hands their entry to someone else.
 */
async function deleteWorktree(dir: string, worktree: Worktree): Promise<void> {
  // Unlinking .git first means a retry after an interrupted delete sees a
  // plain folder, never a half-deleted worktree to save again.
  await rm(path.join(dir, ".git"), { force: true });
  await rm(worktree.gitDir, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
}

/**
 * True when `dir` already holds a finished worktree. Clears the leftovers
 * of an unfinished one so it can be created again, and refuses to touch
 * anything else found there.
 */
async function clearUnfinishedWorktree(dir: string): Promise<boolean> {
  const worktree = await inspectWorktree(dir);
  if (worktree?.finished) return true;
  if (worktree !== null) {
    await deleteWorktree(dir, worktree);
  } else if ((await lstat(dir).catch(() => null)) !== null) {
    throw new Error(`${dir} exists but is not a worktree. Move it away and retry.`);
  }
  return false;
}

/**
 * Deletes `.git/worktrees` entries that still record `dir` after its folder
 * vanished, which would make `git worktree add` refuse the path. Only
 * entries for exactly this path are touched.
 */
async function forgetVanishedWorktree(repo: Repo, dir: string): Promise<void> {
  const entries = path.join(mainGitDir(repo), "worktrees");
  for (const name of await readdir(entries).catch(() => [] as string[])) {
    const recorded = await readFile(path.join(entries, name, "gitdir"), "utf8").catch(() => null);
    if (recorded?.trim() === path.join(dir, ".git")) {
      await rm(path.join(entries, name), { recursive: true, force: true });
    }
  }
}

/**
 * Where a new worktree's branch comes from: null to reuse the local
 * branch, a pushed copy of it, or else `from` resolved after a fetch, by
 * default the repo's upstream default branch. `startCommit` is set only when
 * `from` chose the start, so the Changes panel can compare against it.
 */
async function startPoint(
  repo: Repo,
  branch: string,
  from: string | null,
  signal?: AbortSignal,
): Promise<Start> {
  if (await branchExists(repo.path, branch)) return { ref: null, startCommit: null };
  const pushed = (
    await git(repo.path, ["for-each-ref", "--count=1", "--format=%(refname)", `refs/remotes/*/${branch}`])
  ).trim();
  if (pushed) return { ref: pushed, startCommit: null };
  if (from === null) return { ref: await fetchDefaultBranch(repo, signal), startCommit: null };
  const commit = await resolveFrom(repo, from, signal);
  return { ref: commit, startCommit: commit };
}

interface Start {
  ref: string | null;
  startCommit: string | null;
}

/**
 * Fetches the default branch of the repo's base remote and returns its
 * remote-tracking ref. The branch name comes from the live remote, because
 * a clone's recorded `<remote>/HEAD` goes stale, and the fetch refreshes
 * that record so the Changes panel compares against the same branch.
 */
async function fetchDefaultBranch(repo: Repo, signal?: AbortSignal): Promise<string> {
  try {
    const remote = await baseRemote(repo.path);
    if (remote === null) throw new Error("it has no remote");
    const head = await git(repo.path, ["ls-remote", "--symref", remote, "HEAD"], { signal });
    const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head)?.[1];
    if (branch === undefined) throw new Error(`${remote} reports no default branch`);
    const ref = `refs/remotes/${remote}/${branch}`;
    await git(repo.path, ["fetch", "--no-tags", remote, `+refs/heads/${branch}:${ref}`], {
      signal,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    await git(repo.path, ["remote", "set-head", remote, branch]);
    return ref;
  } catch (error) {
    throw new Error(`Could not fetch ${repo.name}: ${messageOf(error)}`);
  }
}

/**
 * Resolves a start point to a commit id, fetching what it names:
 * - `#<n>` or `<remote>#<n>`: the pull request's head, from the base remote by default
 * - `<remote>/<branch>`: that branch, fetched fresh
 * - anything else: a local branch, tag, or commit, or else a branch, tag, or full commit id fetched from the base remote
 */
async function resolveFrom(repo: Repo, from: string, signal?: AbortSignal): Promise<string> {
  try {
    const remotes = ((await tryGit(repo.path, ["remote"])) ?? "").split("\n").filter(Boolean);
    const base = await baseRemote(repo.path);
    const pr = /^(.*)#(\d+)$/.exec(from);
    if (pr !== null) {
      const remote = pr[1] || base;
      if (remote === null || !remotes.includes(remote)) throw new Error(`there is no remote ${pr[1] || ""}`.trim());
      return await fetchCommit(repo, remote, [[`refs/pull/${pr[2]}/head`, null]], signal);
    }
    const slash = from.indexOf("/");
    if (slash > 0 && remotes.includes(from.slice(0, slash))) {
      const remote = from.slice(0, slash);
      const branch = from.slice(slash + 1);
      return await fetchCommit(repo, remote, [[`refs/heads/${branch}`, `refs/remotes/${remote}/${branch}`]], signal);
    }
    const local = await tryGit(repo.path, ["rev-parse", "--verify", "--quiet", `${from}^{commit}`]);
    if (local !== null) return local.trim();
    if (base === null) throw new Error("it is not here and the repo has no remote");
    if (/^[0-9a-f]{40}$/.test(from)) {
      await git(repo.path, ["fetch", "--no-tags", base, from], { signal, timeoutMs: FETCH_TIMEOUT_MS });
      return from;
    }
    return await fetchCommit(
      repo,
      base,
      [
        [`refs/heads/${from}`, `refs/remotes/${base}/${from}`],
        [`refs/tags/${from}`, `refs/tags/${from}`],
      ],
      signal,
    );
  } catch (error) {
    throw new Error(`Could not find ${from} in ${repo.name}: ${messageOf(error)}`);
  }
}

/**
 * Fetches the first of `candidates` that `remote` has and returns its
 * commit id. Each is a remote ref and where to keep it, or null to keep
 * nothing, as for a pull request's head.
 */
async function fetchCommit(
  repo: Repo,
  remote: string,
  candidates: readonly (readonly [string, string | null])[],
  signal?: AbortSignal,
): Promise<string> {
  const listed = await git(repo.path, ["ls-remote", remote, ...candidates.map(([source]) => source)], { signal });
  const ids = new Map(listed.split("\n").filter(Boolean).map((line) => [line.split("\t")[1], line.split("\t")[0]!]));
  const found = candidates.find(([source]) => ids.has(source));
  if (found === undefined) throw new Error(`${remote} has no ${candidates.map(([source]) => source).join(" or ")}`);
  const [source, target] = found;
  const refspec = target === null ? source : `${source.startsWith("refs/heads/") ? "+" : ""}${source}:${target}`;
  await git(repo.path, ["fetch", "--no-tags", remote, refspec], { signal, timeoutMs: FETCH_TIMEOUT_MS });
  return ids.get(source)!;
}

async function addWorktree(args: {
  repo: Repo;
  dir: string;
  branch: string;
  start: Start;
  signal?: AbortSignal;
}): Promise<void> {
  const { repo, dir, branch, start, signal } = args;
  try {
    await forgetVanishedWorktree(repo, dir);
    // --no-track keeps a plain `git push` from targeting the branch it started from.
    const add =
      start.ref === null
        ? ["worktree", "add", dir, branch]
        : ["worktree", "add", "--no-track", "-b", branch, dir, start.ref];
    await git(repo.path, [...NO_HOOKS, ...add], { signal, timeoutMs: SLOW_TIMEOUT_MS });
    // Kept in the branch's own config section, which git deletes with the branch.
    if (start.startCommit !== null) await git(repo.path, ["config", `branch.${branch}.${START_CONFIG}`, start.startCommit]);
  } catch (error) {
    throw new Error(`Could not create the ${repo.name} worktree: ${messageOf(error)}`);
  }
}

async function branchExists(gitPath: string, branch: string): Promise<boolean> {
  return (await tryGit(gitPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) !== null;
}

/**
 * True when `branch` exists locally or on any remote, or a branch below it
 * does, since git cannot then create it.
 */
async function branchIsTaken(gitPath: string, branch: string): Promise<boolean> {
  const refs = await git(gitPath, ["for-each-ref", "--count=1", "--format=%(refname)", `refs/heads/${branch}`, `refs/remotes/*/${branch}`]);
  return refs.trim() !== "";
}

async function writeInstructions(
  root: string,
  projectPath: string,
  branch: string,
  entries: readonly Picked[],
): Promise<void> {
  const rows = entries
    .map(({ repo, from }) => `| \`${repo.name}/\` | \`${repo.path}\` | ${from === null ? "default branch" : `\`${from}\``} |`)
    .join("\n");
  const agents = `# Workspace

This folder is not a git repository. Each folder below is a git worktree of a repo from \`${projectPath}\`, on a new branch \`${branch}\`. Run git commands inside a repo folder.

| Folder | Worktree of | Started from |
|---|---|---|
${rows || "| (none yet) | | |"}

- "default branch" means a fresh fetch of the repo's default branch on its \`upstream\` remote, or \`origin\` when there is no \`upstream\`.
- The branch tracks nothing. Commit and push yourself, to whichever remote and branch the task needs, for example \`git push -u <remote> HEAD\`.
- Before working in a repo, read its own \`AGENTS.md\` or \`CLAUDE.md\` if it has one.
- To add another repo from the project, run \`bb workspaces add <repo>\` or \`bb workspaces add <repo>@<start>\`. A start is a branch, \`<remote>/<branch>\`, a tag, a commit, or \`#<pr>\`.
- When this workspace is removed, its folders are deleted, uncommitted work included. Branches and their commits stay in the repos.
`;
  await writeAtomically(path.join(root, "AGENTS.md"), agents);
  await writeAtomically(path.join(root, "CLAUDE.md"), "@AGENTS.md\n");
}

async function writeAtomically(file: string, content: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, content);
  await rename(temp, file);
}

// Fetches, worktree adds, and removals on one repository share its ref and
// worktree locks, so they run one at a time per repository.
const repoQueue = keyedQueue();

async function withRepoLock<T>(gitDir: string, run: () => Promise<T>): Promise<T> {
  return repoQueue(await realpath(gitDir), run);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
