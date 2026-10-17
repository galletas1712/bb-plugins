import { mergeInputSchema, type MergeOptions, type MergeResult } from "../merge-contract";
import type { z } from "zod";

type Run = (cmd: string, args: string[], options?: { input?: string }) => Promise<{ stdout: string }>;
interface PrRef { owner: string; repo: string; number: number }
interface Pr { number: number; state: string; isDraft: boolean; headRefOid: string }
interface BranchRule { type: string; parameters?: { allowed_merge_methods?: string[]; merge_method?: string } }
interface Repository {
  mergeCommitAllowed: boolean; squashMergeAllowed: boolean; rebaseMergeAllowed: boolean; viewerPermission: string;
  viewerDefaultMergeMethod: "MERGE" | "SQUASH" | "REBASE";
  pullRequest: (Pr & {
    baseRefName: string; mergeable: string; mergeStateStatus: string;
    stack: { baseRefName: string; entries: { pageInfo: { hasNextPage: boolean }; nodes: { position: number; pullRequest: Pr }[] } } | null;
  }) | null;
}

const POLICY_AGE_MS = 10 * 60_000;
const POLICY_FIELDS = "mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerPermission viewerDefaultMergeMethod";
// Each runner belongs to a host worker and its authenticated gh environment.
const policies = new WeakMap<Run, {
  repositories: Map<string, { value: Omit<Repository, "pullRequest">; at: number }>;
  branches: Map<string, { work: Promise<BranchRule[]>; at: number }>;
}>();

/** Read the merge action and its full downstack scope with the merging identity. */
export async function readMergeOptions(run: Run, ref: PrRef, freshPolicy = false): Promise<MergeOptions> {
  let cache = policies.get(run);
  if (!cache) { cache = { repositories: new Map(), branches: new Map() }; policies.set(run, cache); }
  const repoKey = `${ref.owner}/${ref.repo}`.toLowerCase();
  const saved = cache.repositories.get(repoKey);
  const cachedPolicy = !freshPolicy && saved && Date.now() - saved.at < POLICY_AGE_MS ? saved.value : null;
  const response = JSON.parse((await run("gh", ["api", "graphql", "--input", "-"], { input: JSON.stringify({
    query: `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        ${cachedPolicy ? "" : POLICY_FIELDS}
        pullRequest(number: $number) {
          number state isDraft headRefOid baseRefName mergeable mergeStateStatus
          stack { baseRefName entries(first: 100) {
            pageInfo { hasNextPage }
            nodes { position pullRequest { number state isDraft headRefOid } }
          } }
        }
      }
    }`, variables: { owner: ref.owner, repo: ref.repo, number: ref.number },
  }) })).stdout) as { data: { repository: Repository | null }; errors?: { message: string }[] };
  if (response.errors?.length) throw new Error(response.errors.map((e) => e.message).join("\n"));
  const current = response.data.repository;
  const pr = current?.pullRequest;
  if (!current || !pr) throw new Error("Pull request not found on GitHub.");
  const repo = { ...cachedPolicy, ...current };
  if (!cachedPolicy) {
    const { pullRequest, ...value } = current;
    cache.repositories.set(repoKey, { value, at: Date.now() });
  }
  const entries = pr.stack?.entries;
  const position = entries?.nodes.find((entry) => entry.pullRequest.number === ref.number)?.position;
  if (entries?.pageInfo.hasNextPage || entries && position === undefined) throw new Error("Cannot determine the complete merge scope. Open this pull request on GitHub to merge it.");
  const affected = entries ? entries.nodes.filter((entry) => entry.position <= position!).sort((a, b) => a.position - b.position).map((entry) => entry.pullRequest).filter((pr) => pr.state === "OPEN") : [pr];
  let methods: MergeOptions["methods"] = [];
  if (repo.mergeCommitAllowed) methods.push("merge");
  if (repo.squashMergeAllowed) methods.push("squash");
  if (repo.rebaseMergeAllowed) methods.push("rebase");
  const baseRefName = pr.stack?.baseRefName ?? pr.baseRefName;
  const branchKey = `${repoKey}:${baseRefName}`;
  let branch = cache.branches.get(branchKey);
  if (freshPolicy || !branch || Date.now() - branch.at >= POLICY_AGE_MS) {
    const next = { at: Date.now(), work: run("gh", ["api", "--paginate", "--slurp", "-H", "X-GitHub-Api-Version: 2026-03-10", `repos/${ref.owner}/${ref.repo}/rules/branches/${encodeURIComponent(baseRefName)}?per_page=100`]).then((result) => (JSON.parse(result.stdout) as BranchRule[][]).flat()) };
    cache.branches.set(branchKey, next);
    void next.work.catch(() => { if (cache!.branches.get(branchKey) === next) cache!.branches.delete(branchKey); });
    branch = next;
  }
  const rules = await branch.work;
  for (const rule of rules) {
    const allowed = rule.type === "pull_request" ? rule.parameters?.allowed_merge_methods
      : rule.type === "required_linear_history" ? ["squash", "rebase"]
      : rule.type === "merge_queue" && rule.parameters?.merge_method ? [rule.parameters.merge_method.toLowerCase()] : undefined;
    if (allowed) methods = methods.filter((method) => allowed.includes(method));
  }
  const reason = pr.state !== "OPEN" ? "This pull request is already closed or merged."
    : !["WRITE", "MAINTAIN", "ADMIN"].includes(repo.viewerPermission) ? "Your GitHub account does not have permission to merge."
    : affected.some((pr) => pr.isDraft) ? "Mark draft pull requests ready before merging."
    : rules.some((rule) => rule.type === "merge_queue") ? "This branch requires a merge queue. Merge it on GitHub."
    : methods.length === 0 ? "The repository and branch rules do not allow a common merge method."
    : pr.mergeable === "CONFLICTING" ? "Resolve merge conflicts before merging."
    : ["BLOCKED", "BEHIND", "DRAFT"].includes(pr.mergeStateStatus) ? "GitHub merge requirements have not been met."
    : pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN" ? "GitHub is checking whether this pull request can be merged."
    : null;
  const defaultMethod = methods.find((method) => method.toUpperCase() === repo.viewerDefaultMergeMethod) ?? methods[0] ?? null;
  return { methods, defaultMethod, reason, headSha: pr.headRefOid, baseRefName, prs: affected.map((pr) => ({ number: pr.number, headSha: pr.headRefOid })) };
}

