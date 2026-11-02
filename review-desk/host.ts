// bb-plugin-review-desk — host entry. Runs on the machine that holds the
// repository: git for refs and diffs, gh for GitHub. No plugin storage here.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type ChangedFile, type GhPrStatus } from "./host-contract";
import { fetchPullRequestStack } from "./stack-fetch";
import { fetchOwnPullRequests } from "./own-prs";
import { fetchPrStatuses } from "./pr-statuses";
import { editBody, readDescription } from "./lib/github-edit";
import { mergePr, readMergeOptions, readMergeResult } from "./lib/github-merge";
import { fetchConversation, fetchPrMetadata, fetchReviewThreads } from "./github-conversation";
import { withGitHubBackoff } from "./github-rate-limit";
import { withGitHubCache } from "./github-cache";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

const run = withGitHubCache(withGitHubBackoff(async (cmd, args, options = {}) => {
  try {
    const child = execFileAsync(cmd, args, { cwd: options.cwd, maxBuffer: MAX_BUFFER, encoding: "utf8", timeout: cmd === "gh" && args[0] !== "repo" ? 30_000 : 180_000 });
    if (options.input !== undefined && child.child.stdin) {
      child.child.stdin.end(options.input);
    }
    const { stdout, stderr } = await child;
    return { stdout, stderr, code: 0 };
  } catch (cause) {
    const err = cause as { stdout?: string; stderr?: string; code?: number | string; message?: string };
    if (options.allowFailure) {
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "", code: typeof err.code === "number" ? err.code : 1 };
    }
    throw new Error(`${cmd} ${args.slice(0, 4).join(" ")}… failed: ${(err.stderr || err.message || "").trim().slice(0, 600)}`);
  }
}));

const git = (cwd: string, args: string[], allowFailure = false) => run("git", args, { cwd, allowFailure });

