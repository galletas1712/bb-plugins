import { ownPrsSchema, type OwnPrs } from "./host-contract";
import type { GhRun } from "./stack-fetch";

const QUERY = `query($after: String) {
  viewer {
    login
    pullRequests(first: 100, after: $after, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title state isDraft headRefOid additions deletions reviewDecision updatedAt
        repository { name owner { login } }
      }
    }
  }
}`;

// review-requested also includes team requests. user-review-requested is direct only.
const REQUESTED_QUERY = `query($after: String) {
  viewer { login }
  requested: search(query: "is:pr is:open user-review-requested:@me sort:updated-desc", type: ISSUE, first: 100, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title state isDraft headRefOid additions deletions reviewDecision updatedAt
        repository { name owner { login } }
      }
    }
  }
}`;

/** Discover authored PRs without search's cap, plus open PRs personally requested for review. */
export async function fetchOwnPullRequests(run: GhRun): Promise<OwnPrs> {
  type Node = Omit<OwnPrs["prs"][number], "owner" | "repo" | "headSha"> & {
    headRefOid: string; repository: { name: string; owner: { login: string } };
  };
  type Connection = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Node[]; issueCount?: number };
  const prs = new Map<string, OwnPrs["prs"][number]>();
  let login = "";
  for (const query of [QUERY, REQUESTED_QUERY]) {
    const cursors = new Set<string>();
    let after: string | null = null;
    do {
      const args = ["api", "graphql", "-f", `query=${query}`];
      if (after !== null) args.push("-f", `after=${after}`);
      const result = await run("gh", args, { allowFailure: true });
      if (result.code !== 0) throw new Error(`Could not discover your pull requests: ${(result.stderr || result.stdout).slice(0, 400)}`);
      const response = JSON.parse(result.stdout) as {
        data?: { viewer?: { login: string; pullRequests?: Connection }; requested?: Connection };
        errors?: { message: string }[];
      };
      if (response.errors?.length) throw new Error(`Could not discover your pull requests: ${response.errors.map((e) => e.message).join("; ")}`);
      const viewer = response.data?.viewer;
      const connection = query === QUERY ? viewer?.pullRequests : response.data?.requested;
      if (!viewer || !connection || (login !== "" && viewer.login !== login)) throw new Error("GitHub omitted or changed the account while discovering your pull requests");
      login = viewer.login;
      // Never replace the saved discovery snapshot with silently truncated search results.
      if ((connection.issueCount ?? 0) > 1000) throw new Error("GitHub search cannot discover more than 1,000 personal review requests");
      for (const node of connection.nodes) {
        const { headRefOid, repository, ...metadata } = node;
        if (metadata.state !== "OPEN") continue;
        const pr = { ...metadata, headSha: headRefOid, owner: repository.owner.login, repo: repository.name };
        prs.set(`${pr.owner}/${pr.repo}#${pr.number}`, pr);
      }
      const page = connection.pageInfo;
      after = page.hasNextPage ? page.endCursor : null;
      if (page.hasNextPage && (!after || cursors.has(after))) throw new Error("GitHub returned an invalid pagination cursor while discovering your pull requests");
      if (after) cursors.add(after);
    } while (after !== null);
  }
  return ownPrsSchema.parse({ login, prs: [...prs.values()] });
}
