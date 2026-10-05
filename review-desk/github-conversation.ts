import type { GhEvent, GhPr, GhThread } from "./host-contract";

import { commentPermissions } from "./lib/github-edit";

type Run = (cmd: string, args: string[], options?: { input?: string }) => Promise<{ stdout: string }>;
interface PageInfo { hasNextPage: boolean; endCursor: string | null }
interface Comment {
  id: string;
  databaseId: string | number | null;
  viewerCanUpdate: boolean;
  viewerDidAuthor: boolean;
  replyTo: { id: string } | null;
  author: { login: string } | null;
  body: string;
  createdAt: string;
  url: string | null;
}
interface CommentPage { pageInfo: PageInfo; nodes: Comment[] }
interface ThreadNode extends Omit<GhThread, "side" | "startSide" | "comments"> {
  diffSide: "LEFT" | "RIGHT";
  startDiffSide: "LEFT" | "RIGHT" | null;
  comments: CommentPage;
}

const COMMENTS = `comments(first: 100, after: $commentAfter) {
  pageInfo { hasNextPage endCursor }
  nodes { id databaseId: fullDatabaseId viewerCanUpdate viewerDidAuthor replyTo { id } author { login } body createdAt url }
}`;
const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String, $commentAfter: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine startLine originalStartLine diffSide startDiffSide subjectType
          ${COMMENTS}
        }
      }
    }
  }
}`;
const COMMENTS_QUERY = `query($id: ID!, $commentAfter: String) {
  node(id: $id) { ... on PullRequestReviewThread { ${COMMENTS} } }
}`;

async function graphql<T>(run: Run, query: string, variables: Record<string, string | number>): Promise<T> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
  const result = JSON.parse((await run("gh", args)).stdout) as { data: T; errors?: { message: string }[] };
  if (result.errors?.length) throw new Error(result.errors.map((e) => e.message).join("; "));
  return result.data;
}

function nextCursor(page: PageInfo, seen: Set<string>): string | null {
  if (!page.hasNextPage) return null;
  if (page.endCursor === null || seen.has(page.endCursor)) throw new Error("GitHub returned an invalid pagination cursor");
  seen.add(page.endCursor);
  return page.endCursor;
}

/** Fetch every review thread and every reply, including resolved and file-level threads. */
export async function fetchReviewThreads(run: Run, owner: string, repo: string, number: number): Promise<GhThread[]> {
  const threads: GhThread[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  do {
    const result: { repository: { pullRequest: { reviewThreads: { pageInfo: PageInfo; nodes: ThreadNode[] } } | null } | null } = await graphql(run, THREADS_QUERY, { owner, repo, number, ...(after === null ? {} : { after }) });
    const page = result.repository?.pullRequest?.reviewThreads;
    if (!page) throw new Error(`Pull request ${owner}/${repo}#${number} is unavailable`);
    for (const node of page.nodes) {
      const comments = [...node.comments.nodes];
      const commentCursors = new Set<string>();
      let commentAfter = nextCursor(node.comments.pageInfo, commentCursors);
      while (commentAfter !== null) {
        const result: { node: { comments: CommentPage } | null } = await graphql(run, COMMENTS_QUERY, { id: node.id, commentAfter });
        if (!result.node) throw new Error(`Review thread ${node.id} is unavailable`);
        comments.push(...result.node.comments.nodes);
        commentAfter = nextCursor(result.node.comments.pageInfo, commentCursors);
      }
      threads.push({
        id: node.id,
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
        path: node.path,
        line: node.line,
        originalLine: node.originalLine,
        startLine: node.startLine,
        originalStartLine: node.originalStartLine,
        subjectType: node.subjectType,
        side: node.diffSide,
        startSide: node.startDiffSide,
        comments: comments.map(({ viewerCanUpdate, viewerDidAuthor, replyTo, ...c }) => ({ ...c, replyToId: replyTo?.id ?? null, databaseId: c.databaseId === null ? null : Number(c.databaseId), canEdit: viewerCanUpdate && viewerDidAuthor === true, author: c.author?.login ?? "ghost" })),
      });
    }
    after = nextCursor(page.pageInfo, seen);
  } while (after !== null);
  return threads;
}

