// Shared RPC contract between server.ts (client) and host.ts (worker on the
// machine that holds the repository). Everything that touches git, gh, or the
// filesystem of the checkout goes through here.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const changedFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed", "copied", "type_changed", "unknown"]),
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

export const ghUserSchema = z.object({ login: z.string() }).nullable();

export const ghPrSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  url: z.string(),
  author: ghUserSchema,
  baseRefName: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefOid: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  reviewDecision: z.string().nullable(),
  mergeable: z.string().nullable(),
  updatedAt: z.string(),
  checks: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable(), url: z.string().nullable() })),
  labels: z.array(z.string()),
  reviewers: z.array(z.object({ login: z.string(), state: z.string() })),
  assignees: z.array(z.string()),
  commits: z.array(z.object({ sha: z.string(), title: z.string(), author: z.string(), date: z.string() })),
  createdAt: z.string(),
});
export type GhPr = z.infer<typeof ghPrSchema>;
const ghPrStatusSchema = ghPrSchema.omit({ commits: true, labels: true, assignees: true, reviewers: true, checks: true });
export type GhPrStatus = z.infer<typeof ghPrStatusSchema>;
const ghPrDetailsSchema = ghPrSchema.pick({ commits: true, labels: true, assignees: true, reviewers: true, checks: true }).extend({ commits: ghPrSchema.shape.commits.nullable() });

export const ghCommentSchema = z.object({
  id: z.string(),
  replyToId: z.string().nullable().default(null),
  databaseId: z.number().nullable(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string().nullable(),
  canEdit: z.boolean().default(false),
});
export type GhComment = z.infer<typeof ghCommentSchema>;

export const ghThreadSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string(),
  line: z.number().nullable(),
  originalLine: z.number().nullable(),
  startLine: z.number().nullable(),
  originalStartLine: z.number().nullable().default(null),
  startSide: z.enum(["LEFT", "RIGHT"]).nullable().default(null),
  subjectType: z.enum(["LINE", "FILE"]).default("LINE"),
  side: z.enum(["LEFT", "RIGHT"]),
  comments: z.array(ghCommentSchema),
});
export type GhThread = z.infer<typeof ghThreadSchema>;

export const ghIssueCommentSchema = z.object({
  id: z.number(),
  nodeId: z.string().nullable().default(null),
  canEdit: z.boolean().default(false),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string(),
});
export type GhIssueComment = z.infer<typeof ghIssueCommentSchema>;
export const ghReviewSchema = z.object({
  id: z.number(),
  nodeId: z.string().nullable().default(null),
  canEdit: z.boolean().default(false),
  author: z.string(),
  state: z.string(),
  body: z.string(),
  submittedAt: z.string().nullable(),
  url: z.string(),
});
export type GhReview = z.infer<typeof ghReviewSchema>;

export const ghEditTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("description") }),
  z.object({ kind: z.enum(["comment", "review", "inline"]), id: z.string().min(1) }),
]);
export type GhEditTarget = z.infer<typeof ghEditTargetSchema>;
export const ghBodyEditSchema = z.object({
  target: ghEditTargetSchema,
  body: z.string().max(65_536),
  expectedBody: z.string(),
});

export const ghEventSchema = z.object({
  id: z.string(),
  event: z.string(),
  actor: z.string().nullable(),
  createdAt: z.string().nullable(),
  url: z.string().nullable(),
  details: z.string(),
});
export type GhEvent = z.infer<typeof ghEventSchema>;

/** One pull request in a GitHub (or inferred) stack, ordered from trunk upward. */
export const prStackEntrySchema = z.object({
  position: z.number(),
  number: z.number(),
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  merged: z.boolean(),
  url: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  reviewDecision: z.string().nullable(),
  headRefName: z.string(),
  headSha: z.string(),
  baseRefName: z.string(),
  /** Changed paths in this layer, used to mark files that also change in other layers. */
  files: z.array(z.string()),
});
export type PrStackEntry = z.infer<typeof prStackEntrySchema>;

export const prStackSchema = z.object({
  /** GitHub stack number; null when the chain was inferred from PR bases. */
  number: z.number().nullable(),
  baseRefName: z.string(),
  source: z.enum(["github", "inferred"]),
  entries: z.array(prStackEntrySchema),
});
export type PrStack = z.infer<typeof prStackSchema>;

