// Review records, GitHub conversation, pending comments and private notes.
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createStackStore, type TrackedStack } from "./stack-store";
import { diffStats } from "./lib/diff-stats";
import { hunkLineNumbers } from "./diff-lines";
import {
  changedFileSchema,
  ghEventSchema,
  ghBodyEditSchema,
  ghIssueCommentSchema,
  ghReviewSchema,
  ghThreadSchema,
  hostContract,
  prStackEntrySchema,
  prStackSchema,
  type ChangedFile,
  type GhPr,
  type GhThread,
  type PrStack,
} from "./host-contract";

// ---------------------------------------------------------------------------
// Wire schemas (shared with app.tsx through type-only imports)
// ---------------------------------------------------------------------------

const sideSchema = z.enum(["old", "new"]);
export type Side = z.infer<typeof sideSchema>;

const checkSchema = z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable(), url: z.string().nullable() });

const reviewSchema = z.object({
  id: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  url: z.string(),
  author: z.string().nullable(),
  baseRefName: z.string(),
  headRefName: z.string(),
  headSha: z.string(),
  baseSha: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  reviewDecision: z.string().nullable(),
  mergeable: z.string().nullable(),
  labels: z.array(z.string()),
  checks: z.array(checkSchema),
  reviewers: z.array(z.object({ login: z.string(), state: z.string() })),
  assignees: z.array(z.string()),
  commits: z.array(z.object({ sha: z.string(), title: z.string(), author: z.string(), date: z.string() })),
  createdAt: z.string(),
  worktree: z.string(),
  environmentId: z.string().nullable(),
  hostId: z.string(),
  syncedAt: z.number(),
  ghUpdatedAt: z.string(),
});
export type Review = z.infer<typeof reviewSchema>;

const reviewSummarySchema = z.object({
  id: z.string().nullable(),
  owner: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  reviewDecision: z.string().nullable(),
  headSha: z.string(),
  additions: z.number(),
  deletions: z.number(),
  pendingCount: z.number(),
  updatedAt: z.number(),
  stack: z.object({
    number: z.number().nullable(),
    position: z.number(),
    size: z.number(),
    key: z.string(),
  }).nullable(),
});
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

const fileEntrySchema = changedFileSchema.extend({
  viewed: z.boolean(),
  threadCount: z.number(),
  unresolvedCount: z.number(),
  pendingCount: z.number(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

const pendingSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  path: z.string(),
  line: z.number(),
  startLine: z.number().nullable(),
  side: z.enum(["LEFT", "RIGHT"]),
  body: z.string(),
  createdAt: z.number(),
  /** The path or line is gone from the current reviewable diff. */
  stale: z.boolean(),
});
export type PendingComment = z.infer<typeof pendingSchema>;

const commitInfoSchema = z.object({ sha: z.string(), parents: z.array(z.string()), author: z.string(), date: z.string(), title: z.string(), body: z.string() });
export type CommitInfo = z.infer<typeof commitInfoSchema>;

/** A private note: visible only here until promoted to a pending GitHub comment. */
const noteSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  path: z.string(),
  line: z.number(),
  startLine: z.number().nullable(),
  side: z.enum(["LEFT", "RIGHT"]),
  body: z.string(),
  state: z.enum(["open", "dismissed", "promoted", "stale"]),
  createdAt: z.number(),
});
export type Note = z.infer<typeof noteSchema>;

const stackEntryViewSchema = prStackEntrySchema.extend({
  reviewId: z.string().nullable(),
  pendingCount: z.number(),
  viewedCount: z.number(),
});
const stackViewSchema = prStackSchema.extend({
  currentPosition: z.number(),
  entries: z.array(stackEntryViewSchema),
});
export type StackView = z.infer<typeof stackViewSchema>;

const okSchema = z.object({ ok: z.literal(true) });
const reviewIdSchema = z.object({ reviewId: z.string() });

export const rpcContract = defineRpcContract({
  reviews_list: { input: z.null(), output: z.object({ reviews: z.array(reviewSummarySchema) }) },
  reviews_open: { input: z.object({ ref: z.string().trim().min(1) }), output: z.object({ review: reviewSchema }) },
  reviews_get: {
    input: reviewIdSchema,
    output: z.object({
      review: reviewSchema,
      files: z.array(fileEntrySchema),
      pending: z.array(pendingSchema),
      threads: z.array(ghThreadSchema),
      notes: z.array(noteSchema),
      syncError: z.string().nullable(),
      /** Heads you opened this review at: the one before the current, and the current. */
      seen: z.object({ prevHead: z.string().nullable(), seenHead: z.string().nullable() }),
      stack: stackViewSchema.nullable(),
    }),
  },
  reviews_sync: { input: reviewIdSchema, output: z.object({ review: reviewSchema, headChanged: z.boolean() }) },
  reviews_remove: { input: reviewIdSchema, output: okSchema },
  stacks_remove: { input: z.object({ key: z.string() }), output: okSchema },
  review_patch: {
    input: z.object({ reviewId: z.string(), path: z.string() }),
    output: z.object({ patch: z.string(), file: changedFileSchema.nullable() }),
  },
  review_file: {
    input: z.object({ reviewId: z.string(), path: z.string(), side: sideSchema }),
    output: z.object({ content: z.string().nullable(), binary: z.boolean() }),
  },
  review_conversation: {
    input: z.object({ reviewId: z.string(), refresh: z.boolean().optional() }),
    output: z.object({ comments: z.array(ghIssueCommentSchema), reviews: z.array(ghReviewSchema), events: z.array(ghEventSchema), fetchedAt: z.number().nullable() }),
  },
  review_threads_refresh: { input: reviewIdSchema, output: z.object({ threads: z.array(ghThreadSchema) }) },
  review_description: { input: reviewIdSchema, output: z.object({ body: z.string(), canEdit: z.boolean() }) },
  review_edit_body: { input: ghBodyEditSchema.extend({ reviewId: z.string() }), output: z.object({ body: z.string() }) },
  viewed_set: { input: z.object({ reviewId: z.string(), path: z.string(), viewed: z.boolean() }), output: okSchema },
  pending_add: {
    input: z.object({
      reviewId: z.string(),
      path: z.string(),
      line: z.number().int().min(1),
      startLine: z.number().int().min(1).nullable().optional(),
      side: z.enum(["LEFT", "RIGHT"]),
      body: z.string().trim().min(1).max(20_000),
    }),
    output: z.object({ pending: pendingSchema }),
  },
  pending_update: { input: z.object({ id: z.string(), body: z.string().trim().min(1).max(20_000) }), output: z.object({ pending: pendingSchema }) },
  pending_delete: { input: z.object({ id: z.string() }), output: okSchema },
  /** Drop pending comments that no longer sit on the current diff. */
  pending_clear: { input: z.object({ reviewId: z.string(), staleOnly: z.literal(true) }), output: z.object({ removed: z.number() }) },
  review_submit: {
    input: z.object({ reviewId: z.string(), event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]), body: z.string().max(20_000) }),
    output: z.object({ url: z.string().nullable(), posted: z.number(), dropped: z.number() }),
  },
  /** Mark the PR ready for review on GitHub, or convert it back to draft. */
  review_set_draft: { input: z.object({ reviewId: z.string(), draft: z.boolean() }), output: z.object({ review: reviewSchema }) },
  thread_reply: { input: z.object({ reviewId: z.string(), commentId: z.number(), body: z.string().trim().min(1).max(20_000) }), output: okSchema },
  thread_resolve: { input: z.object({ reviewId: z.string(), threadId: z.string(), resolve: z.boolean() }), output: okSchema },
  note_add: {
    input: z.object({ reviewId: z.string(), path: z.string(), line: z.number().int().min(1), startLine: z.number().int().min(1).nullable().optional(), side: z.enum(["LEFT", "RIGHT"]), body: z.string().trim().min(1).max(20_000) }),
    output: z.object({ note: noteSchema }),
  },
  note_update: { input: z.object({ id: z.string(), state: z.enum(["open", "dismissed"]).optional(), body: z.string().trim().min(1).max(20_000).optional() }), output: z.object({ note: noteSchema }) },
  note_delete: { input: z.object({ id: z.string() }), output: okSchema },
  /** Turn a note into a pending GitHub comment; the note is kept as promoted. */
  note_promote: { input: z.object({ id: z.string() }), output: z.object({ pending: pendingSchema }) },
  /** Record that the review is open at its current head; returns the head it was last opened at before this one. */
  review_seen: { input: reviewIdSchema, output: z.object({ prevHead: z.string().nullable(), seenHead: z.string().nullable() }) },
  /**
   * A commit or a range of the PR as a diff. `to` alone diffs that commit
   * against its first parent; with `from`, the diff runs from `from` (or
   * from its parent when `inclusive`) to `to`.
   */
  commit_get: {
    input: z.object({ reviewId: z.string(), to: z.string(), from: z.string().optional(), inclusive: z.boolean().optional() }),
    output: z.object({ base: z.string(), head: z.string(), info: commitInfoSchema, commits: z.array(commitInfoSchema), files: z.array(changedFileSchema) }),
  },
  commit_patch: {
    input: z.object({ reviewId: z.string(), base: z.string(), head: z.string(), path: z.string(), oldPath: z.string().nullable() }),
    output: z.object({ patch: z.string() }),
  },
  commit_file: {
    input: z.object({ reviewId: z.string(), sha: z.string(), path: z.string() }),
    output: z.object({ content: z.string().nullable(), binary: z.boolean() }),
  },
});