export async function fetchConversation(run: Run, owner: string, repo: string, number: number) {
  const [comments, reviews, timeline] = await Promise.all([
    run("gh", ["api", "--paginate", "--slurp", `repos/${owner}/${repo}/issues/${number}/comments?per_page=100`]),
    run("gh", ["api", "--paginate", "--slurp", `repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`]),
    run("gh", ["api", "--paginate", "--slurp", `repos/${owner}/${repo}/issues/${number}/timeline?per_page=100`]),
  ]);
  type IssueComment = { id: number; node_id: string; user: { login: string } | null; body: string; created_at: string; html_url: string };
  type Review = { id: number; node_id: string; user: { login: string } | null; state: string; body: string; submitted_at: string | null; html_url: string };
  const publishedComments = (JSON.parse(comments.stdout) as IssueComment[][]).flat();
  const publishedReviews = (JSON.parse(reviews.stdout) as Review[][]).flat().filter((r) => r.state !== "PENDING");
  const permissions = await commentPermissions(run, [...publishedComments, ...publishedReviews].map((comment) => comment.node_id));
  return {
    comments: publishedComments.map((c) => ({ id: c.id, nodeId: c.node_id, canEdit: permissions.get(c.node_id) ?? false, author: c.user?.login ?? "ghost", body: c.body ?? "", createdAt: c.created_at, url: c.html_url })),
    reviews: publishedReviews.map((r) => ({ id: r.id, nodeId: r.node_id, canEdit: permissions.get(r.node_id) ?? false, author: r.user?.login ?? "ghost", state: r.state, body: r.body ?? "", submittedAt: r.submitted_at, url: r.html_url })),
    events: (JSON.parse(timeline.stdout) as TimelineEvent[][]).flat()
      .filter((event) => !["commented", "reviewed", "line-commented"].includes(event.event))
      .map((event, index) => timelineEvent(event, index, owner, repo, number)),
  };
}

interface TimelineEvent {
  id?: number | string;
  event: string;
  actor?: { login?: string } | null;
  user?: { login?: string } | null;
  author?: { login?: string; name?: string; date?: string } | null;
  committer?: { date?: string } | null;
  created_at?: string | null;
  submitted_at?: string | null;
  html_url?: string;
  sha?: string;
  commit_id?: string | null;
  message?: string;
  body?: string;
  label?: { name: string };
  milestone?: { title: string };
  assignee?: { login: string };
  requested_reviewer?: { login: string };
  requested_team?: { name: string };
  rename?: { from: string; to: string };
  source?: { issue?: { number: number; title: string; html_url: string } };
  dismissed_review?: { dismissal_message?: string };
  lock_reason?: string;
}

function timelineEvent(event: TimelineEvent, index: number, owner: string, repo: string, number: number): GhEvent {
  const sha = event.sha ?? event.commit_id;
  const issue = event.source?.issue;
  const details = [
    event.label?.name, event.milestone?.title, event.assignee?.login,
    event.requested_reviewer?.login, event.requested_team?.name,
    event.rename ? `${event.rename.from} → ${event.rename.to}` : null,
    issue ? `#${issue.number} ${issue.title}` : null,
    event.message ?? event.body, event.dismissed_review?.dismissal_message, event.lock_reason,
    sha,
  ].filter((value): value is string => typeof value === "string" && value !== "").join("\n");
  return {
    id: String(event.id ?? `${event.event}:${sha ?? index}`),
    event: event.event,
    actor: event.actor?.login ?? event.user?.login ?? event.author?.login ?? event.author?.name ?? null,
    createdAt: event.created_at ?? event.submitted_at ?? event.committer?.date ?? event.author?.date ?? null,
    url: event.html_url ?? issue?.html_url ?? (sha ? `https://github.com/${owner}/${repo}/commit/${sha}` : `https://github.com/${owner}/${repo}/pull/${number}#event-${event.id ?? ""}`),
    details,
  };
}

interface Connection<T> { pageInfo: PageInfo; nodes: T[] }
interface CommitNode { commit: { oid: string; messageHeadline: string; committedDate: string; author: { name: string | null; user: { login: string } | null } | null } }
interface ReviewNode { author: { login: string } | null; state: string }
interface RequestedReviewer { requestedReviewer: { login?: string; name?: string } | null }
interface CheckNode { name?: string; context?: string; status?: string; state?: string; conclusion?: string | null; detailsUrl?: string | null; targetUrl?: string | null }
interface PrMetadata {
  commits: Connection<CommitNode>;
  labels: Connection<{ name: string }>;
  assignees: Connection<{ login: string }>;
  latestReviews: Connection<ReviewNode>;
  reviewRequests: Connection<RequestedReviewer>;
}
interface CheckData { headCommit: { nodes: { commit: { statusCheckRollup: { contexts: Connection<CheckNode> } | null } }[] } }

