import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { SAFE_NAME, type Mode, type RepoChanges } from "./contract.js";
import { START_CONFIG, baseRemote, gitCapped, toplevel, tryGit } from "./git.js";

type FileChange = RepoChanges["files"][number];

const MAX_FILES = 500;
// A file list this long is far past MAX_FILES, and it keeps the RPC small
// when a repo has an unignored tree of many thousands of files.
const MAX_LIST_BYTES = 1024 * 1024;
const MAX_PATCH_BYTES = 512 * 1024;
const GIT_TIMEOUT_MS = 15_000;
// A folder like ~/dynamo holds dozens of repos. Inspect a few at a time.
const PARALLEL_REPOS = 8;
// No external diff drivers or text conversion, and fixed a/ b/ prefixes so the patch always parses.
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];
// What HEAD would be in a repo with no commits yet.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Lists each repo's changes under `root`, which is a workspace folder of
 * repos or a repo itself. Working mode lists uncommitted changes against
 * HEAD. Branch mode lists what the branch's commits changed since its
 * base: where a workspace branch was told to start, or else its base
 * remote's default branch. A failing repo reports its own error.
 */
export async function listChanges(root: string, mode: Mode): Promise<RepoChanges[]> {
  return mapLimit(await reposUnder(root), PARALLEL_REPOS, async ({ name, dir }) => {
    try {
      const changes = mode === "working" ? await workingChanges(dir) : await branchChanges(dir);
      return { name, ...changes, error: null };
    } catch (error) {
      return { name, branch: null, base: null, files: [], truncated: false, error: messageOf(error) };
    }
  });
}

/**
 * One file's patch in the given mode, or null when it is larger than
 * 512 KiB. A rename or type change can yield one section per side.
 */
export async function fileDiff(args: {
  root: string;
  repo: string;
  path: string;
  oldPath: string | null;
  mode: Mode;
  untracked: boolean;
}): Promise<string | null> {
  const dir = await repoDir(args.root, args.repo);
  const paths = args.oldPath === null ? [args.path] : [args.oldPath, args.path];
  for (const file of paths) {
    if (path.isAbsolute(file) || file.split("/").includes("..")) {
      throw new Error(`"${file}" is not a path inside ${args.repo}.`);
    }
  }
  let diff: string[];
  if (args.mode === "branch") {
    diff = ["diff", ...DIFF_FLAGS, "-M", await mergeBase(dir, (await branchBase(dir)).ref), "HEAD", "--", ...paths];
  } else if (args.untracked) {
    diff = ["diff", "--no-index", ...DIFF_FLAGS, "--", "/dev/null", args.path];
  } else {
    const head = (await tryGit(dir, ["rev-parse", "-q", "--verify", "HEAD"]))?.trim() || EMPTY_TREE;
    diff = ["diff", ...DIFF_FLAGS, "-M", head, "--", ...paths];
  }
  const { stdout, truncated } = await gitCapped(dir, diff, { maxBytes: MAX_PATCH_BYTES, timeoutMs: GIT_TIMEOUT_MS });
  return truncated ? null : stdout;
}

interface RepoDir {
  name: string;
  dir: string;
}

/**
 * The repo `root` is in, when it is in one. Otherwise each repo among its
 * children and grandchildren, so a folder like ~/dynamo/worktrees/ of
 * worktrees shows up too. Hidden folders are skipped.
 */
async function reposUnder(root: string): Promise<RepoDir[]> {
  const real = await realpath(root);
  const top = await toplevel(real);
  if (top !== null) return [{ name: path.basename(top), dir: top }];
  const repos: RepoDir[] = [];
  const visit = async (dir: string, name: string, depth: number): Promise<void> => {
    if (await isRepoRoot(dir)) {
      repos.push({ name, dir });
    } else if (depth < 2) {
      const children = await childFolders(dir);
      await mapLimit(children, PARALLEL_REPOS, (child) =>
        visit(path.join(dir, child), name === "" ? child : `${name}/${child}`, depth + 1),
      );
    }
  };
  await visit(real, "", 0);
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

/** A name from `reposUnder` back to its folder, refusing anything outside `root`. */
async function repoDir(root: string, repo: string): Promise<string> {
  const real = await realpath(root);
  const top = await toplevel(real);
  if (top !== null && path.basename(top) === repo) return top;
  const segments = repo.split("/");
  const dir = path.join(real, ...segments);
  if (top !== null || segments.length > 2 || !segments.every((segment) => SAFE_NAME.test(segment)) || !(await isRepoRoot(dir))) {
    throw new Error(`There is no repo named ${repo} here.`);
  }
  return dir;
}

async function isRepoRoot(dir: string): Promise<boolean> {
  if ((await lstat(path.join(dir, ".git")).catch(() => null)) === null) return false;
  return (await toplevel(dir)) === dir;
}

async function childFolders(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && SAFE_NAME.test(entry.name)).map((entry) => entry.name);
}

