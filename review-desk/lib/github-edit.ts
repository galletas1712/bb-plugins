import type { GhEditTarget } from "../host-contract";

type Run = (cmd: string, args: string[], options?: { input?: string }) => Promise<{ stdout: string }>;
interface PullRequest { owner: string; repo: string; number: number }
interface EditableBody { id: string; body: string; viewerCanUpdate: boolean; viewerDidAuthor?: boolean }

async function graphql<T>(run: Run, query: string, variables: object): Promise<T> {
  const result = await run("gh", ["api", "graphql", "--input", "-"], { input: JSON.stringify({ query, variables }) });
  const response = JSON.parse(result.stdout) as { data: T; errors?: { message: string }[] };
  if (response.errors?.length) throw new Error(response.errors.map((error) => error.message).join("\n"));
  return response.data;
}

async function description(run: Run, pr: PullRequest): Promise<EditableBody> {
  const data = await graphql<{ repository: { pullRequest: EditableBody | null } | null }>(run, `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) { id body viewerCanUpdate }
      }
    }`, pr);
  const body = data.repository?.pullRequest;
  if (!body) throw new Error("Pull request not found on GitHub.");
  return body;
}

export async function readDescription(run: Run, pr: PullRequest): Promise<{ body: string; canEdit: boolean }> {
  const current = await description(run, pr);
  return { body: current.body, canEdit: current.viewerCanUpdate };
}

/** Fetch permissions with the same gh identity that will save the edits. */
export async function commentPermissions(run: Run, ids: string[]): Promise<Map<string, boolean>> {
  const permissions = new Map<string, boolean>();
  for (let start = 0; start < ids.length; start += 100) {
    const data = await graphql<{ nodes: ({ id: string; viewerCanUpdate: boolean; viewerDidAuthor: boolean } | null)[] }>(run, `
      query($ids: [ID!]!) {
        nodes(ids: $ids) {
          id
          ... on IssueComment { viewerCanUpdate viewerDidAuthor }
          ... on PullRequestReview { viewerCanUpdate viewerDidAuthor }
        }
      }`, { ids: ids.slice(start, start + 100) });
    for (const node of data.nodes) if (node) permissions.set(node.id, node.viewerCanUpdate && node.viewerDidAuthor === true);
  }
  return permissions;
}

const EDITS = {
  description: { type: "PullRequest", mutation: "updatePullRequest", input: "UpdatePullRequestInput", id: "pullRequestId", result: "pullRequest" },
  comment: { type: "IssueComment", mutation: "updateIssueComment", input: "UpdateIssueCommentInput", id: "id", result: "issueComment" },
  review: { type: "PullRequestReview", mutation: "updatePullRequestReview", input: "UpdatePullRequestReviewInput", id: "pullRequestReviewId", result: "pullRequestReview" },
  inline: { type: "PullRequestReviewComment", mutation: "updatePullRequestReviewComment", input: "UpdatePullRequestReviewCommentInput", id: "pullRequestReviewCommentId", result: "pullRequestReviewComment" },
} as const;

/** Validate scope, permission, and the original text before updating GitHub. */
export async function editBody(run: Run, input: PullRequest & { target: GhEditTarget; body: string; expectedBody: string }): Promise<{ body: string }> {
  const edit = EDITS[input.target.kind];
  let current: EditableBody;
  if (input.target.kind === "description") current = await description(run, input);
  else {
    const scope = input.target.kind === "comment" ? "issue" : "pullRequest";
    const data = await graphql<{ node: (EditableBody & { __typename: string; scope: { number: number; repository: { nameWithOwner: string } } }) | null }>(run, `
      query($id: ID!) {
        node(id: $id) {
          __typename
          ... on ${edit.type} {
            id body viewerCanUpdate viewerDidAuthor
            scope: ${scope} { number repository { nameWithOwner } }
          }
        }
      }`, { id: input.target.id });
    const node = data.node;
    if (!node || node.__typename !== edit.type || node.scope.number !== input.number || node.scope.repository.nameWithOwner.toLowerCase() !== `${input.owner}/${input.repo}`.toLowerCase()) {
      throw new Error("This comment does not belong to this pull request.");
    }
    if (!node.viewerDidAuthor) throw new Error("You can only edit your own comments.");
    current = node;
  }
  if (!current.viewerCanUpdate) throw new Error("Your GitHub account cannot edit this text.");
  if (current.body !== input.expectedBody) throw new Error("This text changed on GitHub. Cancel and reopen the editor to load the latest version.");
  if (input.target.kind !== "description" && input.body.trim() === "") throw new Error("Comments cannot be empty.");
  const data = await graphql<{ edit: { updated: { body: string } } }>(run, `
    mutation($input: ${edit.input}!) {
      edit: ${edit.mutation}(input: $input) { updated: ${edit.result} { body } }
    }`, { input: { [edit.id]: current.id, body: input.body } });
  return data.edit.updated;
}