const CONNECTION_FIELDS = {
  commits: "commit { oid messageHeadline committedDate author { name user { login } } }",
  labels: "name",
  assignees: "login",
  latestReviews: "author { login } state",
  reviewRequests: "requestedReviewer { ... on User { login } ... on Team { name } }",
} as const;
const CHECK_FIELDS = `headCommit: commits(last: 1) { nodes { commit { statusCheckRollup {
  contexts(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl } }
  }
} } } }`;
const connectionField = (name: keyof PrMetadata) => `${name}(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${CONNECTION_FIELDS[name]} } }`;

async function prQuery<T>(run: Run, owner: string, repo: string, number: number, fields: string, after: string | null = null): Promise<T> {
  const query = `query($owner: String!, $repo: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ${fields} } } }`;
  const data: { repository: { pullRequest: T | null } | null } = await graphql(run, query, { owner, repo, number, ...(after === null ? {} : { after }) });
  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error(`Pull request ${owner}/${repo}#${number} is unavailable`);
  return pr;
}

async function collect<T>(first: Connection<T>, fetch: (cursor: string) => Promise<Connection<T>>): Promise<T[]> {
  const nodes = [...first.nodes];
  const seen = new Set<string>();
  let cursor = nextCursor(first.pageInfo, seen);
  while (cursor !== null) {
    const page = await fetch(cursor);
    nodes.push(...page.nodes);
    cursor = nextCursor(page.pageInfo, seen);
  }
  return nodes;
}

/** GraphQL avoids the REST PR-commit endpoint's 250-commit ceiling. */
export async function fetchPrMetadata(run: Run, owner: string, repo: string, number: number, includeCommits = true): Promise<Pick<GhPr, "commits" | "labels" | "assignees" | "reviewers" | "checks">> {
  const fields = [...(Object.keys(CONNECTION_FIELDS) as (keyof PrMetadata)[]).filter((name) => includeCommits || name !== "commits").map(connectionField), CHECK_FIELDS].join("\n");
  const first = await prQuery<PrMetadata & CheckData>(run, owner, repo, number, fields);
  const connection = async <K extends keyof PrMetadata>(name: K) => collect(first[name] as Connection<PrMetadata[K]["nodes"][number]>, async (after) => {
    const page = await prQuery<PrMetadata>(run, owner, repo, number, connectionField(name), after);
    return page[name] as Connection<PrMetadata[K]["nodes"][number]>;
  });
  const firstChecks = first.headCommit.nodes[0]?.commit.statusCheckRollup?.contexts ?? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  const [commits, labels, assignees, reviews, requests, checks] = await Promise.all([
    includeCommits ? connection("commits") : Promise.resolve([]), connection("labels"), connection("assignees"), connection("latestReviews"), connection("reviewRequests"),
    collect(firstChecks, async (after) => {
      const page = await prQuery<CheckData>(run, owner, repo, number, CHECK_FIELDS, after);
      const contexts = page.headCommit.nodes[0]?.commit.statusCheckRollup?.contexts;
      if (!contexts) throw new Error("GitHub checks changed while fetching the next page; retry the refresh");
      return contexts;
    }),
  ]);
  const reviewers = new Map<string, string>();
  for (const review of reviews) if (review.author) reviewers.set(review.author.login, review.state);
  for (const request of requests) {
    const name = request.requestedReviewer?.login ?? request.requestedReviewer?.name;
    if (name) reviewers.set(name, "REQUESTED");
  }
  return {
    commits: commits.map(({ commit }) => ({ sha: commit.oid, title: commit.messageHeadline, author: commit.author?.user?.login ?? commit.author?.name ?? "unknown", date: commit.committedDate })),
    labels: labels.map((label) => label.name),
    assignees: assignees.map((assignee) => assignee.login),
    reviewers: [...reviewers].map(([login, state]) => ({ login, state })),
    checks: checks.map((check) => ({ name: check.name ?? check.context ?? "check", status: check.status ?? check.state ?? "unknown", conclusion: check.conclusion ?? check.state ?? null, url: check.detailsUrl ?? check.targetUrl ?? null })),
  };
}
