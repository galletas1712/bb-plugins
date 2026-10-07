// bb-plugin-review-desk — host entry. Runs on the machine that holds the
// repository: git for worktrees and diffs, gh for GitHub. No plugin storage here.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type ChangedFile, type GhPrStatus } from "./host-contract";
import { fetchPullRequestStack } from "./stack-fetch";
import { fetchOwnPullRequests } from "./own-prs";
import { editBody, readDescription } from "./lib/github-edit";
import { fetchConversation, fetchPrMetadata, fetchReviewThreads } from "./github-conversation";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

async function run(cmd: string, args: string[], options: { cwd?: string; input?: string; allowFailure?: boolean } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const child = execFileAsync(cmd, args, { cwd: options.cwd, maxBuffer: MAX_BUFFER, encoding: "utf8" });
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
}

const git = (cwd: string, args: string[], allowFailure = false) => run("git", args, { cwd, allowFailure });

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

async function listFiles(worktree: string, baseSha: string, headSha: string): Promise<ChangedFile[]> {
  const [status, numstat] = await Promise.all([
    git(worktree, ["diff", "--name-status", "-M", "-z", baseSha, headSha]),
    git(worktree, ["diff", "--numstat", "-M", "-z", baseSha, headSha]),
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

async function showFile(worktree: string, sha: string, filePath: string): Promise<{ content: string | null; binary: boolean }> {
  const result = await run("git", ["show", `${sha}:${filePath}`], { cwd: worktree, allowFailure: true });
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
  updatedAt: string;
  createdAt: string;
}

async function ghPrStatus(owner: string, repo: string, number: number): Promise<GhPrStatus> {
  const fields = "number,title,body,state,isDraft,url,author,baseRefName,headRefName,headRefOid,baseRefOid,additions,deletions,changedFiles,reviewDecision,mergeable,updatedAt,createdAt";
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
    updatedAt: view.updatedAt,

  };
}

// ---------------------------------------------------------------------------
// Host entry
// ---------------------------------------------------------------------------

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async repo_clone({ owner, repo, dest }, context) {
      const target = dest === "" ? path.join(context.experimental_paths.dataDir, "repos", `${owner}__${repo}`) : dest;
      mkdirSync(path.dirname(target), { recursive: true });
      if (!existsSync(path.join(target, ".git"))) {
        await run("gh", ["repo", "clone", `${owner}/${repo}`, target, "--", "--filter=blob:none"]);
      }
      return { repoPath: target };
    },
    async repo_prepare({ repoPath, number, headSha, baseRefName, worktreesDir, key }, context) {
      await git(repoPath, ["fetch", "--quiet", "origin", `+refs/pull/${number}/head:refs/review-desk/pr-${number}`, `+refs/heads/${baseRefName}:refs/remotes/origin/${baseRefName}`]);
      const dir = worktreesDir === "" ? path.join(context.experimental_paths.dataDir, "worktrees") : worktreesDir;
      mkdirSync(dir, { recursive: true });
      const worktree = path.join(dir, key);
      const registered = (await git(repoPath, ["worktree", "list", "--porcelain"])).stdout.includes(`worktree ${worktree}\n`);
      if (existsSync(worktree) && !registered) rmSync(worktree, { recursive: true, force: true });
      if (!registered) {
        await git(repoPath, ["worktree", "prune"]);
        await git(repoPath, ["worktree", "add", "--detach", worktree, headSha]);
      } else {
        const current = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
        if (current !== headSha) {
          const dirty = (await git(worktree, ["status", "--porcelain"])).stdout.trim() !== "";
          if (!dirty) await git(worktree, ["checkout", "--quiet", "--detach", headSha]);
        }
      }
      const baseSha = (await git(worktree, ["merge-base", headSha, `refs/remotes/origin/${baseRefName}`])).stdout.trim();
      return { worktree, headSha, baseSha };
    },
    async repo_release({ repoPath, worktree }) {
      if (worktree === "") return { ok: true as const };
      await git(repoPath, ["worktree", "remove", "--force", worktree], true);
      if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
      await git(repoPath, ["worktree", "prune"], true);
      return { ok: true as const };
    },
    async git_files({ worktree, baseSha, headSha }) {
      return { files: await listFiles(worktree, baseSha, headSha) };
    },
    async git_patch({ worktree, baseSha, headSha, path: filePath, oldPath }) {
      const targets = [...new Set([oldPath, filePath].filter((value): value is string => value !== null && value !== ""))];
      const result = await git(worktree, ["diff", "-M", "--no-color", "--no-ext-diff", baseSha, headSha, "--", ...targets]);
      return { patch: result.stdout };
    },
    async git_show({ worktree, sha, path: filePath }) {
      return showFile(worktree, sha, filePath);
    },
    async git_commit({ worktree, sha }) {
      const result = await git(worktree, ["show", "-s", "--format=%H%n%P%n%an%n%aI%n%s%n%b", sha]);
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