async function workingChanges(dir: string): Promise<Omit<RepoChanges, "name" | "error">> {
  const { records, truncated } = await listRecords(dir, [
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--no-ahead-behind",
    "--untracked-files=all",
    "--find-renames",
    "--ignore-submodules=dirty",
  ]);
  let branch: string | null = null;
  const files: FileChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const fields = record.split(" ");
    switch (record[0]) {
      case "#":
        if (fields[1] === "branch.head") branch = fields[2] === "(detached)" ? null : fields[2]!;
        break;
      case "1": // 1 XY sub mH mI mW hH hI path
        files.push({ path: fields.slice(8).join(" "), oldPath: null, status: combinedStatus(fields[1]!) });
        break;
      case "2": {
        // 2 XY sub mH mI mW hH hI Xscore path, then the source path as the next record.
        const source = records[++index];
        const renamed = fields[8]![0] === "R";
        files.push({ path: fields.slice(9).join(" "), oldPath: renamed ? source ?? null : null, status: renamed ? "R" : "A" });
        break;
      }
      case "u": // u XY sub m1 m2 m3 mW h1 h2 h3 path
        files.push({ path: fields.slice(10).join(" "), oldPath: null, status: "U" });
        break;
      case "?":
        files.push({ path: record.slice(2), oldPath: null, status: "?" });
        break;
    }
  }
  return { branch, base: null, ...capped(files, truncated) };
}

async function branchChanges(dir: string): Promise<Omit<RepoChanges, "name" | "error">> {
  const base = await branchBase(dir);
  const from = await mergeBase(dir, base.ref);
  const { records, truncated } = await listRecords(dir, ["diff", "--name-status", "-z", "-M", from, "HEAD"]);
  const files: FileChange[] = [];
  for (let index = 0; index + 1 < records.length; index += 1) {
    const code = records[index]![0];
    if (code === "R" || code === "C") {
      const source = records[++index]!;
      const target = records[++index];
      if (target === undefined) break;
      files.push({ path: target, oldPath: code === "R" ? source : null, status: code === "R" ? "R" : "A" });
    } else {
      files.push({ path: records[++index]!, oldPath: null, status: code === "A" || code === "D" ? code : "M" });
    }
  }
  return { branch: await currentBranch(dir), base: base.label, ...capped(files, truncated) };
}

/** Runs a `-z` listing and returns its complete records, dropping one cut off by the size cap. */
async function listRecords(dir: string, args: string[]): Promise<{ records: string[]; truncated: boolean }> {
  const { stdout, truncated } = await gitCapped(dir, args, { maxBytes: MAX_LIST_BYTES, timeoutMs: GIT_TIMEOUT_MS });
  const records = stdout.split("\0");
  // The text after the last NUL is empty when complete, or a partial record when cut.
  records.pop();
  return { records, truncated };
}

/** Status against HEAD from porcelain v2's index (X) and worktree (Y) codes. */
function combinedStatus(xy: string): FileChange["status"] {
  if (xy.includes("D")) return "D";
  return xy[0] === "A" ? "A" : "M";
}

async function currentBranch(dir: string): Promise<string | null> {
  return (await tryGit(dir, ["symbolic-ref", "--short", "-q", "HEAD"]))?.trim() || null;
}

/**
 * What branch mode compares against: the commit recorded when a workspace
 * branch was told where to start, or else the default branch.
 */
async function branchBase(dir: string): Promise<{ ref: string; label: string }> {
  const branch = await currentBranch(dir);
  const start = branch === null ? null : (await tryGit(dir, ["config", "--get", `branch.${branch}.${START_CONFIG}`]))?.trim();
  if (start) return { ref: start, label: `its start ${start.slice(0, 10)}` };
  const ref = await defaultBranchRef(dir);
  return { ref, label: ref };
}

/**
 * The base remote's default branch as `<remote>/<branch>`, read from
 * `refs/remotes/<remote>/HEAD`. Workspaces refresh that record on every
 * fetch. Other clones carry whatever `git clone` or `git remote set-head`
 * last wrote.
 */
async function defaultBranchRef(dir: string): Promise<string> {
  const remote = await baseRemote(dir);
  if (remote === null) throw new Error("This repo has no remote to compare against.");
  const ref = (await tryGit(dir, ["symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`]))?.trim();
  if (!ref) {
    throw new Error(`No default branch is recorded for ${remote}. Run \`git remote set-head ${remote} --auto\` in this repo.`);
  }
  return ref;
}

async function mergeBase(dir: string, base: string): Promise<string> {
  const commit = await tryGit(dir, ["merge-base", "HEAD", base], { timeoutMs: GIT_TIMEOUT_MS });
  if (commit === null) throw new Error(`This branch shares no history with ${base}.`);
  return commit.trim();
}

function capped(files: FileChange[], cut: boolean): { files: FileChange[]; truncated: boolean } {
  return { files: files.slice(0, MAX_FILES), truncated: cut || files.length > MAX_FILES };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