interface ApiResult { status: MergeResult["status"]; details?: { uuid?: string; message?: string } }
function mergeResult(result: ApiResult): MergeResult {
  if (!["pending", "merged", "enqueued", "failed"].includes(result.status)) throw new Error("GitHub returned an unknown merge result. Check the pull request on GitHub before retrying.");
  if (result.status === "pending" && !result.details?.uuid) throw new Error("GitHub did not return a merge request ID. Check the pull request on GitHub before retrying.");
  return { status: result.status, requestId: result.details?.uuid ?? null, message: result.details?.message ?? "" };
}

export async function mergePr(run: Run, input: PrRef & z.infer<typeof mergeInputSchema>): Promise<MergeResult> {
  const current = await readMergeOptions(run, input, true);
  if (current.reason) throw new Error(current.reason);
  if (!current.methods.includes(input.method)) throw new Error("This merge method is no longer allowed. Refresh the merge options.");
  const { headSha, baseRefName, prs } = current;
  if (headSha !== input.expected.headSha || baseRefName !== input.expected.baseRefName || JSON.stringify(prs) !== JSON.stringify(input.expected.prs)) {
    throw new Error("The pull request or stack changed. Refresh and review the merge action again.");
  }
  // The async API is required for native stacks. Explicit direct_merge keeps
  // the named action from silently becoming auto-merge or a merge-queue action.
  const response = await run("gh", ["api", "-H", "X-GitHub-Api-Version: 2026-03-10", "-X", "PUT", `repos/${input.owner}/${input.repo}/pulls/${input.number}/merge-async`, "--input", "-"], {
    input: JSON.stringify({ sha: headSha, merge_method: input.method, merge_action: "direct_merge", bypass_rules: false }),
  });
  return mergeResult(JSON.parse(response.stdout));
}

export async function readMergeResult(run: Run, input: PrRef & { requestId: string }): Promise<MergeResult> {
  const response = await run("gh", ["api", "-H", "X-GitHub-Api-Version: 2026-03-10", `repos/${input.owner}/${input.repo}/pulls/${input.number}/merge-async/${input.requestId}`]);
  return mergeResult(JSON.parse(response.stdout));
}
