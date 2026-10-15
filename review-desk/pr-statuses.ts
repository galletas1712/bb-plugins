import { prStatusesSchema } from "./host-contract";
import type { GhRun } from "./stack-fetch";

/** One scalar-only GraphQL request for a batch, including closed PRs that may reopen. */
export async function fetchPrStatuses(run: GhRun, prs: { owner: string; repo: string; number: number }[]) {
  if (prs.length === 0) return { prs: [], errors: [] };
  const fields = `number title body state isDraft url author { login } baseRefName headRefName
    headRefOid baseRefOid additions deletions changedFiles reviewDecision mergeable updatedAt createdAt`;
  const query = `query { ${prs.map((pr, index) => `r${index}: repository(owner: ${JSON.stringify(pr.owner)}, name: ${JSON.stringify(pr.repo)}) {
    pullRequest(number: ${pr.number}) { ${fields} }
  }`).join("\n")} }`;
  const result = await run("gh", ["api", "graphql", "-f", `query=${query}`], { allowFailure: true });
  if (!result.stdout.trim().startsWith("{")) throw new Error(`Could not scan PR status: ${(result.stderr || result.stdout).slice(0, 400)}`);
  const response = JSON.parse(result.stdout) as { data?: Record<string, { pullRequest?: unknown } | null>; errors?: { message: string }[] };
  if (!response.data) throw new Error(`Could not scan PR status: ${(response.errors?.map((e) => e.message).join("; ") || result.stderr || "missing response").slice(0, 400)}`);
  const errors = (response.errors ?? []).map((error) => error.message);
  const found = prs.flatMap((pr, index) => {
    const node = response.data?.[`r${index}`]?.pullRequest;
    if (!node) { errors.push(`Could not scan ${pr.owner}/${pr.repo}#${pr.number}`); return []; }
    return [{ ...node as object, owner: pr.owner, repo: pr.repo }];
  });
  return prStatusesSchema.parse({ prs: found, errors });
}
