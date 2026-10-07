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

/** Fetch authored open PRs directly from the viewer connection, without search's result cap. */
export async function fetchOwnPullRequests(run: GhRun): Promise<OwnPrs> {
  type Node = Omit<OwnPrs["prs"][number], "owner" | "repo" | "headSha"> & {
    headRefOid: string; repository: { name: string; owner: { login: string } };
  };
  const prs = new Map<string, OwnPrs["prs"][number]>();
  const cursors = new Set<string>();
  let after: string | null = null;
  let login = "";
  do {
    const args = ["api", "graphql", "-f", `query=${QUERY}`];
    if (after !== null) args.push("-f", `after=${after}`);
    const result = await run("gh", args, { allowFailure: true });
    if (result.code !== 0) throw new Error(`Could not discover your pull requests: ${(result.stderr || result.stdout).slice(0, 400)}`);
    const response = JSON.parse(result.stdout) as {
      data?: { viewer?: { login: string; pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Node[] } } };
      errors?: { message: string }[];
    };
    if (response.errors?.length) throw new Error(`Could not discover your pull requests: ${response.errors.map((e) => e.message).join("; ")}`);
    const viewer = response.data?.viewer;
    if (!viewer?.pullRequests || (login !== "" && viewer.login !== login)) throw new Error("GitHub omitted or changed the account while discovering your pull requests");
    login = viewer.login;
    for (const node of viewer.pullRequests.nodes) {
      const { headRefOid, repository, ...metadata } = node;
      if (metadata.state !== "OPEN") continue;
      const pr = { ...metadata, headSha: headRefOid, owner: repository.owner.login, repo: repository.name };
      prs.set(`${pr.owner}/${pr.repo}#${pr.number}`, pr);
    }
    const page = viewer.pullRequests.pageInfo;
    after = page.hasNextPage ? page.endCursor : null;
    if (page.hasNextPage && (!after || cursors.has(after))) throw new Error("GitHub returned an invalid pagination cursor while discovering your pull requests");
    if (after) cursors.add(after);
  } while (after !== null);
  return ownPrsSchema.parse({ login, prs: [...prs.values()] });
}