export const hostContract = defineRpcContract({
  /** Fetch the PR head and base, and keep a detached worktree at the head. */
  repo_prepare: {
    input: z.object({
      repoPath: z.string(),
      number: z.number(),
      headSha: z.string(),
      baseRefName: z.string(),
      worktreesDir: z.string(),
      key: z.string(),
    }),
    output: z.object({ worktree: z.string(), headSha: z.string(), baseSha: z.string() }),
  },
  /** Drop a PR worktree after the review is removed. */
  repo_release: {
    input: z.object({ repoPath: z.string(), worktree: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  repo_clone: {
    input: z.object({ owner: z.string(), repo: z.string(), dest: z.string() }),
    output: z.object({ repoPath: z.string() }),
  },
  git_files: {
    input: z.object({ worktree: z.string(), baseSha: z.string(), headSha: z.string() }),
    output: z.object({ files: z.array(changedFileSchema) }),
  },
  git_patch: {
    input: z.object({ worktree: z.string(), baseSha: z.string(), headSha: z.string(), path: z.string(), oldPath: z.string().nullable() }),
    output: z.object({ patch: z.string() }),
  },
  git_show: {
    input: z.object({ worktree: z.string(), sha: z.string(), path: z.string() }),
    output: z.object({ content: z.string().nullable(), binary: z.boolean() }),
  },
  /** Message, author, date, and parents of one commit. */
  git_commit: {
    input: z.object({ worktree: z.string(), sha: z.string() }),
    output: z.object({ sha: z.string(), parents: z.array(z.string()), author: z.string(), date: z.string(), title: z.string(), body: z.string() }),
  },
  gh_pr: {
    input: z.object({ owner: z.string(), repo: z.string(), number: z.number() }),
    output: ghPrSchema,
  },
  gh_pr_status: {
    input: z.object({ owner: z.string(), repo: z.string(), number: z.number() }),
    output: ghPrStatusSchema,
  },
  gh_pr_details: {
    input: z.object({ owner: z.string(), repo: z.string(), number: z.number(), includeCommits: z.boolean() }),
    output: ghPrDetailsSchema,
  },
  gh_threads: {
    input: z.object({ owner: z.string(), repo: z.string(), number: z.number() }),
    output: z.object({ threads: z.array(ghThreadSchema) }),
  },
  gh_conversation: {
    input: z.object({ owner: z.string(), repo: z.string(), number: z.number() }),
    output: z.object({ comments: z.array(ghIssueCommentSchema), reviews: z.array(ghReviewSchema), events: z.array(ghEventSchema) }),
  },
  gh_description: {
    input: z.object({ owner: z.string(), repo: z.string(), number: z.number() }),
    output: z.object({ body: z.string(), canEdit: z.boolean() }),
  },
  gh_edit_body: {
    input: ghBodyEditSchema.extend({ owner: z.string(), repo: z.string(), number: z.number() }),
    output: z.object({ body: z.string() }),
  },
  gh_submit_review: {
    input: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number(),
      commitId: z.string(),
      event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
      body: z.string(),
      comments: z.array(
        z.object({
          path: z.string(),
          line: z.number(),
          side: z.enum(["LEFT", "RIGHT"]),
          startLine: z.number().nullable(),
          body: z.string(),
        }),
      ),
    }),
    output: z.object({ url: z.string().nullable(), id: z.number().nullable() }),
  },
  gh_reply: {
    input: z.object({ owner: z.string(), repo: z.string(), number: z.number(), commentId: z.number(), body: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  /** Mark the PR ready for review, or convert it back to draft. */
  gh_set_draft: {
    input: z.object({ owner: z.string(), repo: z.string(), number: z.number(), draft: z.boolean() }),
    output: z.object({ isDraft: z.boolean() }),
  },
  gh_resolve: {
    input: z.object({ threadId: z.string(), resolve: z.boolean() }),
    output: z.object({ ok: z.literal(true) }),
  },
  /**
   * The GitHub stack this PR (or stack number) belongs to. Null when the PR is
   * not stacked. `number` is a PR; `stackNumber` is the repo-scoped stack id
   * from `gh stack` / github.com. Pass exactly one.
   */
  gh_stack: {
    input: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number().nullable(),
      stackNumber: z.number().nullable(),
      metadataOnly: z.boolean().optional(),
    }),
    output: z.object({ stack: prStackSchema.nullable() }),
  },

});
export type HostContract = typeof hostContract;