const repositoryWork = new Map<string, Promise<unknown>>();
async function inRepository<T>(repoPath: string, work: () => Promise<T>): Promise<T> {
  const previous = repositoryWork.get(repoPath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  repositoryWork.set(repoPath, next);
  try { return await next; }
  finally { if (repositoryWork.get(repoPath) === next) repositoryWork.delete(repoPath); }
}

// Clones under dataDir/repos belong to this plugin. They are bare and blob-less because
// reviews read Git objects by commit, so a checkout would only cost disk and time.
async function openRepository(repoPath: string, dataDir: string): Promise<void> {
  if (path.dirname(repoPath) !== path.join(dataDir, "repos")) return;
  // A clone with a checkout keeps only its .git directory. Staging it beside the clone
  // lets an interrupted conversion resume without losing objects.
  const staged = path.join(path.dirname(repoPath), `.${path.basename(repoPath)}.bare`);
  if (existsSync(path.join(repoPath, ".git"))) renameSync(path.join(repoPath, ".git"), staged);
  if (!existsSync(staged)) return;
  rmSync(repoPath, { recursive: true, force: true });
  for (const entry of ["index", "lfs", "worktrees"]) rmSync(path.join(staged, entry), { recursive: true, force: true });
  await run("git", ["--git-dir", staged, "config", "core.bare", "true"]);
  renameSync(staged, repoPath);
}

function ghJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function statusFromLetter(letter: string): ChangedFile["status"] {
  switch (letter[0]) {
    case "A": return "added";
    case "M": return "modified";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "T": return "type_changed";
    default: return "unknown";
  }
}

async function listFiles(repoPath: string, baseSha: string, headSha: string): Promise<ChangedFile[]> {
  const [status, numstat] = await Promise.all([
    git(repoPath, ["diff", "--name-status", "-M", "-z", baseSha, headSha]),
    git(repoPath, ["diff", "--numstat", "-M", "-z", baseSha, headSha]),
  ]);
  const files = new Map<string, ChangedFile>();
  const parts = status.stdout.split("\0").filter((p) => p !== "");
  for (let i = 0; i < parts.length; i++) {
    const letter = parts[i];
    if (letter.startsWith("R") || letter.startsWith("C")) {
      const oldPath = parts[++i];
      const newPath = parts[++i];
      files.set(newPath, { path: newPath, oldPath, status: statusFromLetter(letter), additions: 0, deletions: 0, binary: false });
    } else {
      const p = parts[++i];
      files.set(p, { path: p, oldPath: null, status: statusFromLetter(letter), additions: 0, deletions: 0, binary: false });
    }
  }
  // numstat -z: "add\tdel\tpath\0" or for renames "add\tdel\0old\0new\0"
  const nparts = numstat.stdout.split("\0").filter((p) => p !== "");
  for (let i = 0; i < nparts.length; i++) {
    const fields = nparts[i].split("\t");
    if (fields.length < 2) continue;
    const [add, del] = fields;
    let p: string;
    if (fields.length >= 3 && fields[2] !== "") {
      p = fields[2];
    } else {
      i++; // old path
      p = nparts[++i];
    }
    const file = files.get(p);
    if (file === undefined) continue;
    if (add === "-" || del === "-") file.binary = true;
    else {
      file.additions = Number(add);
      file.deletions = Number(del);
    }
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function showFile(repoPath: string, sha: string, filePath: string): Promise<{ content: string | null; binary: boolean }> {
  const result = await run("git", ["show", `${sha}:${filePath}`], { cwd: repoPath, allowFailure: true });
  if (result.code !== 0) return { content: null, binary: false };
  if (result.stdout.includes("\0")) return { content: null, binary: true };
  return { content: result.stdout, binary: false };
}

// ---------------------------------------------------------------------------
// GitHub via gh
// ---------------------------------------------------------------------------

interface GhPrView {
  number: number;
  title: string;
  body: string;
  state: string;
  isDraft: boolean;
  url: string;
  author: { login: string } | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  baseRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
  updatedAt: string;
  createdAt: string;
}

async function ghPrStatus(owner: string, repo: string, number: number): Promise<GhPrStatus> {
  const fields = "number,title,body,state,isDraft,url,author,baseRefName,headRefName,headRefOid,baseRefOid,additions,deletions,changedFiles,reviewDecision,mergeable,mergeStateStatus,updatedAt,createdAt";
  const result = await run("gh", ["pr", "view", String(number), "--repo", `${owner}/${repo}`, "--json", fields]);
  const view = ghJson<GhPrView>(result.stdout);
  return {
    createdAt: view.createdAt,
    number: view.number,
    title: view.title,
    body: view.body ?? "",
    state: view.state,
    isDraft: view.isDraft,
    url: view.url,
    author: view.author ? { login: view.author.login } : null,
    baseRefName: view.baseRefName,
    headRefName: view.headRefName,
    headRefOid: view.headRefOid,
    baseRefOid: view.baseRefOid,
    additions: view.additions,
    deletions: view.deletions,
    changedFiles: view.changedFiles,
    reviewDecision: view.reviewDecision ?? null,
    mergeable: view.mergeable ?? null,
    mergeStateStatus: view.mergeStateStatus ?? null,
    updatedAt: view.updatedAt,

  };
}

// ---------------------------------------------------------------------------
// Host entry
// ---------------------------------------------------------------------------

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async gh_close({ owner, repo, number }) {
      await run("gh", ["pr", "close", String(number), "--repo", `${owner}/${repo}`]);
      return { ok: true as const };
    },
    gh_merge_options(input) { return readMergeOptions(run, input, input.freshPolicy); },
    gh_merge(input) { return mergePr(run, input); },
    gh_merge_result(input) { return readMergeResult(run, input); },
    async repo_clone({ owner, repo, dest }, context) {
      const target = dest === "" ? path.join(context.experimental_paths.dataDir, "repos", `${owner}__${repo}`) : dest;
      return inRepository(target, async () => {
        await openRepository(target, context.experimental_paths.dataDir);
        mkdirSync(path.dirname(target), { recursive: true });
        if (!existsSync(target)) {
          await run("gh", ["repo", "clone", `${owner}/${repo}`, target, "--", "--bare", "--filter=blob:none"]);
        }
        return { repoPath: target };
      });
    },
    async repo_prepare({ repoPath, number, headSha, baseRefName }, context) {
      return inRepository(repoPath, async () => {
        await openRepository(repoPath, context.experimental_paths.dataDir);
        await git(repoPath, ["fetch", "--quiet", "origin", `+refs/pull/${number}/head:refs/review-desk/pr-${number}`, `+refs/heads/${baseRefName}:refs/remotes/origin/${baseRefName}`]);
        const baseSha = (await git(repoPath, ["merge-base", headSha, `refs/remotes/origin/${baseRefName}`])).stdout.trim();
        return { headSha, baseSha };
      });
    },
    async repo_release({ repoPath, worktree }, context) {
      return inRepository(repoPath, async () => {
        await openRepository(repoPath, context.experimental_paths.dataDir);
        await git(repoPath, ["worktree", "remove", "--force", worktree], true);
        rmSync(worktree, { recursive: true, force: true });
        return { ok: true as const };
      });
    },
    async git_files({ repoPath, baseSha, headSha }) {
      return { files: await listFiles(repoPath, baseSha, headSha) };
    },
    async git_patch({ repoPath, baseSha, headSha, path: filePath, oldPath }) {
      const targets = [...new Set([oldPath, filePath].filter((value): value is string => value !== null && value !== ""))];
      const result = await git(repoPath, ["diff", "-M", "--no-color", "--no-ext-diff", baseSha, headSha, "--", ...targets]);
      return { patch: result.stdout };
    },
    async git_show({ repoPath, sha, path: filePath }) {
      return showFile(repoPath, sha, filePath);
    },
    async git_commit({ repoPath, sha }) {
      const result = await git(repoPath, ["show", "-s", "--format=%H%n%P%n%an%n%aI%n%s%n%b", sha]);
      const [full = sha, parents = "", author = "", date = "", title = "", ...body] = result.stdout.split("\n");
      return { sha: full.trim(), parents: parents.trim() === "" ? [] : parents.trim().split(/\s+/), author, date, title, body: body.join("\n").trim() };
    },
    async gh_pr({ owner, repo, number }) {
      const [status, details] = await Promise.all([ghPrStatus(owner, repo, number), fetchPrMetadata(run, owner, repo, number)]);
      return { ...status, ...details };
    },
    async gh_pr_status({ owner, repo, number }) {
      return ghPrStatus(owner, repo, number);
    },
    async gh_pr_details({ owner, repo, number, includeCommits }) {
      const details = await fetchPrMetadata(run, owner, repo, number, includeCommits);
      return { ...details, commits: includeCommits ? details.commits : null };
    },
    async gh_threads({ owner, repo, number }) {
      return { threads: await fetchReviewThreads(run, owner, repo, number) };
    },
    async gh_conversation({ owner, repo, number }) {
      return fetchConversation(run, owner, repo, number);
    },
    async gh_submit_review({ owner, repo, number, commitId, event, body, comments }) {
      const payload = {
        commit_id: commitId,
        event,
        body,
        comments: comments.map((c) => ({
          path: c.path,
          line: c.line,
          side: c.side,
          body: c.body,
          ...(c.startLine !== null && c.startLine < c.line ? { start_line: c.startLine, start_side: c.side } : {}),
        })),
      };
      const result = await run("gh", ["api", "-X", "POST", `repos/${owner}/${repo}/pulls/${number}/reviews`, "--input", "-"], { input: JSON.stringify(payload) });
      const parsed = ghJson<{ html_url?: string; id?: number }>(result.stdout);
      return { url: parsed.html_url ?? null, id: parsed.id ?? null };
    },
    gh_description(input) { return readDescription(run, input); },
    gh_edit_body(input) { return editBody(run, input); },
    async gh_reply({ owner, repo, number, commentId, body }) {
      await run("gh", ["api", "-X", "POST", `repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`, "--input", "-"], { input: JSON.stringify({ body }) });
      return { ok: true as const };
    },
    async gh_set_draft({ owner, repo, number, draft }) {
      const args = ["pr", "ready", String(number), "--repo", `${owner}/${repo}`];
      if (draft) args.push("--undo");
      const result = await run("gh", args, { allowFailure: true });
      if (result.code !== 0) {
        const msg = (result.stderr || result.stdout).trim();
        if (!/already (ready for review|a draft)/i.test(msg)) {
          throw new Error(msg.slice(0, 600) || "failed to set draft state");
        }
      }
      return { isDraft: draft };
    },
    gh_own_prs() { return fetchOwnPullRequests(run); },
    gh_pr_statuses({ prs }) { return fetchPrStatuses(run, prs); },
    async gh_stack(input) {
      return { stack: await fetchPullRequestStack(run, input) };
    },
    async gh_resolve({ threadId, resolve }) {
      const mutation = resolve
        ? `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }`
        : `mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }`;
      await run("gh", ["api", "graphql", "-f", `query=${mutation}`, "-F", `id=${threadId}`]);
      return { ok: true as const };
    },
  },
});
