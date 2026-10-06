// Discover a GitHub PR stack on the host: native Stack API first, then a
// base/head walk when the repo has not enabled stacked PRs.
import type { PrStack, PrStackEntry } from "./host-contract";

export type GhRun = (
  cmd: string,
  args: string[],
  options?: { allowFailure?: boolean; input?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

const API_VERSION = "2026-03-10";

const STACK_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      stackEntry { position }
      stack {
        number
        size
        baseRefName
        entries(first: 50, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            position
            pullRequest {
              number
              title
              state
              isDraft
              url
              additions
              deletions
              changedFiles
              reviewDecision
              headRefName
              headRefOid
              baseRefName
              merged
              files(first: 100) {
                pageInfo { hasNextPage endCursor }
                nodes { path }
              }
            }
          }
        }
      }
    }
  }
}`;

const STACK_QUERY_LITE = `
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      stack {
        number
        size
        baseRefName
        entries(first: 50, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            position
            pullRequest {
              number
              title
              state
              isDraft
              url
              additions
              deletions
              changedFiles
              reviewDecision
              headRefName
              headRefOid
              baseRefName
              mergedAt
            }
          }
        }
      }
    }
  }
}`;

interface Connection<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

interface GqlPr {
  number: number;
  title?: string | null;
  state?: string | null;
  isDraft?: boolean | null;
  url?: string | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  reviewDecision?: string | null;
  headRefName?: string | null;
  headRefOid?: string | null;
  baseRefName?: string | null;
  merged?: boolean | null;
  mergedAt?: string | null;
  files?: Connection<{ path?: string | null }> | null;
}

interface GqlStackData {
  repository?: {
    pullRequest?: {
      stack?: {
        number: number;
        size?: number;
        baseRefName?: string;
        entries?: Connection<{ position: number; pullRequest: GqlPr | null }>;
      } | null;
    } | null;
  } | null;
}

interface RestStackPr {
  number: number;
  state?: string;
  draft?: boolean;
  merged_at?: string | null;
  title?: string;
  html_url?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
}

interface RestStack {
  number: number;
  base?: { ref?: string };
  pull_requests?: RestStackPr[];
}

interface PrView {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  mergedAt: string | null;
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function isUnsupported(text: string): boolean {
  return /doesn'?t exist on type|cannot query field ['"]stack|Unknown type ['"]PullRequestStack|Not Found|404|stacks are not enabled|stacked pull requests/i.test(text);
}

async function ghApi(run: GhRun, path: string, extra: string[] = []): Promise<{ stdout: string; stderr: string; code: number }> {
  const withVersion = await run("gh", ["api", "-H", "Accept: application/vnd.github+json", "-H", `X-GitHub-Api-Version: ${API_VERSION}`, path, ...extra], { allowFailure: true });
  if (withVersion.code !== 0 && /api version|unknown.*version|invalid.*version/i.test(`${withVersion.stderr}${withVersion.stdout}`)) {
    return run("gh", ["api", "-H", "Accept: application/vnd.github+json", path, ...extra], { allowFailure: true });
  }
  return withVersion;
}

async function ghGraphql<T>(run: GhRun, query: string, vars: Record<string, string | number | null>): Promise<{ data: T | null; errors: string[] }> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(vars)) {
    if (value === null) continue;
    args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
  }
  const result = await run("gh", args, { allowFailure: true });
  const raw = result.stdout.trim() || result.stderr;
  if (raw === "") return { data: null, errors: [result.stderr || "empty GraphQL response"] };
  try {
    const parsed = parseJson<{ data?: T; errors?: { message?: string }[] }>(result.stdout || "{}");
    const errors = (parsed.errors ?? []).map((e) => e.message ?? "Unknown GraphQL error");
    if (result.code !== 0 && errors.length === 0) errors.push(result.stderr || raw);
    return { data: parsed.data ?? null, errors };
  } catch {
    return { data: null, errors: [raw.slice(0, 400)] };
  }
}

function nextCursor(pageInfo: Connection<unknown>["pageInfo"], seen: Set<string>): string | null {
  if (!pageInfo.hasNextPage) return null;
  const cursor = pageInfo.endCursor;
  if (!cursor || seen.has(cursor)) throw new Error("GitHub returned an invalid pagination cursor while fetching a stack");
  seen.add(cursor);
  return cursor;
}

async function remainingFiles(run: GhRun, owner: string, repo: string, number: number, first: Connection<{ path?: string | null }>): Promise<string[]> {
  const files = new Set<string>();
  const seen = new Set<string>();
  let page = first;
  while (true) {
    for (const file of page.nodes) if (file.path) files.add(file.path);
    const after = nextCursor(page.pageInfo, seen);
    if (after === null) return [...files];
    const { data, errors } = await ghGraphql<{ repository?: { pullRequest?: { files?: typeof first } } }>(run, `
      query($owner: String!, $repo: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path } }
          }
        }
      }`, { owner, repo, number, after });
    const next = data?.repository?.pullRequest?.files;
    if (errors.length || !next) throw new Error(`Could not fetch all files for PR #${number}: ${errors.join("; ") || "missing file page"}`);
    page = next;
  }
}