export const REVIEW_CHANGED = "review-changed";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

// Keep historical statements in place: migrations are indexed and hash-checked.
// Retired AI tables and their existing contents remain untouched.
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS reviews (
     id TEXT PRIMARY KEY,
     owner TEXT NOT NULL,
     repo TEXT NOT NULL,
     number INTEGER NOT NULL,
     title TEXT NOT NULL,
     body TEXT NOT NULL DEFAULT '',
     state TEXT NOT NULL,
     is_draft INTEGER NOT NULL DEFAULT 0,
     url TEXT NOT NULL,
     author TEXT,
     base_ref TEXT NOT NULL,
     head_ref TEXT NOT NULL,
     head_sha TEXT NOT NULL,
     base_sha TEXT NOT NULL,
     additions INTEGER NOT NULL DEFAULT 0,
     deletions INTEGER NOT NULL DEFAULT 0,
     changed_files INTEGER NOT NULL DEFAULT 0,
     review_decision TEXT,
     mergeable TEXT,
     labels_json TEXT NOT NULL DEFAULT '[]',
     checks_json TEXT NOT NULL DEFAULT '[]',
     reviewers_json TEXT NOT NULL DEFAULT '[]',
     assignees_json TEXT NOT NULL DEFAULT '[]',
     commits_json TEXT NOT NULL DEFAULT '[]',
     gh_created_at TEXT NOT NULL DEFAULT '',
     worktree TEXT NOT NULL,
     environment_id TEXT,
     host_id TEXT NOT NULL,
     repo_path TEXT NOT NULL,
     project_id TEXT,
     gh_updated_at TEXT NOT NULL DEFAULT '',
     synced_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE(owner, repo, number)
   )`,
  `CREATE TABLE IF NOT EXISTS files_cache (review_id TEXT PRIMARY KEY, head_sha TEXT NOT NULL, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS viewed (review_id TEXT NOT NULL, path TEXT NOT NULL, viewed_at INTEGER NOT NULL, PRIMARY KEY (review_id, path))`,
  `CREATE TABLE IF NOT EXISTS threads_cache (review_id TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS conversation_cache (review_id TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pending (
     id TEXT PRIMARY KEY,
     review_id TEXT NOT NULL,
     path TEXT NOT NULL,
     line INTEGER NOT NULL,
     start_line INTEGER,
     side TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS seats (review_id TEXT NOT NULL, provider_id TEXT NOT NULL, thread_id TEXT NOT NULL, environment_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (review_id, provider_id))`,
  `CREATE TABLE IF NOT EXISTS codemaps (review_id TEXT PRIMARY KEY, head_sha TEXT NOT NULL, status TEXT NOT NULL, json TEXT, error TEXT, updated_at INTEGER NOT NULL)`,
  // Migrations are append-only and hash-checked; these two tables belonged to a
  // removed diagrams feature and stay declared so existing databases still match.
  `CREATE TABLE IF NOT EXISTS illustrators (review_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider_id TEXT NOT NULL, environment_id TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS diagrams (
     id TEXT PRIMARY KEY,
     review_id TEXT NOT NULL,
     head_sha TEXT NOT NULL,
     preset TEXT NOT NULL,
     target_json TEXT,
     prompt TEXT NOT NULL,
     title TEXT NOT NULL,
     status TEXT NOT NULL,
     spec_json TEXT,
     raw TEXT,
     error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  // One hidden helper thread per review runs one-shot jobs (the brief, later notes).
  `CREATE TABLE IF NOT EXISTS helpers (review_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider_id TEXT NOT NULL, environment_id TEXT, job TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS briefs (
     review_id TEXT PRIMARY KEY,
     head_sha TEXT NOT NULL,
     signals_status TEXT NOT NULL DEFAULT 'missing',
     signals_json TEXT,
     signals_error TEXT,
     brief_status TEXT NOT NULL DEFAULT 'missing',
     brief_head_sha TEXT,
     brief_json TEXT,
     brief_raw TEXT,
     brief_error TEXT,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS notes (
     id TEXT PRIMARY KEY,
     review_id TEXT NOT NULL,
     head_sha TEXT NOT NULL,
     path TEXT NOT NULL,
     line INTEGER NOT NULL,
     start_line INTEGER,
     side TEXT NOT NULL,
     kind TEXT NOT NULL,
     severity TEXT NOT NULL,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     suggestion TEXT,
     source TEXT NOT NULL,
     signal_id TEXT,
     state TEXT NOT NULL,
     anchor_hash TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS notes_review ON notes (review_id)`,
  `CREATE TABLE IF NOT EXISTS review_seen (review_id TEXT PRIMARY KEY, seen_head_sha TEXT NOT NULL, prev_head_sha TEXT, seen_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS stack_cache (
     owner TEXT NOT NULL,
     repo TEXT NOT NULL,
     number INTEGER NOT NULL,
     json TEXT NOT NULL,
     fetched_at INTEGER NOT NULL,
     PRIMARY KEY (owner, repo, number)
   )`,
    `CREATE TABLE IF NOT EXISTS dismissed (
     owner TEXT NOT NULL,
     repo TEXT NOT NULL,
     number INTEGER NOT NULL,
     PRIMARY KEY (owner, repo, number)
   )`,
  `ALTER TABLE helpers ADD COLUMN model TEXT NOT NULL DEFAULT ''`,
  `CREATE TABLE IF NOT EXISTS tracked_stacks (key TEXT PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL, host_id TEXT NOT NULL, json TEXT NOT NULL, fetched_at INTEGER NOT NULL, opened_at INTEGER NOT NULL)`,
];

interface ReviewRow {
  id: string; owner: string; repo: string; number: number; title: string; body: string; state: string; is_draft: number; url: string; author: string | null;
  base_ref: string; head_ref: string; head_sha: string; base_sha: string; additions: number; deletions: number; changed_files: number;
  review_decision: string | null; mergeable: string | null; labels_json: string; checks_json: string; reviewers_json: string; assignees_json: string; commits_json: string; gh_created_at: string;
  worktree: string; environment_id: string | null; host_id: string; repo_path: string; project_id: string | null; gh_updated_at: string; synced_at: number; created_at: number; updated_at: number;
}
interface PendingRow { id: string; review_id: string; path: string; line: number; start_line: number | null; side: string; body: string; created_at: number }
interface CacheRow { review_id: string; json: string; fetched_at: number }
interface NoteRow {
  id: string; review_id: string; head_sha: string; path: string; line: number; start_line: number | null; side: string; kind: string; severity: string; title: string; body: string;
  suggestion: string | null; source: string; signal_id: string | null; state: string; anchor_hash: string | null; created_at: number; updated_at: number;
}
function newId(): string {
  return randomBytes(6).toString("hex");
}

function createStore(db: Database.Database) {
  const q = {
    reviews: db.prepare<[], ReviewRow>(`SELECT * FROM reviews ORDER BY updated_at DESC`),
    review: db.prepare<[string], ReviewRow>(`SELECT * FROM reviews WHERE id = ?`),
    reviewByKey: db.prepare<[string, string, number], ReviewRow>(`SELECT * FROM reviews WHERE owner = ? AND repo = ? AND number = ?`),
    insertReview: db.prepare<[string, string, string, number, string, string, string, string, string, string | null, number, number, number]>(
      `INSERT INTO reviews (id, owner, repo, number, title, state, url, base_ref, head_ref, head_sha, base_sha, worktree, host_id, repo_path, project_id, synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'OPEN', ?, '', '', '', '', ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateReviewMeta: db.prepare<[string, string, string, number, string | null, string, string, string, string, number, number, number, string | null, string | null, string, string, string, string, string, string, string, string, number, number, string]>(
      `UPDATE reviews SET title = ?, body = ?, state = ?, is_draft = ?, author = ?, base_ref = ?, head_ref = ?, head_sha = ?, base_sha = ?, additions = ?, deletions = ?, changed_files = ?, review_decision = ?, mergeable = ?, labels_json = ?, checks_json = ?, reviewers_json = ?, assignees_json = ?, commits_json = ?, gh_created_at = ?, worktree = ?, gh_updated_at = ?, synced_at = ?, updated_at = ? WHERE id = ?`,
    ),
    setSyncedAt: db.prepare<[number, string]>(`UPDATE reviews SET synced_at = ? WHERE id = ?`),
    setDraft: db.prepare<[number, number, string]>(`UPDATE reviews SET is_draft = ?, updated_at = ? WHERE id = ?`),
    setBody: db.prepare<[string, number, string]>(`UPDATE reviews SET body = ?, updated_at = ? WHERE id = ?`),
    setClosed: db.prepare<[string, number, string, string | null, string, number, number, string]>(
      `UPDATE reviews SET state = ?, is_draft = ?, title = ?, review_decision = ?, gh_updated_at = ?, synced_at = ?, updated_at = ? WHERE id = ?`,
    ),
    deleteReview: db.prepare<[string]>(`DELETE FROM reviews WHERE id = ?`),
    filesCache: db.prepare<[string], { head_sha: string; json: string }>(`SELECT head_sha, json FROM files_cache WHERE review_id = ?`),
    setFilesCache: db.prepare<[string, string, string]>(`INSERT INTO files_cache (review_id, head_sha, json) VALUES (?, ?, ?) ON CONFLICT(review_id) DO UPDATE SET head_sha = excluded.head_sha, json = excluded.json`),
    viewed: db.prepare<[string], { path: string }>(`SELECT path FROM viewed WHERE review_id = ?`),
    setViewed: db.prepare<[string, string, number]>(`INSERT OR REPLACE INTO viewed (review_id, path, viewed_at) VALUES (?, ?, ?)`),
    unsetViewed: db.prepare<[string, string]>(`DELETE FROM viewed WHERE review_id = ? AND path = ?`),
    threadsCache: db.prepare<[string], CacheRow>(`SELECT * FROM threads_cache WHERE review_id = ?`),
    setThreadsCache: db.prepare<[string, string, number]>(`INSERT INTO threads_cache (review_id, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(review_id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`),
    conversationCache: db.prepare<[string], CacheRow>(`SELECT * FROM conversation_cache WHERE review_id = ?`),
    setConversationCache: db.prepare<[string, string, number]>(`INSERT INTO conversation_cache (review_id, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(review_id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`),
    pending: db.prepare<[string], PendingRow>(`SELECT * FROM pending WHERE review_id = ? ORDER BY created_at ASC`),
    pendingById: db.prepare<[string], PendingRow>(`SELECT * FROM pending WHERE id = ?`),
    insertPending: db.prepare<[string, string, string, number, number | null, string, string, number]>(
      `INSERT INTO pending (id, review_id, path, line, start_line, side, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updatePending: db.prepare<[string, string]>(`UPDATE pending SET body = ? WHERE id = ?`),
    deletePending: db.prepare<[string]>(`DELETE FROM pending WHERE id = ?`),
    clearPending: db.prepare<[string]>(`DELETE FROM pending WHERE review_id = ?`),
    notes: db.prepare<[string], NoteRow>(`SELECT * FROM notes WHERE review_id = ? AND source = 'me' ORDER BY path ASC, line ASC, created_at ASC`),
    noteById: db.prepare<[string], NoteRow>(`SELECT * FROM notes WHERE id = ?`),
    insertNote: db.prepare<[string, string, string, string, number, number | null, string, string, string, string, string, string | null, string, string | null, string | null, number, number]>(
      `INSERT INTO notes (id, review_id, head_sha, path, line, start_line, side, kind, severity, title, body, suggestion, source, signal_id, anchor_hash, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    ),
    setNoteState: db.prepare<[string, number, string]>(`UPDATE notes SET state = ?, updated_at = ? WHERE id = ?`),
    setNoteBody: db.prepare<[string, number, string]>(`UPDATE notes SET body = ?, updated_at = ? WHERE id = ?`),
    setNoteLine: db.prepare<[number, number | null, string, number, string]>(`UPDATE notes SET line = ?, start_line = ?, head_sha = ?, updated_at = ? WHERE id = ?`),
    deleteNote: db.prepare<[string]>(`DELETE FROM notes WHERE id = ?`),
    seen: db.prepare<[string], { review_id: string; seen_head_sha: string; prev_head_sha: string | null; seen_at: number }>(`SELECT * FROM review_seen WHERE review_id = ?`),
    upsertSeen: db.prepare<[string, string, string | null, number]>(
      `INSERT INTO review_seen (review_id, seen_head_sha, prev_head_sha, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(review_id) DO UPDATE SET seen_head_sha = excluded.seen_head_sha, prev_head_sha = excluded.prev_head_sha, seen_at = excluded.seen_at`,
    ),
    stackCache: db.prepare<[string, string, number], { json: string; fetched_at: number }>(`SELECT json, fetched_at FROM stack_cache WHERE owner = ? AND repo = ? AND number = ?`),
    upsertStackCache: db.prepare<[string, string, number, string, number]>(
      `INSERT INTO stack_cache (owner, repo, number, json, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner, repo, number) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`,
    ),
    deleteStackCache: db.prepare<[string, string, number]>(`DELETE FROM stack_cache WHERE owner = ? AND repo = ? AND number = ?`),
    dismissed: db.prepare<[string, string, number], { number: number }>(`SELECT number FROM dismissed WHERE owner = ? AND repo = ? AND number = ?`),
    dismiss: db.prepare<[string, string, number]>(`INSERT OR IGNORE INTO dismissed (owner, repo, number) VALUES (?, ?, ?)`),
    undismiss: db.prepare<[string, string, number]>(`DELETE FROM dismissed WHERE owner = ? AND repo = ? AND number = ?`),
    deleteViewedByReview: db.prepare<[string]>(`DELETE FROM viewed WHERE review_id = ?`),
    deleteFilesCache: db.prepare<[string]>(`DELETE FROM files_cache WHERE review_id = ?`),
    deleteThreadsCache: db.prepare<[string]>(`DELETE FROM threads_cache WHERE review_id = ?`),
    deleteConversationCache: db.prepare<[string]>(`DELETE FROM conversation_cache WHERE review_id = ?`),
    deleteNotesForReview: db.prepare<[string]>(`DELETE FROM notes WHERE review_id = ?`),
    deleteSeen: db.prepare<[string]>(`DELETE FROM review_seen WHERE review_id = ?`),
  };
  return { q };
}
type Store = ReturnType<typeof createStore>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function prIsOpen(state: string): boolean {
  return state.toUpperCase() === "OPEN";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function parseJson<T>(json: string | null, fallback: T): T {
  if (json === null) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state,
    isDraft: row.is_draft === 1,
    url: row.url,
    author: row.author,
    baseRefName: row.base_ref,
    headRefName: row.head_ref,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    additions: row.additions,
    deletions: row.deletions,
    changedFiles: row.changed_files,
    reviewDecision: row.review_decision,
    mergeable: row.mergeable,
    labels: parseJson<string[]>(row.labels_json, []),
    checks: parseJson<Review["checks"]>(row.checks_json, []),
    reviewers: parseJson<Review["reviewers"]>(row.reviewers_json, []),
    assignees: parseJson<string[]>(row.assignees_json, []),
    commits: parseJson<Review["commits"]>(row.commits_json, []),
    createdAt: row.gh_created_at,
    worktree: row.worktree,
    environmentId: row.environment_id,
    hostId: row.host_id,
    syncedAt: row.synced_at,
    ghUpdatedAt: row.gh_updated_at,
  };
}

function toPending(row: PendingRow, stale = false): PendingComment {
  return {
    id: row.id,
    reviewId: row.review_id,
    path: row.path,
    line: row.line,
    startLine: row.start_line,
    side: row.side === "LEFT" ? "LEFT" : "RIGHT",
    body: row.body,
    createdAt: row.created_at,
    stale,
  };
}

function fileForPath(files: ChangedFile[], path: string): ChangedFile | undefined {
  return files.find((file) => file.path === path) ?? files.find((file) => file.oldPath === path);
}

function pendingHitsDiff(hunks: { old: Set<number>; new: Set<number> }, side: string, line: number, startLine: number | null): boolean {
  const lines = side === "LEFT" ? hunks.old : hunks.new;
  if (!lines.has(line)) return false;
  if (startLine !== null && !lines.has(startLine)) return false;
  return true;
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    reviewId: row.review_id,
    path: row.path,
    line: row.line,
    startLine: row.start_line,
    side: row.side === "LEFT" ? "LEFT" : "RIGHT",
    body: row.body,
    state: row.state === "dismissed" || row.state === "promoted" || row.state === "stale" ? row.state : "open",
    createdAt: row.created_at,
  };
}

/** Content hash of a line, so notes can follow their line across pushes. */
function anchorHash(text: string): string {
  let h = 5381;
  const t = text.trim();
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** owner/repo#N, a GitHub PR URL, or owner/repo/stack/N (a gh stack number). */
function parseOpenRef(ref: string): { kind: "pr"; owner: string; repo: string; number: number } | { kind: "stack"; owner: string; repo: string; stackNumber: number } | null {
  const stackUrl = ref.match(/github\.com\/([^/\s]+)\/([^/\s#]+)\/stacks?\/(\d+)/i);
  if (stackUrl) return { kind: "stack", owner: stackUrl[1], repo: stackUrl[2].replace(/\.git$/, ""), stackNumber: Number(stackUrl[3]) };
  const stackShort = ref.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/stacks?\/(\d+)$/);
  if (stackShort) return { kind: "stack", owner: stackShort[1], repo: stackShort[2].replace(/\.git$/, ""), stackNumber: Number(stackShort[3]) };
  const pr = parsePrRef(ref);
  return pr === null ? null : { kind: "pr", ...pr };
}

/** owner/repo#N, owner/repo/pull/N, or a full GitHub URL. */
function parsePrRef(ref: string): { owner: string; repo: string; number: number } | null {
  const url = ref.match(/github\.com\/([^/\s]+)\/([^/\s#]+)\/pull\/(\d+)/i);
  if (url) return { owner: url[1], repo: url[2].replace(/\.git$/, ""), number: Number(url[3]) };
  const short = ref.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#|\/pull\/|\s+)(\d+)$/);
  if (short) return { owner: short[1], repo: short[2].replace(/\.git$/, ""), number: Number(short[3]) };
  return null;
}

function remoteMatches(remote: string | null, owner: string, repo: string): boolean {
  if (remote === null) return false;
  const normalized = remote.replace(/\.git$/, "").toLowerCase();
  return normalized.endsWith(`${owner}/${repo}`.toLowerCase());
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const { q }: Store = createStore(db);
  const stacks = createStackStore(db);
  // Import previously opened stacks once, without preparing any extra worktrees.
  for (const row of q.reviews.all()) {
    const cache = q.stackCache.get(row.owner, row.repo, row.number);
    const stack = prStackSchema.safeParse(parseJson(cache?.json ?? "null", null));
    if (stack.success && stacks.forPr(row.owner, row.repo, row.number) === undefined) {
      stacks.save(row.owner, row.repo, stack.data, row.host_id, undefined, cache!.fetched_at, row.updated_at);
    }
  }
  db.exec("UPDATE stack_cache SET json = 'null' WHERE json != 'null'");
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const syncErrors = new Map<string, string>();
  const detailsRefreshedAt = new Map<string, number>();

  const publish = (reviewId: string, what: string) => bb.realtime.publish(REVIEW_CHANGED, { reviewId, what });

  const reportSyncError = (reviewId: string, cause: unknown) => {
    const error = errorMessage(cause);
    if (syncErrors.get(reviewId) === error) return;
    syncErrors.set(reviewId, error);
    publish(reviewId, "sync-error");
  };

  function requireReview(reviewId: string): ReviewRow {
    const row = q.review.get(reviewId);
    if (row === undefined) throw new Error(`review ${reviewId} not found`);
    return row;
  }

  const hostOptions = (row: ReviewRow) => ({ hostId: row.host_id });

  /** Take a review out of Review Desk. Does not close the pull request on GitHub. */
  function forgetReview(row: ReviewRow, dismiss: boolean): void {
    q.clearPending.run(row.id);
    q.deleteViewedByReview.run(row.id);
    q.deleteFilesCache.run(row.id);
    q.deleteThreadsCache.run(row.id);
    q.deleteConversationCache.run(row.id);
    q.deleteNotesForReview.run(row.id);
    q.deleteSeen.run(row.id);
    if (dismiss) q.dismiss.run(row.owner, row.repo, row.number);
    q.deleteReview.run(row.id);
  }

  function releaseReview(row: ReviewRow, reason: string): void {
    publish(row.id, reason);
    void host.call("repo_release", { repoPath: row.repo_path, worktree: row.worktree }, hostOptions(row)).catch((cause: unknown) => {
      bb.log.warn(`release worktree for ${row.owner}/${row.repo}#${row.number}: ${errorMessage(cause)}`);
    });
  }

  function dropReview(row: ReviewRow, opts?: { dismiss?: boolean; reason?: string }): void {
    forgetReview(row, opts?.dismiss === true);
    releaseReview(row, opts?.reason ?? "removed");
  }

  function stackCacheRow(owner: string, repo: string, number: number): { json: string; fetched_at: number } | undefined {
    return q.stackCache.get(owner, repo, number);
  }

  function cachedPrStack(owner: string, repo: string, number: number): PrStack | null {
    return stacks.forPr(owner, repo, number)?.stack ?? null;
  }

  function storeStack(owner: string, repo: string, number: number, stack: PrStack | null, hostId: string, previousKey?: string): void {
    const previous = previousKey === undefined ? stacks.forPr(owner, repo, number) : stacks.get(previousKey);
    if (stack === null) {
      if (previous) stacks.remove(previous.key);
    } else {
      stacks.save(owner, repo, stack, hostId, previous?.key);
    }
    const changed = JSON.stringify(previous?.stack ?? null) !== JSON.stringify(stack);
    // The old cache now records discovery times only. Clear legacy snapshots too.
    for (const n of new Set([number, ...(previous?.stack.entries.map((entry) => entry.number) ?? []), ...(stack?.entries.map((entry) => entry.number) ?? [])])) {
      q.upsertStackCache.run(owner, repo, n, "null", Date.now());
      const local = q.reviewByKey.get(owner, repo, n);
      if (changed && local) publish(local.id, "stack");
    }
    if (changed) publish("", "stack");
  }

  function removeStack(key: string): void {
    const tracked = stacks.get(key);
    if (!tracked) throw new Error("stack not found");
    const removed: ReviewRow[] = [];
    db.transaction(() => {
      for (const entry of tracked.stack.entries) {
        const local = q.reviewByKey.get(tracked.owner, tracked.repo, entry.number);
        if (local) { forgetReview(local, true); removed.push(local); }
        q.deleteStackCache.run(tracked.owner, tracked.repo, entry.number);
      }
      stacks.remove(key);
    })();
    for (const row of removed) releaseReview(row, "removed");
    publish("", "stack");
  }

  function patchStackDraft(owner: string, repo: string, number: number, isDraft: boolean): void {
    const stack = cachedPrStack(owner, repo, number);
    if (stack === null) return;
    if (stack.entries.every((entry) => entry.number !== number || entry.isDraft === isDraft)) return;
    storeStack(owner, repo, number, {
      ...stack,
      entries: stack.entries.map((entry) => (entry.number === number ? { ...entry, isDraft } : entry)),
    }, q.reviewByKey.get(owner, repo, number)!.host_id);
  }

  const stackRefresh = new Map<string, Promise<void>>();
  const stackFailures = new Map<string, { at: number; error: unknown }>();
  const reviewSync = new Map<string, Promise<{ review: Review; headChanged: boolean }>>();
  const SYNC_EVERY_MS = 60_000;
  const STACK_FRESH_MS = 60_000;
  const DETAILS_EVERY_MS = 5 * 60_000;

  function stackFetchedAt(owner: string, repo: string, number: number): number | null {
    return stacks.forPr(owner, repo, number)?.fetchedAt ?? stackCacheRow(owner, repo, number)?.fetched_at ?? null;
  }

  function stackFresh(owner: string, repo: string, number: number): boolean {
    const at = stackFetchedAt(owner, repo, number);
    return at !== null && Date.now() - at < STACK_FRESH_MS;
  }

  async function refreshStack(row: ReviewRow, force = false): Promise<void> {
    const tracked = stacks.forPr(row.owner, row.repo, row.number);
    await refreshStackSnapshot(row.owner, row.repo, row.number, row.host_id, tracked, force);
  }

  async function refreshStackSnapshot(owner: string, repo: string, number: number, hostId: string, tracked: TrackedStack | undefined, force = false): Promise<void> {
    const key = tracked?.key ?? `${owner}/${repo}#${number}`;
    const failure = stackFailures.get(key);
    if (!force && failure && Date.now() - failure.at < SYNC_EVERY_MS) throw failure.error;
    if (!force && !failure && Date.now() - (tracked?.fetchedAt ?? stackFetchedAt(owner, repo, number) ?? 0) < STACK_FRESH_MS) return;
    const inflight = stackRefresh.get(key);
    if (inflight !== undefined) return inflight;
    const work = (async () => {
      try {
        const probe = tracked?.stack.entries.find((entry) => entry.state === "OPEN" && !entry.merged) ?? tracked?.stack.entries[0];
        // Use the bulk GraphQL query normally. Fall back to the stable stack number
        // if the probe PR left the stack, so membership changes do not lose tracking.
        let result = await host.call("gh_stack", { owner, repo, number: probe?.number ?? number, stackNumber: null }, { hostId });
        if (tracked?.stack.number != null && result.stack?.number !== tracked.stack.number) {
          result = await host.call("gh_stack", { owner, repo, number: null, stackNumber: tracked.stack.number }, { hostId });
        }
        // Removing a stack while a refresh runs must not bring it back.
        if (tracked ? stacks.get(tracked.key) !== undefined : q.reviewByKey.get(owner, repo, number) !== undefined) {
          storeStack(owner, repo, number, result.stack, hostId, tracked?.key);
        }
        stackFailures.delete(key);
      } catch (cause) {
        stackFailures.set(key, { at: Date.now(), error: cause });
        throw cause;
      } finally {
        stackRefresh.delete(key);
      }
    })();
    stackRefresh.set(key, work);
    return work;
  }

  async function ensureStack(row: ReviewRow): Promise<void> {
    if (stackCacheRow(row.owner, row.repo, row.number) === undefined) {
      await refreshStack(row);
      return;
    }
    void refreshStack(row).catch((cause: unknown) => reportSyncError(row.id, cause));
  }

  function discoverStacks(rows: ReviewRow[]): void {
    for (const row of rows) {
      void refreshStack(row).catch((cause: unknown) => reportSyncError(row.id, cause));
    }
  }

  function stackViewFor(row: ReviewRow): StackView | null {
    const stack = cachedPrStack(row.owner, row.repo, row.number);
    if (stack === null) return null;
    const current = stack.entries.find((e) => e.number === row.number);
    return {
      ...stack,
      currentPosition: current?.position ?? 1,
      entries: stack.entries.map((entry) => {
        const local = q.reviewByKey.get(row.owner, row.repo, entry.number);
        return {
          ...entry,
          ...(local?.head_sha === entry.headSha ? reviewStats(local) : {}),
          reviewId: local?.id ?? null,
          pendingCount: local === undefined ? 0 : q.pending.all(local.id).length,
          viewedCount: local === undefined ? 0 : q.viewed.all(local.id).length,
        };
      }),
    };
  }

  async function primaryHostId(): Promise<string> {
    const hosts = await bb.sdk.hosts.list();
    const connected = hosts.find((h) => h.status === "connected") ?? hosts[0];
    if (connected === undefined) throw new Error("no bb machine is connected");
    return connected.id;
  }

  // -- repository resolution -------------------------------------------------

  async function locateRepo(owner: string, repo: string): Promise<{ repoPath: string; hostId: string; projectId: string | null }> {
    const projects = await bb.sdk.projects.list();
    for (const project of projects) {
      if (!remoteMatches(project.gitRemoteUrl, owner, repo)) continue;
      const detail = await bb.sdk.projects.get({ projectId: project.id });
      const sources = (detail as { sources?: { type: string; path: string; hostId: string; isDefault: boolean }[] }).sources ?? [];
      const source = sources.find((s) => s.type === "local_path" && s.isDefault) ?? sources.find((s) => s.type === "local_path");
      if (source) return { repoPath: source.path, hostId: source.hostId, projectId: project.id };
    }
    const hostId = await primaryHostId();
    const cloned = await host.call("repo_clone", { owner, repo, dest: "" }, { hostId });
    return { repoPath: cloned.repoPath, hostId, projectId: null };
  }

  // -- open and sync ---------------------------------------------------------

  async function refreshFiles(row: ReviewRow): Promise<ChangedFile[]> {
    const result = await host.call("git_files", { worktree: row.worktree, baseSha: row.base_sha, headSha: row.head_sha }, hostOptions(row));
    q.setFilesCache.run(row.id, row.head_sha, JSON.stringify(result.files));
    return result.files;
  }

  function cachedFiles(row: ReviewRow): ChangedFile[] | null {
    const cache = q.filesCache.get(row.id);
    if (cache === undefined || cache.head_sha !== row.head_sha) return null;
    return parseJson<ChangedFile[]>(cache.json, []);
  }

  async function filesFor(row: ReviewRow): Promise<ChangedFile[]> {
    return cachedFiles(row) ?? refreshFiles(row);
  }

  function reviewStats(row: ReviewRow) {
    const files = cachedFiles(row);
    return files === null ? { additions: row.additions, deletions: row.deletions } : diffStats(files);
  }

  function applyPr(row: ReviewRow, pr: GhPr, prepared: { worktree: string; headSha: string; baseSha: string }): void {
    const now = Date.now();
    detailsRefreshedAt.set(row.id, now);
    q.updateReviewMeta.run(
      pr.title, pr.body, pr.state, pr.isDraft ? 1 : 0, pr.author?.login ?? null, pr.baseRefName, pr.headRefName, prepared.headSha, prepared.baseSha,
      pr.additions, pr.deletions, pr.changedFiles, pr.reviewDecision, pr.mergeable, JSON.stringify(pr.labels), JSON.stringify(pr.checks),
      JSON.stringify(pr.reviewers), JSON.stringify(pr.assignees), JSON.stringify(pr.commits), pr.createdAt,
      prepared.worktree, pr.updatedAt, now, now, row.id,
    );
  }

  async function openPr(owner: string, repo: string, number: number): Promise<Review> {
    q.undismiss.run(owner, repo, number);
    const existing = q.reviewByKey.get(owner, repo, number);
    if (existing !== undefined) {
      await syncReview(existing.id);
      return toReview(requireReview(existing.id));
    }
    const located = await locateRepo(owner, repo);
    const pr = await host.call("gh_pr", { owner, repo, number }, { hostId: located.hostId });
    const key = `${owner}__${repo}__${number}`;
    const prepared = await host.call(
      "repo_prepare",
      { repoPath: located.repoPath, number, headSha: pr.headRefOid, baseRefName: pr.baseRefName, worktreesDir: "", key },
      { hostId: located.hostId },
    );
    const id = newId();
    const now = Date.now();
    q.insertReview.run(id, owner, repo, number, pr.title, pr.url, prepared.worktree, located.hostId, located.repoPath, located.projectId, now, now, now);
    applyPr(requireReview(id), pr, prepared);
    const row = requireReview(id);
    await refreshFiles(row);
    await refreshStack(row);
    publish(id, "opened");
    return toReview(row);
  }

  async function openReview(ref: string): Promise<Review> {
    const parsed = parseOpenRef(ref);
    if (parsed === null) throw new Error("Give a PR URL, owner/repo#123, owner/repo/pull/123, or owner/repo/stack/N");
    if (parsed.kind === "stack") {
      const located = await locateRepo(parsed.owner, parsed.repo);
      const result = await host.call(
        "gh_stack",
        { owner: parsed.owner, repo: parsed.repo, number: null, stackNumber: parsed.stackNumber },
        { hostId: located.hostId },
      );
      if (result.stack === null || result.stack.entries.length === 0) {
        throw new Error(`no GitHub stack #${parsed.stackNumber} in ${parsed.owner}/${parsed.repo}`);
      }
      storeStack(parsed.owner, parsed.repo, result.stack.entries[0].number, result.stack, located.hostId);
      const pick = result.stack.entries.find((e) => e.state === "OPEN" && !e.merged) ?? result.stack.entries[0];
      return openPr(parsed.owner, parsed.repo, pick.number);
    }
    return openPr(parsed.owner, parsed.repo, parsed.number);
  }

  async function syncReview(reviewId: string, force = false): Promise<{ review: Review; headChanged: boolean }> {
    const inflight = reviewSync.get(reviewId);
    if (inflight !== undefined) return inflight;
    const work = (async () => {
      try {
        const result = await syncReviewOnce(reviewId, force);
        if (syncErrors.delete(reviewId)) publish(reviewId, "sync-error");
        return result;
      } catch (cause) {
        reportSyncError(reviewId, cause);
        throw cause;
      } finally {
        reviewSync.delete(reviewId);
      }
    })();
    reviewSync.set(reviewId, work);
    return work;
  }

  async function syncReviewOnce(reviewId: string, force: boolean): Promise<{ review: Review; headChanged: boolean }> {
    const row = requireReview(reviewId);
    if (!force && !syncErrors.has(reviewId) && detailsRefreshedAt.has(reviewId) && Date.now() - row.synced_at < SYNC_EVERY_MS && stackFresh(row.owner, row.repo, row.number)) {
      return { review: toReview(row), headChanged: false };
    }
    const pr = await host.call("gh_pr_status", { owner: row.owner, repo: row.repo, number: row.number }, hostOptions(row));
    const wasOpen = prIsOpen(row.state);
    if (!prIsOpen(pr.state)) {
      const now = Date.now();
      if (pr.state !== row.state || pr.isDraft !== (row.is_draft === 1) || pr.title !== row.title || pr.reviewDecision !== row.review_decision || pr.updatedAt !== row.gh_updated_at) {
        q.setClosed.run(pr.state, pr.isDraft ? 1 : 0, pr.title, pr.reviewDecision, pr.updatedAt, now, now, row.id);
        publish(row.id, "synced");
      } else {
        q.setSyncedAt.run(now, row.id);
      }
      if (wasOpen) publish(row.id, "closed");
      await refreshStack(row, force);
      return { review: toReview(requireReview(reviewId)), headChanged: false };
    }
    const headChanged = pr.headRefOid !== row.head_sha;
    const baseMoved = pr.baseRefName !== row.base_ref;
    const touched = force || syncErrors.has(reviewId) || headChanged || baseMoved || pr.updatedAt !== row.gh_updated_at || pr.title !== row.title || pr.body !== row.body || pr.state !== row.state || pr.isDraft !== (row.is_draft === 1) || (pr.reviewDecision ?? null) !== row.review_decision || q.threadsCache.get(row.id) === undefined;
    const detailsDue = Date.now() - (detailsRefreshedAt.get(reviewId) ?? 0) >= DETAILS_EVERY_MS;
    if (!touched && !detailsDue) {
      q.setSyncedAt.run(Date.now(), row.id);
      await refreshStack(row);
      return { review: toReview(requireReview(reviewId)), headChanged: false };
    }
    const details = await host.call("gh_pr_details", {
      owner: row.owner, repo: row.repo, number: row.number,
      includeCommits: force || headChanged || !detailsRefreshedAt.has(reviewId),
    }, hostOptions(row));
    const key = `${row.owner}__${row.repo}__${row.number}`;
    const prepared = headChanged || baseMoved || row.worktree === ""
      ? await host.call(
          "repo_prepare",
          { repoPath: row.repo_path, number: row.number, headSha: pr.headRefOid, baseRefName: pr.baseRefName, worktreesDir: "", key },
          hostOptions(row),
        )
      : { worktree: row.worktree, headSha: pr.headRefOid, baseSha: row.base_sha };
    applyPr(row, { ...pr, ...details, commits: details.commits ?? parseJson<Review["commits"]>(row.commits_json, []) }, prepared);
    const fresh = requireReview(reviewId);
    if (headChanged || baseMoved || cachedFiles(fresh) === null) await refreshFiles(fresh);
    await refreshThreads(fresh);
    await reanchorNotes(fresh);
    await refreshConversation(fresh);
    await refreshStack(fresh, force);
    publish(reviewId, wasOpen ? "synced" : "reopened");
    return { review: toReview(fresh), headChanged };
  }

  /** After a push, move open notes to the line whose content they were written against, or mark them stale. */
  async function reanchorNotes(row: ReviewRow): Promise<void> {
    const notes = q.notes.all(row.id).filter((n) => (n.state === "open" || n.state === "stale") && n.head_sha !== row.head_sha);
    if (notes.length === 0) return;
    const contents = new Map<string, string[] | null>();
    const now = Date.now();
    for (const note of notes) {
      const lines = await fileLines(row, note.path, note.side === "LEFT" ? "LEFT" : "RIGHT", contents);
      let found: number | null = null;
      if (lines !== null && note.anchor_hash !== null) {
        const window = 300;
        let best = Number.POSITIVE_INFINITY;
        for (let i = Math.max(0, note.line - 1 - window); i < Math.min(lines.length, note.line - 1 + window); i++) {
          if (anchorHash(lines[i]) === note.anchor_hash && Math.abs(i + 1 - note.line) < best) {
            best = Math.abs(i + 1 - note.line);
            found = i + 1;
          }
        }
      }
      if (found === null) {
        q.setNoteState.run("stale", now, note.id);
      } else {
        const span = note.start_line === null ? null : note.line - note.start_line;
        q.setNoteLine.run(found, span === null ? null : Math.max(1, found - span), row.head_sha, now, note.id);
        if (note.state === "stale") q.setNoteState.run("open", now, note.id);
      }
    }
    publish(row.id, "notes");
  }

  async function refreshThreads(row: ReviewRow): Promise<GhThread[]> {
    const result = await host.call("gh_threads", { owner: row.owner, repo: row.repo, number: row.number }, hostOptions(row));
    q.setThreadsCache.run(row.id, JSON.stringify({ version: 2, threads: result.threads }), Date.now());
    publish(row.id, "threads");
    return result.threads;
  }

  async function refreshConversation(row: ReviewRow): Promise<void> {
    const result = await host.call("gh_conversation", { owner: row.owner, repo: row.repo, number: row.number }, hostOptions(row));
    q.setConversationCache.run(row.id, JSON.stringify({ ...result, version: 2 }), Date.now());
    publish(row.id, "conversation");
  }

  function cachedThreads(row: ReviewRow): GhThread[] | null {
    const cache = q.threadsCache.get(row.id);
    if (cache === undefined) return null;
    const stored = parseJson<{ version?: number; threads?: GhThread[] } | null>(cache.json, null);
    return stored?.version === 2 && Array.isArray(stored.threads) ? stored.threads : null;
  }

  // -- read model ------------------------------------------------------------

  /** Mark pending comments whose path or line is gone from the current diff. */
  async function pendingFor(row: ReviewRow, files: ChangedFile[]): Promise<PendingComment[]> {
    const rows = q.pending.all(row.id);
    if (rows.length === 0) return [];
    const hunksByPath = new Map<string, { old: Set<number>; new: Set<number> } | null>();
    const out: PendingComment[] = [];
    for (const pending of rows) {
      const file = fileForPath(files, pending.path);
      let stale = file === undefined || file.binary;
      if (!stale && file !== undefined) {
        let hunks = hunksByPath.get(file.path);
        if (hunks === undefined) {
          const result = await host.call(
            "git_patch",
            { worktree: row.worktree, baseSha: row.base_sha, headSha: row.head_sha, path: file.path, oldPath: file.oldPath },
            hostOptions(row),
          );
          hunks = result.patch.trim() === "" ? null : hunkLineNumbers(result.patch);
          hunksByPath.set(file.path, hunks);
        }
        stale = hunks === null || !pendingHitsDiff(hunks, pending.side, pending.line, pending.start_line);
      }
      out.push({ ...toPending(pending, stale), path: file?.path ?? pending.path });
    }
    return out;
  }

  async function reviewDetail(reviewId: string) {
    const row = requireReview(reviewId);
    void syncReview(reviewId).catch(() => undefined);
    await ensureStack(row);
    const files = await filesFor(row);
    const viewed = new Set(q.viewed.all(row.id).map((v) => v.path));
    const storedThreads = cachedThreads(row);
    const threads = storedThreads === null || storedThreads.some((thread) => thread.comments.some((comment) => typeof comment.canEdit !== "boolean"))
      ? await refreshThreads(row) : storedThreads;
    const pending = await pendingFor(row, files);
    const perPath = new Map<string, { threads: number; unresolved: number; pending: number }>();
    const bump = (p: string, field: "threads" | "unresolved" | "pending") => {
      const entry = perPath.get(p) ?? { threads: 0, unresolved: 0, pending: 0 };
      entry[field]++;
      perPath.set(p, entry);
    };
    for (const t of threads) {
      const path = fileForPath(files, t.path)?.path ?? t.path;
      bump(path, "threads");
      if (!t.isResolved) bump(path, "unresolved");
    }
    for (const p of pending) bump(fileForPath(files, p.path)?.path ?? p.path, "pending");
    return {
      review: { ...toReview(row), ...diffStats(files) },
      files: files.map((f) => {
        const counts = perPath.get(f.path) ?? { threads: 0, unresolved: 0, pending: 0 };
        return { ...f, viewed: viewed.has(f.path), threadCount: counts.threads, unresolvedCount: counts.unresolved, pendingCount: counts.pending };
      }),
      pending,
      threads,
      notes: q.notes.all(row.id).map(toNote),
      syncError: syncErrors.get(reviewId) ?? null,
      seen: seenState(row),
      stack: stackViewFor(row),
    };
  }

  function seenState(row: ReviewRow): { prevHead: string | null; seenHead: string | null } {
    const s = q.seen.get(row.id);
    return { prevHead: s?.prev_head_sha ?? null, seenHead: s?.seen_head_sha ?? null };
  }

  /** Called when the review page opens. A new head moves the old one into prevHead, which marks "new since you last looked". */
  function markSeen(row: ReviewRow): { prevHead: string | null; seenHead: string | null } {
    const s = q.seen.get(row.id);
    if (s === undefined) q.upsertSeen.run(row.id, row.head_sha, null, Date.now());
    else if (s.seen_head_sha !== row.head_sha) q.upsertSeen.run(row.id, row.head_sha, s.seen_head_sha, Date.now());
    return seenState(row);
  }

  // -- commits -----------------------------------------------------------------

  const commitCache = new Map<string, CommitInfo>();

  async function commitInfo(row: ReviewRow, sha: string): Promise<CommitInfo> {
    const key = `${row.id}:${sha}`;
    const cached = commitCache.get(key);
    if (cached !== undefined) return cached;
    const info = await host.call("git_commit", { worktree: row.worktree, sha }, hostOptions(row));
    commitCache.set(key, info);
    return info;
  }

  async function commitRange(row: ReviewRow, to: string, from: string | undefined, inclusive: boolean) {
    const info = await commitInfo(row, to);
    let base: string;
    if (from === undefined) base = info.parents[0] ?? row.base_sha;
    else if (inclusive) base = (await commitInfo(row, from)).parents[0] ?? row.base_sha;
    else base = from;
    const files = await host.call("git_files", { worktree: row.worktree, baseSha: base, headSha: info.sha }, hostOptions(row));
    // The PR's commit list, oldest first, tells which commits the range covers.
    const list = parseJson<Review["commits"]>(row.commits_json, []);
    const toIndex = list.findIndex((c) => c.sha === info.sha || c.sha.startsWith(to) || info.sha.startsWith(c.sha));
    let commits: CommitInfo[] = [info];
    if (from !== undefined && toIndex !== -1) {
      const fromIndex = list.findIndex((c) => c.sha === from || c.sha.startsWith(from) || from.startsWith(c.sha));
      const start = fromIndex === -1 ? 0 : inclusive ? fromIndex : fromIndex + 1;
      const slice = list.slice(Math.min(start, toIndex), toIndex + 1);
      commits = await Promise.all(slice.map((c) => commitInfo(row, c.sha)));
    }
    return { base, head: info.sha, info, commits, files: files.files };
  }

  // -- private notes ----------------------------------------------------------

  async function fileLines(row: ReviewRow, path: string, side: "LEFT" | "RIGHT", cache: Map<string, string[] | null>): Promise<string[] | null> {
    const key = `${side}:${path}`;
    if (!cache.has(key)) {
      const file = fileForPath(await filesFor(row), path);
      const targetPath = side === "LEFT" ? file?.oldPath ?? path : file?.path ?? path;
      const shown = await host.call("git_show", { worktree: row.worktree, sha: side === "LEFT" ? row.base_sha : row.head_sha, path: targetPath }, hostOptions(row));
      cache.set(key, shown.content === null ? null : shown.content.split("\n"));
    }
    return cache.get(key) ?? null;
  }

  interface NoteInput { path: string; line: number; startLine: number | null; side: "LEFT" | "RIGHT"; body: string }

  async function insertNotes(row: ReviewRow, inputs: NoteInput[]): Promise<Note[]> {
    const cache = new Map<string, string[] | null>();
    const existing = q.notes.all(row.id);
    const out: Note[] = [];
    const now = Date.now();
    for (const n of inputs) {
      // Do not add the same note twice to the same side and line.
      if (existing.some((e) => e.path === n.path && e.line === n.line && e.side === n.side && e.body === n.body && e.state !== "dismissed")) continue;
      const lines = await fileLines(row, n.path, n.side, cache);
      if (lines !== null && n.line > lines.length) continue;
      const anchor = lines === null ? null : anchorHash(lines[n.line - 1] ?? "");
      const id = newId();
      q.insertNote.run(id, row.id, row.head_sha, n.path, n.line, n.startLine, n.side, "question", "low", "", n.body, null, "me", null, anchor, now, now);
      const inserted = q.noteById.get(id);
      if (inserted !== undefined) out.push(toNote(inserted));
    }
    return out;
  }

  // -- GitHub write paths ----------------------------------------------------

  async function submitReview(reviewId: string, event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string): Promise<{ url: string | null; posted: number; dropped: number }> {
    const row = requireReview(reviewId);
    const pending = await pendingFor(row, await filesFor(row));
    const live = pending.filter((p) => !p.stale);
    if (event === "REQUEST_CHANGES" && body.trim() === "") throw new Error("Add a review summary when requesting changes");
    if (event === "COMMENT" && live.length === 0 && body.trim() === "") {
      throw new Error(pending.length > 0
        ? "pending comments no longer sit on the current diff. Remove them, or add a review body."
        : "nothing to submit: add comments or a review body");
    }
    const result = await host.call(
      "gh_submit_review",
      {
        owner: row.owner,
        repo: row.repo,
        number: row.number,
        commitId: row.head_sha,
        event,
        body,
        comments: live.map((p) => ({ path: p.path, line: p.line, side: p.side, startLine: p.startLine, body: p.body })),
      },
      hostOptions(row),
    );
    // Preserve stale drafts, new drafts, and edits made while the request was in flight.
    for (const sent of live) {
      const current = q.pendingById.get(sent.id);
      if (current?.body === sent.body) q.deletePending.run(sent.id);
    }
    await refreshThreads(row).catch((cause: unknown) => reportSyncError(row.id, cause));
    publish(row.id, "pending");
    return { url: result.url, posted: live.length, dropped: pending.length - live.length };
  }

  // -- RPC -------------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    reviews_list: () => {
      const rows = q.reviews.all();
      discoverStacks(rows);
      return {
        reviews: [
          ...stacks.list().flatMap((tracked): ReviewSummary[] => tracked.stack.entries.map((entry) => {
            const local = q.reviewByKey.get(tracked.owner, tracked.repo, entry.number);
            return {
              id: local?.id ?? null, owner: tracked.owner, repo: tracked.repo,
              number: entry.number, title: entry.title, state: entry.merged ? "MERGED" : entry.state,
              isDraft: entry.isDraft, reviewDecision: entry.reviewDecision, headSha: entry.headSha,
              ...(local?.head_sha === entry.headSha ? reviewStats(local) : { additions: entry.additions, deletions: entry.deletions }),
              pendingCount: local ? q.pending.all(local.id).length : 0,
              updatedAt: local?.updated_at ?? tracked.openedAt,
              stack: { number: tracked.stack.number, position: entry.position, size: tracked.stack.entries.length, key: tracked.key },
            };
          })),
          ...rows.filter((row) => cachedPrStack(row.owner, row.repo, row.number) === null).map((row) => ({
            id: row.id,
            owner: row.owner,
            repo: row.repo,
            number: row.number,
            title: row.title,
            state: row.state,
            isDraft: row.is_draft === 1,
            reviewDecision: row.review_decision,
            headSha: row.head_sha,
            ...reviewStats(row),
            pendingCount: q.pending.all(row.id).length,
            updatedAt: row.updated_at,
            stack: null,
          })),
        ].sort((a, b) => b.updatedAt - a.updatedAt),
      };
    },
    reviews_open: async ({ ref }) => ({ review: await openReview(ref) }),
    reviews_get: ({ reviewId }) => reviewDetail(reviewId),
    reviews_sync: ({ reviewId }) => syncReview(reviewId, true),
    reviews_remove: async ({ reviewId }) => {
      const row = requireReview(reviewId);
      const tracked = stacks.forPr(row.owner, row.repo, row.number);
      if (tracked) removeStack(tracked.key);
      else dropReview(row, { dismiss: true, reason: "removed" });
      return { ok: true as const };
    },
    stacks_remove: ({ key }) => { removeStack(key); return { ok: true as const }; },
    review_patch: async ({ reviewId, path }) => {
      const row = requireReview(reviewId);
      const files = await filesFor(row);
      const file = files.find((f) => f.path === path) ?? null;
      const result = await host.call("git_patch", { worktree: row.worktree, baseSha: row.base_sha, headSha: row.head_sha, path, oldPath: file?.oldPath ?? null }, hostOptions(row));
      return { patch: result.patch, file };
    },
    review_file: async ({ reviewId, path, side }) => {
      const row = requireReview(reviewId);
      const files = await filesFor(row);
      const file = files.find((f) => f.path === path);
      const targetPath = side === "old" ? file?.oldPath ?? path : path;
      return host.call("git_show", { worktree: row.worktree, sha: side === "old" ? row.base_sha : row.head_sha, path: targetPath }, hostOptions(row));
    },
    review_conversation: async ({ reviewId, refresh }) => {
      const row = requireReview(reviewId);
      const cache = q.conversationCache.get(row.id);
      if (cache !== undefined && !refresh) {
        const stored = parseJson<{ comments: z.infer<typeof ghIssueCommentSchema>[]; reviews: z.infer<typeof ghReviewSchema>[]; events?: z.infer<typeof ghEventSchema>[]; version?: number } | null>(cache.json, null);
        if (stored?.version === 2 && stored.events !== undefined && [...stored.comments, ...stored.reviews].every((comment) => typeof comment.canEdit === "boolean" && typeof comment.nodeId === "string")) {
          return { ...stored, events: stored.events, fetchedAt: cache.fetched_at };
        }
      }
      const result = await host.call("gh_conversation", { owner: row.owner, repo: row.repo, number: row.number }, hostOptions(row));
      q.setConversationCache.run(row.id, JSON.stringify({ ...result, version: 2 }), Date.now());
      return { ...result, fetchedAt: Date.now() };
    },
    review_threads_refresh: async ({ reviewId }) => ({ threads: await refreshThreads(requireReview(reviewId)) }),
    review_description: ({ reviewId }) => {
      const row = requireReview(reviewId);
      return host.call("gh_description", { owner: row.owner, repo: row.repo, number: row.number }, hostOptions(row));
    },
    review_edit_body: async ({ reviewId, ...input }) => {
      const row = requireReview(reviewId);
      const result = await host.call("gh_edit_body", { owner: row.owner, repo: row.repo, number: row.number, ...input }, hostOptions(row));
      // Update the local read model after GitHub accepts the edit. A later
      // refresh failure must not turn a successful save into a failed save.
      if (input.target.kind === "description") {
        q.setBody.run(result.body, Date.now(), row.id);
        publish(row.id, "description");
      } else if (input.target.kind === "inline") {
        const id = input.target.id;
        const threads = (cachedThreads(row) ?? []).map((thread) => ({ ...thread, comments: thread.comments.map((comment) => comment.id === id ? { ...comment, body: result.body } : comment) }));
        q.setThreadsCache.run(row.id, JSON.stringify({ version: 2, threads }), Date.now());
        publish(row.id, "threads");
      } else {
        const cached = q.conversationCache.get(row.id);
        const conversation = z.object({ comments: z.array(ghIssueCommentSchema), reviews: z.array(ghReviewSchema), events: z.array(ghEventSchema).default([]) }).parse(parseJson(cached?.json ?? null, { comments: [], reviews: [] }));
        const id = input.target.id;
        conversation.comments = conversation.comments.map((comment) => comment.nodeId === id ? { ...comment, body: result.body } : comment);
        conversation.reviews = conversation.reviews.map((review) => review.nodeId === id ? { ...review, body: result.body } : review);
        q.setConversationCache.run(row.id, JSON.stringify({ ...conversation, version: 2 }), Date.now());
        publish(row.id, "conversation");
      }
      return result;
    },
    viewed_set: ({ reviewId, path, viewed }) => {
      if (viewed) q.setViewed.run(reviewId, path, Date.now());
      else q.unsetViewed.run(reviewId, path);
      publish(reviewId, "viewed");
      return { ok: true as const };
    },
    pending_add: ({ reviewId, path, line, startLine, side, body }) => {
      requireReview(reviewId);
      const id = newId();
      q.insertPending.run(id, reviewId, path, line, startLine ?? null, side, body, Date.now());
      publish(reviewId, "pending");
      const row = q.pendingById.get(id);
      if (row === undefined) throw new Error("pending vanished");
      return { pending: toPending(row) };
    },
    pending_update: ({ id, body }) => {
      q.updatePending.run(body, id);
      const row = q.pendingById.get(id);
      if (row === undefined) throw new Error("pending comment not found");
      publish(row.review_id, "pending");
      return { pending: toPending(row) };
    },
    pending_delete: ({ id }) => {
      const row = q.pendingById.get(id);
      q.deletePending.run(id);
      if (row !== undefined) publish(row.review_id, "pending");
      return { ok: true as const };
    },
    pending_clear: async ({ reviewId }) => {
      const row = requireReview(reviewId);
      const stale = (await pendingFor(row, await filesFor(row))).filter((p) => p.stale);
      for (const pending of stale) q.deletePending.run(pending.id);
      if (stale.length > 0) publish(row.id, "pending");
      return { removed: stale.length };
    },
    review_submit: ({ reviewId, event, body }) => submitReview(reviewId, event, body),
    review_set_draft: async ({ reviewId, draft }) => {
      const row = requireReview(reviewId);
      if (row.state !== "OPEN") throw new Error("only an open pull request can be marked ready or converted to draft");
      const result = await host.call("gh_set_draft", { owner: row.owner, repo: row.repo, number: row.number, draft }, hostOptions(row));
      q.setDraft.run(result.isDraft ? 1 : 0, Date.now(), row.id);
      patchStackDraft(row.owner, row.repo, row.number, result.isDraft);
      publish(row.id, "draft");
      return { review: toReview(requireReview(row.id)) };
    },
    thread_reply: async ({ reviewId, commentId, body }) => {
      const row = requireReview(reviewId);
      await host.call("gh_reply", { owner: row.owner, repo: row.repo, number: row.number, commentId, body }, hostOptions(row));
      await refreshThreads(row);
      return { ok: true as const };
    },
    thread_resolve: async ({ reviewId, threadId, resolve }) => {
      const row = requireReview(reviewId);
      await host.call("gh_resolve", { threadId, resolve }, hostOptions(row));
      await refreshThreads(row);
      return { ok: true as const };
    },
    note_add: async ({ reviewId, path, line, startLine, side, body }) => {
      const row = requireReview(reviewId);
      const [note] = await insertNotes(row, [{ path, line, startLine: startLine ?? null, side, body }]);
      if (note === undefined) throw new Error("a note with the same text already sits on that line");
      publish(row.id, "notes");
      return { note };
    },
    note_update: ({ id, state, body }) => {
      const existing = q.noteById.get(id);
      if (existing === undefined) throw new Error("note not found");
      const now = Date.now();
      if (state !== undefined) q.setNoteState.run(state, now, id);
      if (body !== undefined) q.setNoteBody.run(body, now, id);
      publish(existing.review_id, "notes");
      const fresh = q.noteById.get(id);
      if (fresh === undefined) throw new Error("note vanished");
      return { note: toNote(fresh) };
    },
    note_delete: ({ id }) => {
      const existing = q.noteById.get(id);
      q.deleteNote.run(id);
      if (existing !== undefined) publish(existing.review_id, "notes");
      return { ok: true as const };
    },
    note_promote: ({ id }) => {
      const note = q.noteById.get(id);
      if (note === undefined) throw new Error("note not found");
      const pendingId = newId();
      q.insertPending.run(pendingId, note.review_id, note.path, note.line, note.start_line, note.side === "LEFT" ? "LEFT" : "RIGHT", note.body, Date.now());
      q.setNoteState.run("promoted", Date.now(), id);
      publish(note.review_id, "pending");
      publish(note.review_id, "notes");
      const pending = q.pendingById.get(pendingId);
      if (pending === undefined) throw new Error("pending vanished");
      return { pending: toPending(pending) };
    },
    review_seen: ({ reviewId }) => markSeen(requireReview(reviewId)),
    commit_get: ({ reviewId, to, from, inclusive }) => commitRange(requireReview(reviewId), to, from, inclusive === true),
    commit_patch: async ({ reviewId, base, head, path, oldPath }) => {
      const row = requireReview(reviewId);
      return host.call("git_patch", { worktree: row.worktree, baseSha: base, headSha: head, path, oldPath }, hostOptions(row));
    },
    commit_file: ({ reviewId, sha, path }) => {
      const row = requireReview(reviewId);
      return host.call("git_show", { worktree: row.worktree, sha, path }, hostOptions(row));
    },
  });

  // -- CLI -------------------------------------------------------------------

  bb.cli.register({
    name: "review-desk",
    summary: "Open and review GitHub pull requests",
    commands: [
      { name: "open", summary: "Open or refresh a PR review", usage: "bb review-desk open <url | owner/repo#N | owner/repo/stack/N>" },
      { name: "list", summary: "List reviews", usage: "bb review-desk list [--json]" },
      { name: "stack", summary: "Print the GitHub stack for a review", usage: "bb review-desk stack <reviewId> [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((a) => a !== "--json");
      const positional = args.filter((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
      const [command, ...rest] = positional;
      const ok = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
      try {
        switch (command) {
          case "open": {
            const review = await openReview(rest.join(" "));
            return ok(review, `Opened ${review.owner}/${review.repo}#${review.number} "${review.title}" as ${review.id} (${review.changedFiles} files, worktree ${review.worktree})`);
          }
          case "list": {
            const rows = q.reviews.all().filter((r) => prIsOpen(r.state));
            return ok(rows.map(toReview), rows.length === 0 ? "No reviews." : rows.map((r) => `${r.id}  ${r.owner}/${r.repo}#${r.number}  ${r.title}  [${r.state}]`).join("\n"));
          }
          case "stack": {
            const row = requireReview(rest[0] ?? "");
            await refreshStack(row, true);
            const stack = stackViewFor(requireReview(row.id));
            if (stack === null) return ok(null, `${row.owner}/${row.repo}#${row.number} is not in a stack.`);
            const label = stack.number !== null ? `GitHub stack #${stack.number}` : "inferred stack";
            const text = [
              `${label} on ${stack.baseRefName} (${stack.source}, ${stack.entries.length} PRs). Current layer ${stack.currentPosition}/${stack.entries.length}.`,
              ...stack.entries.map((e) => `  ${e.position}. #${e.number} ${e.state}${e.merged ? " merged" : ""}  ${e.title}  +${e.additions}/-${e.deletions}${e.number === row.number ? "  ←" : ""}`),
            ].join("\n");
            return ok(stack, text);
          }
          default:
            return { exitCode: 1, stderr: "usage: bb review-desk open|list|stack" };
        }
      } catch (cause) {
        return { exitCode: 1, stderr: errorMessage(cause) };
      }
    },
  });

  bb.background.service("sync-open-reviews", {
    async start(signal) {
      while (!signal.aborted) {
        const started = Date.now();
        await Promise.all(
          q.reviews.all().map(async (row) => {
            try {
              await syncReview(row.id);
            } catch (cause) {
              bb.log.warn(`sync ${row.owner}/${row.repo}#${row.number}: ${errorMessage(cause)}`);
            }
          }),
        );
        for (const tracked of stacks.list()) {
          try {
            await refreshStackSnapshot(tracked.owner, tracked.repo, tracked.stack.entries[0]?.number ?? 0, tracked.hostId, tracked);
          } catch (cause) {
            bb.log.warn(`sync stack ${tracked.key}: ${errorMessage(cause)}`);
          }
        }
        await sleep(Math.max(0, SYNC_EVERY_MS - (Date.now() - started)), signal);
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
  bb.log.info("loaded");
}