function entryFromGql(node: { position: number; pullRequest: GqlPr | null }): PrStackEntry | null {
  const pr = node.pullRequest;
  if (pr === null || typeof pr.number !== "number") return null;
  const files = (pr.files?.nodes ?? []).map((n) => n.path).filter((p): p is string => typeof p === "string" && p !== "");
  return {
    position: node.position,
    number: pr.number,
    title: pr.title ?? `#${pr.number}`,
    state: (pr.state ?? "OPEN").toUpperCase(),
    isDraft: pr.isDraft === true,
    merged: pr.merged === true || pr.mergedAt != null,
    url: pr.url ?? "",
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changedFiles ?? files.length,
    reviewDecision: pr.reviewDecision ?? null,
    headRefName: pr.headRefName ?? "",
    headSha: pr.headRefOid ?? "",
    baseRefName: pr.baseRefName ?? "",
    files,
  };
}

async function graphqlStackWith(run: GhRun, query: string, owner: string, repo: string, number: number): Promise<PrStack | null | "unsupported" | "retry"> {
  const nodes: { position: number; pullRequest: GqlPr | null }[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  let meta: { number: number; baseRefName: string } | null = null;
  while (true) {
    const { data, errors } = await ghGraphql<GqlStackData>(run, query, { owner, repo, number, after });
    if (errors.length > 0) {
      if (after === null && errors.some(isUnsupported)) return "unsupported";
      if (after === null && errors.some((e) => /files|merged/i.test(e))) return "retry";
      throw new Error(`Could not fetch the complete PR stack: ${errors.join("; ")}`);
    }
    const pr = data?.repository?.pullRequest;
    if (!pr?.stack) {
      if (after !== null) throw new Error("The PR stack disappeared during pagination; reload to retry");
      return null;
    }
    meta = { number: pr.stack.number, baseRefName: pr.stack.baseRefName ?? "" };
    const conn = pr.stack.entries;
    if (conn === undefined) throw new Error("GitHub omitted the PR stack entries");
    nodes.push(...conn.nodes);
    after = nextCursor(conn.pageInfo, cursors);
    if (after === null) break;
  }
  if (meta === null) return null;
  const resolved = await mapLimit(nodes, 6, async (node) => {
    const entry = entryFromGql(node);
    if (entry && node.pullRequest?.files) entry.files = await remainingFiles(run, owner, repo, entry.number, node.pullRequest.files);
    return entry;
  });
  const entries = [...new Map(resolved.filter((e): e is PrStackEntry => e !== null).map((entry) => [entry.number, entry])).values()].sort((a, b) => a.position - b.position);
  if (entries.length === 0) return null;
  return { number: meta.number, baseRefName: meta.baseRefName || entries[0]?.baseRefName || "", source: "github", entries };
}

async function graphqlStack(run: GhRun, owner: string, repo: string, number: number): Promise<PrStack | null | "unsupported"> {
  const full = await graphqlStackWith(run, STACK_QUERY, owner, repo, number);
  if (full !== "retry") return full;
  const lite = await graphqlStackWith(run, STACK_QUERY_LITE, owner, repo, number);
  return lite === "retry" ? "unsupported" : lite;
}

function restToPartial(pr: RestStackPr, position: number, stackBase: string): PrStackEntry {
  return {
    position,
    number: pr.number,
    title: pr.title ?? `#${pr.number}`,
    state: (pr.state ?? "open").toUpperCase(),
    isDraft: pr.draft === true,
    merged: pr.merged_at !== null && pr.merged_at !== undefined,
    url: pr.html_url ?? "",
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changed_files ?? 0,
    reviewDecision: null,
    headRefName: pr.head?.ref ?? "",
    headSha: pr.head?.sha ?? "",
    baseRefName: pr.base?.ref ?? stackBase,
    files: [],
  };
}

async function restStackByQuery(run: GhRun, owner: string, repo: string, pullRequest: number): Promise<RestStack | null | "unsupported"> {
  const result = await ghApi(run, `repos/${owner}/${repo}/stacks?pull_request=${pullRequest}&per_page=100`, ["--paginate", "--slurp"]);
  const text = `${result.stdout}${result.stderr}`;
  if (result.code !== 0) {
    if (isUnsupported(text) || /404|Not Found|422/.test(text)) return "unsupported";
    throw new Error(`Could not fetch the PR stack: ${text}`);
  }
  const list = parseJson<RestStack[][]>(result.stdout).flat();
  return list[0] ?? null;
}

async function restStackByNumber(run: GhRun, owner: string, repo: string, stackNumber: number): Promise<RestStack | null | "unsupported"> {
  const result = await ghApi(run, `repos/${owner}/${repo}/stacks/${stackNumber}`, ["--paginate", "--slurp"]);
  const text = `${result.stdout}${result.stderr}`;
  if (result.code !== 0) {
    if (isUnsupported(text)) return "unsupported";
    throw new Error(`Could not fetch stack #${stackNumber}: ${text}`);
  }
  const pages = parseJson<RestStack[]>(result.stdout);
  if (!pages[0]) return null;
  return { ...pages[0], pull_requests: [...new Map(pages.flatMap((page) => page.pull_requests ?? []).map((pr) => [pr.number, pr])).values()] };
}

async function prView(run: GhRun, owner: string, repo: string, number: number): Promise<PrView | null> {
  const result = await run(
    "gh",
    ["pr", "view", String(number), "--repo", `${owner}/${repo}`, "--json", "number,title,state,isDraft,url,additions,deletions,changedFiles,reviewDecision,headRefName,headRefOid,baseRefName,mergedAt"],
    { allowFailure: true },
  );
  if (result.code !== 0) return null;
  try {
    const v = parseJson<PrView>(result.stdout);
    return { ...v, reviewDecision: v.reviewDecision ?? null, mergedAt: v.mergedAt ?? null };
  } catch {
    return null;
  }
}

async function prFiles(run: GhRun, owner: string, repo: string, number: number): Promise<string[]> {
  const result = await ghApi(run, `repos/${owner}/${repo}/pulls/${number}/files?per_page=100`, ["--paginate", "--slurp"]);
  if (result.code !== 0) throw new Error(`Could not fetch files for PR #${number}: ${result.stderr || result.stdout}`);
  const files = parseJson<{ filename?: string }[][]>(result.stdout).flat();
  return [...new Set(files.map((f) => f.filename).filter((p): p is string => typeof p === "string" && p !== ""))];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function mergeView(entry: PrStackEntry, view: PrView | null, files: string[]): PrStackEntry {
  if (view === null && files.length === 0) return entry;
  return {
    ...entry,
    title: view?.title || entry.title,
    state: (view?.state ?? entry.state).toUpperCase(),
    isDraft: view?.isDraft ?? entry.isDraft,
    merged: view !== null ? view.mergedAt !== null : entry.merged,
    url: view?.url || entry.url,
    additions: view?.additions ?? entry.additions,
    deletions: view?.deletions ?? entry.deletions,
    changedFiles: view?.changedFiles ?? entry.changedFiles,
    reviewDecision: view !== null ? view.reviewDecision : entry.reviewDecision,
    headRefName: view?.headRefName || entry.headRefName,
    headSha: view?.headRefOid || entry.headSha,
    baseRefName: view?.baseRefName || entry.baseRefName,
    files: files.length > 0 ? files : entry.files,
  };
}

async function enrich(run: GhRun, owner: string, repo: string, entries: PrStackEntry[], { fetchReviewDecision = false }: { fetchReviewDecision?: boolean } = {}): Promise<PrStackEntry[]> {
  return mapLimit(entries, 6, async (entry) => {
    // REST stack entries omit reviewDecision, even when their other metadata is complete.
    const needsView = fetchReviewDecision || entry.title.startsWith("#") || entry.headSha === "" || entry.url === "" || entry.additions === 0 && entry.changedFiles === 0;
    const view = needsView ? await prView(run, owner, repo, entry.number) : null;
    if (needsView && view === null) throw new Error(`Could not fetch PR #${entry.number} in the stack`);
    const metadata = mergeView(entry, view, entry.files);
    const files = metadata.files.length < metadata.changedFiles ? await prFiles(run, owner, repo, entry.number) : metadata.files;
    const merged = { ...metadata, files };
    if (merged.files.length < merged.changedFiles) throw new Error(`GitHub returned only ${merged.files.length} of ${merged.changedFiles} files for PR #${entry.number}`);
    return merged;
  });
}

function fromRest(stack: RestStack): PrStack | null {
  const prs = stack.pull_requests ?? [];
  if (prs.length === 0) return null;
  const baseRefName = stack.base?.ref ?? prs[0]?.base?.ref ?? "";
  const entries = prs.map((pr, i) => restToPartial(pr, i + 1, baseRefName));
  return { number: stack.number, baseRefName, source: "github", entries };
}

async function relatedPr(run: GhRun, owner: string, repo: string, ref: string, field: "headRefName" | "baseRefName"): Promise<PrView | null> {
  const query = `
    query($owner: String!, $repo: String!, $ref: String!, $after: String) {
      repository(owner: $owner, name: $repo) {
        pullRequests(first: 100, after: $after, ${field}: $ref,
          ${field === "baseRefName" ? "states: [OPEN]," : ""}
          orderBy: { field: CREATED_AT, direction: DESC }) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number title state isDraft url additions deletions changedFiles reviewDecision
            headRefName headRefOid baseRefName mergedAt
          }
        }
      }
    }`;
  const list: PrView[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  while (true) {
    const { data, errors } = await ghGraphql<{ repository?: { pullRequests?: Connection<PrView> } }>(run, query, { owner, repo, ref, after });
    const connection = data?.repository?.pullRequests;
    if (errors.length || !connection) throw new Error(`Could not discover PRs for ${ref}: ${errors.join("; ") || "missing PR page"}`);
    list.push(...connection.nodes);
    after = nextCursor(connection.pageInfo, cursors);
    if (after === null) break;
  }
  return list.find((pr) => pr.state.toUpperCase() === "OPEN") ?? list[0] ?? null;
}

function viewToEntry(view: PrView, position: number): PrStackEntry {
  return {
    position,
    number: view.number,
    title: view.title,
    state: view.state.toUpperCase(),
    isDraft: view.isDraft,
    merged: view.mergedAt !== null,
    url: view.url,
    additions: view.additions,
    deletions: view.deletions,
    changedFiles: view.changedFiles,
    reviewDecision: view.reviewDecision,
    headRefName: view.headRefName,
    headSha: view.headRefOid,
    baseRefName: view.baseRefName,
    files: [],
  };
}

async function defaultBranch(run: GhRun, owner: string, repo: string): Promise<string> {
  const result = await run("gh", ["repo", "view", `${owner}/${repo}`, "--json", "defaultBranchRef"], { allowFailure: true });
  if (result.code !== 0) return "main";
  try {
    const parsed = parseJson<{ defaultBranchRef?: { name?: string } }>(result.stdout);
    return parsed.defaultBranchRef?.name ?? "main";
  } catch {
    return "main";
  }
}

async function inferStack(run: GhRun, owner: string, repo: string, seed: number): Promise<PrStack | null> {
  const seedView = await prView(run, owner, repo, seed);
  if (seedView === null) return null;
  const trunk = await defaultBranch(run, owner, repo);
  const down: PrView[] = [seedView];
  let current = seedView;
  const seen = new Set<number>([seedView.number]);
  while (current.baseRefName !== trunk) {
    const parent = await relatedPr(run, owner, repo, current.baseRefName, "headRefName");
    if (parent === null || seen.has(parent.number)) break;
    seen.add(parent.number);
    down.unshift(parent);
    current = parent;
  }
  current = seedView;
  while (true) {
    const child = await relatedPr(run, owner, repo, current.headRefName, "baseRefName");
    if (child === null || seen.has(child.number)) break;
    seen.add(child.number);
    down.push(child);
    current = child;
  }
  if (down.length < 2) return null;
  const entries = down.map((v, i) => viewToEntry(v, i + 1));
  const enriched = await enrich(run, owner, repo, entries);
  return { number: null, baseRefName: trunk, source: "inferred", entries: enriched };
}

/**
 * Resolve the stack for a PR number or a GitHub stack number.
 * Native GitHub stacks win; a base/head walk is used only when the Stack API
 * is not available on the repo.
 */
export async function fetchPullRequestStack(
  run: GhRun,
  input: { owner: string; repo: string; number: number | null; stackNumber: number | null },
): Promise<PrStack | null> {
  const { owner, repo, number, stackNumber } = input;
  if (stackNumber !== null) {
    const rest = await restStackByNumber(run, owner, repo, stackNumber);
    if (rest === "unsupported" || rest === null) return null;
    const stack = fromRest(rest);
    if (stack === null) return null;
    stack.entries = await enrich(run, owner, repo, stack.entries, { fetchReviewDecision: true });
    return stack;
  }
  if (number === null) return null;

  const gql = await graphqlStack(run, owner, repo, number);
  if (gql !== "unsupported") {
    if (gql === null) return null;
    gql.entries = await enrich(run, owner, repo, gql.entries);
    return gql;
  }

  const rest = await restStackByQuery(run, owner, repo, number);
  if (rest !== "unsupported") {
    if (rest === null) return null;
    const stack = fromRest(rest);
    if (stack === null) return null;
    stack.entries = await enrich(run, owner, repo, stack.entries, { fetchReviewDecision: true });
    return stack;
  }

  return inferStack(run, owner, repo, number);
}
