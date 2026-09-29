// bb-plugin-review-desk — server entry.
//
// Owns review records, GitHub caches, pending comments, chat seats and the
// codemap cache in the plugin's SQLite. Talks to the machine that holds the
// repository through the host entry (git, gh, tree-sitter). Chat with the PR
// runs on ordinary hidden bb threads (one per provider per review) spawned into
// the PR worktree; the UI renders them with bb's own ThreadChat.
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { defineRpcContract, type BbPluginApi, type PluginMentionItem, type PluginMentionSearchContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MENTION_PROVIDER_ID, decodeMentionRef, encodeMentionRef, mentionLabel, type MentionRef } from "./mention-ref";
import { computeSlop, hunkLineNumbers, type SlopReport } from "./slop";
import { BRIEF_FENCE, type Brief, type BriefEvidence } from "./brief-spec";
import {
  renderAnalystIntro,
  renderBrief,
  renderChatSelection,
  renderHelperIntro,
  renderMentionCommit,
  renderMentionCrange,
  renderMentionFile,
  renderMentionPr,
  renderMentionRange,
  renderMentionSymbol,
  renderMentionThread,
  renderNotes,
  type CodemapPrompt,
  type FilePrompt,
  type PrPrompt,
  type SignalsPrompt,
  type StackPrompt,
} from "./prompts";
import {
  changedFileSchema,
  codemapSchema,
  ghIssueCommentSchema,
  ghReviewSchema,
  ghThreadSchema,
  hostContract,
  prStackEntrySchema,
  prStackSchema,
  type ChangedFile,
  type Codemap,
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
  id: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  headSha: z.string(),
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

const seatSchema = z.object({
  providerId: z.string(),
  threadId: z.string(),
  environmentId: z.string().nullable(),
  createdAt: z.number(),
});
export type Seat = z.infer<typeof seatSchema>;

const selectionSchema = z.object({
  path: z.string(),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  side: sideSchema,
});
export type SelectionRef = z.infer<typeof selectionSchema>;

const codemapStateSchema = z.object({
  status: z.enum(["missing", "building", "ready", "failed"]),
  codemap: codemapSchema.nullable(),
  error: z.string().nullable(),
  updatedAt: z.number().nullable(),
});
export type CodemapState = z.infer<typeof codemapStateSchema>;

const providerOptionSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  available: z.boolean(),
  models: z.array(z.object({ model: z.string(), displayName: z.string(), isDefault: z.boolean() })),
});
export type ProviderOption = z.infer<typeof providerOptionSchema>;

/** The Brief tab's state: deterministic slop signals plus the helper-written brief. Payloads stay loose on the wire; app.tsx casts to the shared types. */
const briefStateSchema = z.object({
  headSha: z.string(),
  signalsStatus: z.enum(["missing", "computing", "ready", "failed"]),
  signals: z.record(z.string(), z.unknown()).nullable(),
  signalsError: z.string().nullable(),
  briefStatus: z.enum(["missing", "writing", "ready", "failed"]),
  brief: z.record(z.string(), z.unknown()).nullable(),
  briefError: z.string().nullable(),
  /** The stored brief was written for an older head. */
  stale: z.boolean(),
  updatedAt: z.number().nullable(),
  helperModel: z.string(),
  helperModels: z.array(z.object({ model: z.string(), displayName: z.string(), isDefault: z.boolean() })),
});
export type BriefState = z.infer<typeof briefStateSchema>;

const commitInfoSchema = z.object({ sha: z.string(), parents: z.array(z.string()), author: z.string(), date: z.string(), title: z.string(), body: z.string() });
export type CommitInfo = z.infer<typeof commitInfoSchema>;

/** A private note: visible only here until promoted to a pending GitHub comment. */
const noteKindSchema = z.enum(["slop", "cleanup", "risk", "question"]);
const noteSeveritySchema = z.enum(["low", "medium", "high"]);
const noteSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  path: z.string(),
  line: z.number(),
  startLine: z.number().nullable(),
  side: z.enum(["LEFT", "RIGHT"]),
  kind: noteKindSchema,
  severity: noteSeveritySchema,
  title: z.string(),
  body: z.string(),
  suggestion: z.string().nullable(),
  source: z.enum(["signal", "helper", "me"]),
  signalId: z.string().nullable(),
  state: z.enum(["open", "dismissed", "promoted", "stale"]),
  createdAt: z.number(),
});
export type Note = z.infer<typeof noteSchema>;
export type NoteKind = z.infer<typeof noteKindSchema>;

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
      seats: z.array(seatSchema),
      notes: z.array(noteSchema),
      /** The helper is currently looking for slop and cleanups. */
      notesRunning: z.boolean(),
      notesError: z.string().nullable(),
      /** Heads you opened this review at: the one before the current, and the current. */
      seen: z.object({ prevHead: z.string().nullable(), seenHead: z.string().nullable() }),
      /** Project the analyst threads are created in (the composer needs one). */
      chatProjectId: z.string(),
      stack: stackViewSchema.nullable(),
    }),
  },
  reviews_sync: { input: reviewIdSchema, output: z.object({ review: reviewSchema, headChanged: z.boolean() }) },
  reviews_remove: { input: reviewIdSchema, output: okSchema },
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
    output: z.object({ comments: z.array(ghIssueCommentSchema), reviews: z.array(ghReviewSchema), fetchedAt: z.number().nullable() }),
  },
  review_threads_refresh: { input: reviewIdSchema, output: z.object({ threads: z.array(ghThreadSchema) }) },
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
  /** Send a chat message to the analyst for a provider, spawning it on first use. */
  chat_send: {
    input: z.object({
      reviewId: z.string(),
      providerId: z.string().min(1),
      model: z.string().nullable().optional(),
      text: z.string().trim().min(1).max(20_000),
      selection: selectionSchema.nullable().optional(),
    }),
    output: z.object({ seat: seatSchema }),
  },
  /**
   * Start or continue a chat from bb's own new-thread composer: the input is
   * the composer's prompt blocks (text, @-mention pills, attachments) and the
   * execution choices the user made on screen. Spawns the seat on first use
   * with the analyst intro as agent-only context ahead of the message.
   */
  chat_start: {
    input: z.object({
      reviewId: z.string(),
      providerId: z.string().min(1),
      model: z.string().min(1).optional(),
      reasoningLevel: z.string().optional(),
      permissionMode: z.string().optional(),
      serviceTier: z.string().optional(),
      executionInputSources: z.record(z.string(), z.enum(["client-preference", "explicit"])).optional(),
      input: z.array(z.record(z.string(), z.unknown())).min(1),
    }),
    output: z.object({ seat: seatSchema }),
  },
  /** Which review a thread belongs to, if it is one of our analyst seats. */
  seat_lookup: { input: z.object({ threadId: z.string() }), output: z.object({ seat: z.object({ reviewId: z.string(), providerId: z.string() }).nullable() }) },
  chat_reset: { input: z.object({ reviewId: z.string(), providerId: z.string() }), output: okSchema },
  codemap_get: { input: z.object({ reviewId: z.string(), refresh: z.boolean().optional() }), output: codemapStateSchema },
  rooms_list: { input: z.null(), output: z.object({ rooms: z.array(z.object({ id: z.string(), title: z.string(), handles: z.array(z.string()) })), available: z.boolean() }) },
  send_to_room: {
    input: z.object({ roomId: z.string(), text: z.string().trim().min(1).max(20_000), tags: z.array(z.string()).max(8), turns: z.number().int().min(0).max(40).optional() }),
    output: okSchema,
  },
  context_providers: { input: z.null(), output: z.object({ providers: z.array(providerOptionSchema), defaultProvider: z.string() }) },
  /** Signals compute on first call for a head; the brief is written on first call too when autoBrief is on. */
  brief_get: { input: z.object({ reviewId: z.string(), refresh: z.boolean().optional() }), output: briefStateSchema },
  /** (Re)write the plain-English brief at the current head. */
  brief_write: { input: reviewIdSchema, output: briefStateSchema },
  /** Put one slop signal's evidence lines into the diff as notes (or take them out again). */
  notes_from_signal: { input: z.object({ reviewId: z.string(), signalId: z.string(), show: z.boolean() }), output: z.object({ count: z.number() }) },
  /** Ask the helper to find slop and cleanups; notes arrive over realtime. */
  notes_find: { input: reviewIdSchema, output: okSchema },
  helper_set_model: { input: z.object({ model: z.string().trim().min(1) }), output: z.object({ model: z.string() }) },
  note_add: {
    input: z.object({ reviewId: z.string(), path: z.string(), line: z.number().int().min(1), startLine: z.number().int().min(1).nullable().optional(), side: z.enum(["LEFT", "RIGHT"]), body: z.string().trim().min(1).max(20_000), kind: noteKindSchema.optional() }),
    output: z.object({ note: noteSchema }),
  },
  note_update: { input: z.object({ id: z.string(), state: z.enum(["open", "dismissed"]).optional(), body: z.string().trim().min(1).max(20_000).optional() }), output: z.object({ note: noteSchema }) },
  note_delete: { input: z.object({ id: z.string() }), output: okSchema },
  /** Turn a note into a pending GitHub comment; the note is kept as promoted. */
  note_promote: { input: z.object({ id: z.string() }), output: z.object({ pending: pendingSchema }) },
  notes_clear: { input: z.object({ reviewId: z.string(), source: z.enum(["signal", "helper", "me"]).optional(), dismissedOnly: z.boolean().optional(), staleOnly: z.boolean().optional() }), output: z.object({ removed: z.number() }) },
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
];

interface ReviewRow {
  id: string; owner: string; repo: string; number: number; title: string; body: string; state: string; is_draft: number; url: string; author: string | null;
  base_ref: string; head_ref: string; head_sha: string; base_sha: string; additions: number; deletions: number; changed_files: number;
  review_decision: string | null; mergeable: string | null; labels_json: string; checks_json: string; reviewers_json: string; assignees_json: string; commits_json: string; gh_created_at: string;
  worktree: string; environment_id: string | null; host_id: string; repo_path: string; project_id: string | null; gh_updated_at: string; synced_at: number; created_at: number; updated_at: number;
}
interface PendingRow { id: string; review_id: string; path: string; line: number; start_line: number | null; side: string; body: string; created_at: number }
interface SeatRow { review_id: string; provider_id: string; thread_id: string; environment_id: string | null; created_at: number }
interface CodemapRow { review_id: string; head_sha: string; status: string; json: string | null; error: string | null; updated_at: number }
interface CacheRow { review_id: string; json: string; fetched_at: number }
interface HelperRow { review_id: string; thread_id: string; provider_id: string; environment_id: string | null; job: string | null; created_at: number; model: string }
interface NoteRow {
  id: string; review_id: string; head_sha: string; path: string; line: number; start_line: number | null; side: string; kind: string; severity: string; title: string; body: string;
  suggestion: string | null; source: string; signal_id: string | null; state: string; anchor_hash: string | null; created_at: number; updated_at: number;
}
interface BriefRow {
  review_id: string; head_sha: string; signals_status: string; signals_json: string | null; signals_error: string | null;
  brief_status: string; brief_head_sha: string | null; brief_json: string | null; brief_raw: string | null; brief_error: string | null; updated_at: number;
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
    setEnvironment: db.prepare<[string, string]>(`UPDATE reviews SET environment_id = ? WHERE id = ?`),
    touch: db.prepare<[number, string]>(`UPDATE reviews SET updated_at = ? WHERE id = ?`),
    setSyncedAt: db.prepare<[number, string]>(`UPDATE reviews SET synced_at = ? WHERE id = ?`),
    setDraft: db.prepare<[number, number, string]>(`UPDATE reviews SET is_draft = ?, updated_at = ? WHERE id = ?`),
    setClosed: db.prepare<[string, number, string, string, number, number, string]>(
      `UPDATE reviews SET state = ?, is_draft = ?, title = ?, gh_updated_at = ?, synced_at = ?, updated_at = ? WHERE id = ?`,
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
    seat: db.prepare<[string, string], SeatRow>(`SELECT * FROM seats WHERE review_id = ? AND provider_id = ?`),
    seats: db.prepare<[string], SeatRow>(`SELECT * FROM seats WHERE review_id = ? ORDER BY created_at ASC`),
    seatByThread: db.prepare<[string], SeatRow>(`SELECT * FROM seats WHERE thread_id = ?`),
    reviewsByProject: db.prepare<[string], ReviewRow>(`SELECT * FROM reviews WHERE project_id = ? ORDER BY updated_at DESC`),
    upsertSeat: db.prepare<[string, string, string, string | null, number]>(
      `INSERT INTO seats (review_id, provider_id, thread_id, environment_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(review_id, provider_id) DO UPDATE SET thread_id = excluded.thread_id, environment_id = excluded.environment_id`,
    ),
    deleteSeat: db.prepare<[string, string]>(`DELETE FROM seats WHERE review_id = ? AND provider_id = ?`),
    helper: db.prepare<[string], HelperRow>(`SELECT * FROM helpers WHERE review_id = ?`),
    helperByThread: db.prepare<[string], HelperRow>(`SELECT * FROM helpers WHERE thread_id = ?`),
    upsertHelper: db.prepare<[string, string, string, string | null, number, string]>(
      `INSERT INTO helpers (review_id, thread_id, provider_id, environment_id, created_at, model) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(review_id) DO UPDATE SET thread_id = excluded.thread_id, provider_id = excluded.provider_id, environment_id = excluded.environment_id, model = excluded.model`,
    ),
    setHelperJob: db.prepare<[string | null, string]>(`UPDATE helpers SET job = ? WHERE review_id = ?`),
    deleteHelper: db.prepare<[string]>(`DELETE FROM helpers WHERE review_id = ?`),
    brief: db.prepare<[string], BriefRow>(`SELECT * FROM briefs WHERE review_id = ?`),
    ensureBrief: db.prepare<[string, string, number]>(`INSERT INTO briefs (review_id, head_sha, updated_at) VALUES (?, ?, ?) ON CONFLICT(review_id) DO NOTHING`),
    setSignals: db.prepare<[string, string, string | null, string | null, number, string]>(
      `UPDATE briefs SET head_sha = ?, signals_status = ?, signals_json = ?, signals_error = ?, updated_at = ? WHERE review_id = ?`,
    ),
    setBrief: db.prepare<[string, string | null, string | null, string | null, string | null, number, string]>(
      `UPDATE briefs SET brief_status = ?, brief_head_sha = ?, brief_json = ?, brief_raw = ?, brief_error = ?, updated_at = ? WHERE review_id = ?`,
    ),
    notes: db.prepare<[string], NoteRow>(`SELECT * FROM notes WHERE review_id = ? ORDER BY path ASC, line ASC, created_at ASC`),
    noteById: db.prepare<[string], NoteRow>(`SELECT * FROM notes WHERE id = ?`),
    notesBySignal: db.prepare<[string, string], NoteRow>(`SELECT * FROM notes WHERE review_id = ? AND signal_id = ?`),
    insertNote: db.prepare<[string, string, string, string, number, number | null, string, string, string, string, string, string | null, string, string | null, string | null, number, number]>(
      `INSERT INTO notes (id, review_id, head_sha, path, line, start_line, side, kind, severity, title, body, suggestion, source, signal_id, anchor_hash, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    ),
    setNoteState: db.prepare<[string, number, string]>(`UPDATE notes SET state = ?, updated_at = ? WHERE id = ?`),
    setNoteBody: db.prepare<[string, number, string]>(`UPDATE notes SET body = ?, updated_at = ? WHERE id = ?`),
    setNoteLine: db.prepare<[number, number | null, string, number, string]>(`UPDATE notes SET line = ?, start_line = ?, head_sha = ?, updated_at = ? WHERE id = ?`),
    deleteNote: db.prepare<[string]>(`DELETE FROM notes WHERE id = ?`),
    deleteSignalNotes: db.prepare<[string, string]>(`DELETE FROM notes WHERE review_id = ? AND signal_id = ? AND state IN ('open', 'stale')`),
    deleteNotesBySource: db.prepare<[string, string]>(`DELETE FROM notes WHERE review_id = ? AND source = ? AND state <> 'promoted'`),
    deleteDismissedNotes: db.prepare<[string]>(`DELETE FROM notes WHERE review_id = ? AND state = 'dismissed'`),
    deleteStaleNotes: db.prepare<[string]>(`DELETE FROM notes WHERE review_id = ? AND state = 'stale'`),
    deleteAllNotes: db.prepare<[string]>(`DELETE FROM notes WHERE review_id = ? AND state <> 'promoted'`),
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
    deleteBrief: db.prepare<[string]>(`DELETE FROM briefs WHERE review_id = ?`),
    deleteSeen: db.prepare<[string]>(`DELETE FROM review_seen WHERE review_id = ?`),
    deleteCodemap: db.prepare<[string]>(`DELETE FROM codemaps WHERE review_id = ?`),
    deleteIllustrators: db.prepare<[string]>(`DELETE FROM illustrators WHERE review_id = ?`),
    deleteDiagrams: db.prepare<[string]>(`DELETE FROM diagrams WHERE review_id = ?`),
    codemap: db.prepare<[string], CodemapRow>(`SELECT * FROM codemaps WHERE review_id = ?`),
    setCodemap: db.prepare<[string, string, string, string | null, string | null, number]>(
      `INSERT INTO codemaps (review_id, head_sha, status, json, error, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(review_id) DO UPDATE SET head_sha = excluded.head_sha, status = excluded.status, json = excluded.json, error = excluded.error, updated_at = excluded.updated_at`,
    ),
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

function toSeat(row: SeatRow): Seat {
  return { providerId: row.provider_id, threadId: row.thread_id, environmentId: row.environment_id, createdAt: row.created_at };
}

const NOTE_KINDS = ["slop", "cleanup", "risk", "question"] as const;
const NOTE_SEVERITIES = ["low", "medium", "high"] as const;
function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    reviewId: row.review_id,
    path: row.path,
    line: row.line,
    startLine: row.start_line,
    side: row.side === "LEFT" ? "LEFT" : "RIGHT",
    kind: (NOTE_KINDS as readonly string[]).includes(row.kind) ? (row.kind as Note["kind"]) : "cleanup",
    severity: (NOTE_SEVERITIES as readonly string[]).includes(row.severity) ? (row.severity as Note["severity"]) : "low",
    title: row.title,
    body: row.body,
    suggestion: row.suggestion,
    source: row.source === "signal" || row.source === "helper" ? row.source : "me",
    signalId: row.signal_id,
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

function stackKey(stack: PrStack, owner: string, repo: string): string {
  return stack.number !== null ? `gh:${owner}/${repo}#${stack.number}` : `inf:${owner}/${repo}#${stack.entries[0]?.number ?? 0}`;
}

function remoteMatches(remote: string | null, owner: string, repo: string): boolean {
  if (remote === null) return false;
  const normalized = remote.replace(/\.git$/, "").toLowerCase();
  return normalized.endsWith(`${owner}/${repo}`.toLowerCase());
}

function wasmDirCandidates(): string[] {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return [`${here}node_modules/@vscode/tree-sitter-wasm/wasm`, `${here}../node_modules/@vscode/tree-sitter-wasm/wasm`];
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    defaultProvider: { type: "string", label: "Default AI provider id for the PR chat", default: "claude-code" },
    hideSeatThreads: { type: "boolean", label: "Hide analyst threads from the sidebar", default: true },
    autoBrief: { type: "boolean", label: "Write the plain-English brief when a review is first opened at a new head", default: true },
    helperProvider: { type: "string", label: "Provider for the helper thread (brief, slop score, notes)", default: "pi" },
    helperModel: { type: "string", label: "Model for the helper thread (brief, slop score, notes)", default: "nvidia-inference/nvidia/zai-org/glm-5.3" },
  });
  const { defaultProvider, hideSeatThreads, autoBrief, helperProvider: helperProviderSetting, helperModel: helperModelSetting } = await settings.get();
  const DEFAULT_HELPER_PROVIDER = "pi";
  const DEFAULT_HELPER_MODEL = "nvidia-inference/nvidia/zai-org/glm-5.3";
  const PREVIOUS_HELPER_MODEL = "claude-haiku-4-5-20251001";
  let helperProviderNow = helperProviderSetting.trim() || DEFAULT_HELPER_PROVIDER;
  let helperModelNow = helperModelSetting.trim() || DEFAULT_HELPER_MODEL;
  let helperModelsNow: { model: string; displayName: string; isDefault: boolean }[] = [];
  if (helperModelSetting.trim() === "" || helperModelSetting === PREVIOUS_HELPER_MODEL) {
    helperProviderNow = DEFAULT_HELPER_PROVIDER;
    helperModelNow = DEFAULT_HELPER_MODEL;
    void settings.experimental_set({ helperProvider: DEFAULT_HELPER_PROVIDER, helperModel: DEFAULT_HELPER_MODEL });
  }
  async function configuredHelper(): Promise<{ providerId: string; model: string }> {
    const { helperProvider, helperModel } = await settings.get();
    helperProviderNow = helperProvider.trim() || DEFAULT_HELPER_PROVIDER;
    helperModelNow = helperModel.trim() || DEFAULT_HELPER_MODEL;
    return { providerId: helperProviderNow, model: helperModelNow };
  }
  async function refreshHelperModels(): Promise<void> {
    try {
      const result = await bb.sdk.providers.models({ providerId: helperProviderNow });
      helperModelsNow = result.models.map((m) => ({ model: m.model, displayName: m.displayName, isDefault: m.isDefault }));
    } catch {
      helperModelsNow = [];
    }
  }
  await refreshHelperModels();

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const { q }: Store = createStore(db);
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const codemapBuilds = new Set<string>();

  const publish = (reviewId: string, what: string) => bb.realtime.publish(REVIEW_CHANGED, { reviewId, what });

  function requireReview(reviewId: string): ReviewRow {
    const row = q.review.get(reviewId);
    if (row === undefined) throw new Error(`review ${reviewId} not found`);
    return row;
  }

  const hostOptions = (row: ReviewRow) => ({ hostId: row.host_id });

  async function dropHelper(reviewId: string): Promise<void> {
    const helper = q.helper.get(reviewId);
    if (helper === undefined) return;
    try {
      await bb.sdk.threads.archive({ threadId: helper.thread_id });
      await bb.sdk.threads.stop({ threadId: helper.thread_id });
    } catch (cause) {
      bb.log.warn(`drop helper: ${errorMessage(cause)}`);
    }
    q.deleteHelper.run(reviewId);
  }

  /** Take a review out of Review Desk. Does not close the pull request on GitHub. */
  async function dropReview(row: ReviewRow, opts?: { dismiss?: boolean; reason?: string }): Promise<void> {
    for (const seat of q.seats.all(row.id)) await chatReset(row.id, seat.provider_id);
    await dropHelper(row.id);
    q.clearPending.run(row.id);
    q.deleteViewedByReview.run(row.id);
    q.deleteFilesCache.run(row.id);
    q.deleteThreadsCache.run(row.id);
    q.deleteConversationCache.run(row.id);
    q.deleteNotesForReview.run(row.id);
    q.deleteBrief.run(row.id);
    q.deleteSeen.run(row.id);
    q.deleteCodemap.run(row.id);
    q.deleteIllustrators.run(row.id);
    q.deleteDiagrams.run(row.id);
    if (opts?.dismiss === true) q.dismiss.run(row.owner, row.repo, row.number);
    q.deleteReview.run(row.id);
    publish(row.id, opts?.reason ?? "removed");
    void host.call("repo_release", { repoPath: row.repo_path, worktree: row.worktree }, hostOptions(row)).catch((cause: unknown) => {
      bb.log.warn(`release worktree for ${row.owner}/${row.repo}#${row.number}: ${errorMessage(cause)}`);
    });
  }

  function stackCacheRow(owner: string, repo: string, number: number): { json: string; fetched_at: number } | undefined {
    return q.stackCache.get(owner, repo, number);
  }

  function cachedPrStack(owner: string, repo: string, number: number): PrStack | null {
    const cache = stackCacheRow(owner, repo, number);
    if (cache === undefined) return null;
    const stack = parseJson<PrStack | null>(cache.json, null);
    return stack !== null && stack.entries.length >= 2 ? stack : null;
  }

  function storeStack(owner: string, repo: string, number: number, stack: PrStack | null): void {
    const prev = cachedPrStack(owner, repo, number);
    const now = Date.now();
    const json = stack === null || stack.entries.length < 2 ? "null" : JSON.stringify(stack);
    const prevJson = stackCacheRow(owner, repo, number)?.json;
    const same = prevJson === json;
    if (stack === null || stack.entries.length < 2) {
      if (!same) {
        for (const n of prev?.entries.map((e) => e.number) ?? []) {
          if (n !== number) q.deleteStackCache.run(owner, repo, n);
        }
      }
      q.upsertStackCache.run(owner, repo, number, "null", now);
      if (!same) {
        const local = q.reviewByKey.get(owner, repo, number);
        if (local !== undefined) publish(local.id, "stack");
      }
      return;
    }
    const next = new Set(stack.entries.map((e) => e.number));
    if (!same) {
      for (const entry of prev?.entries ?? []) {
        if (!next.has(entry.number)) q.deleteStackCache.run(owner, repo, entry.number);
      }
    }
    for (const entry of stack.entries) q.upsertStackCache.run(owner, repo, entry.number, json, now);
    if (same) return;
    for (const entry of stack.entries) {
      const local = q.reviewByKey.get(owner, repo, entry.number);
      if (local !== undefined) publish(local.id, "stack");
    }
  }

  function patchStackDraft(owner: string, repo: string, number: number, isDraft: boolean): void {
    const stack = cachedPrStack(owner, repo, number);
    if (stack === null) return;
    if (stack.entries.every((entry) => entry.number !== number || entry.isDraft === isDraft)) return;
    storeStack(owner, repo, number, {
      ...stack,
      entries: stack.entries.map((entry) => (entry.number === number ? { ...entry, isDraft } : entry)),
    });
  }

  const stackRefresh = new Map<string, Promise<void>>();
  const reviewSync = new Map<string, Promise<{ review: Review; headChanged: boolean }>>();
  const SYNC_EVERY_MS = 15_000;
  const STACK_FRESH_MS = 15_000;

  function stackFetchedAt(owner: string, repo: string, number: number): number | null {
    return stackCacheRow(owner, repo, number)?.fetched_at ?? null;
  }

  function stackFresh(owner: string, repo: string, number: number): boolean {
    const at = stackFetchedAt(owner, repo, number);
    return at !== null && Date.now() - at < STACK_FRESH_MS;
  }

  function stackInflightKey(row: ReviewRow): string {
    const stack = cachedPrStack(row.owner, row.repo, row.number);
    if (stack?.number != null) return `${row.owner}/${row.repo}/s/${stack.number}`;
    if (stack !== null && stack.entries[0] !== undefined) return `${row.owner}/${row.repo}/i/${stack.entries[0].number}`;
    return `${row.owner}/${row.repo}#${row.number}`;
  }

  async function refreshStack(row: ReviewRow, force = false): Promise<void> {
    if (!force && stackFresh(row.owner, row.repo, row.number)) {
      void openMissingStackLayers(row.owner, row.repo, row.number);
      return;
    }
    const key = stackInflightKey(row);
    const inflight = stackRefresh.get(key);
    if (inflight !== undefined) return inflight;
    const work = (async () => {
      try {
        const result = await host.call("gh_stack", { owner: row.owner, repo: row.repo, number: row.number, stackNumber: null }, hostOptions(row));
        storeStack(row.owner, row.repo, row.number, result.stack);
        void openMissingStackLayers(row.owner, row.repo, row.number);
      } catch (cause) {
        bb.log.warn(`stack for ${row.owner}/${row.repo}#${row.number}: ${errorMessage(cause)}`);
      } finally {
        stackRefresh.delete(key);
      }
    })();
    stackRefresh.set(key, work);
    return work;
  }

  async function ensureStack(row: ReviewRow): Promise<void> {
    if (stackCacheRow(row.owner, row.repo, row.number) === undefined) {
      await refreshStack(row, true);
      return;
    }
    void refreshStack(row);
  }

  function discoverStacks(rows: ReviewRow[]): void {
    for (const row of rows) {
      if (!prIsOpen(row.state) && stackCacheRow(row.owner, row.repo, row.number) !== undefined) continue;
      void refreshStack(row);
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
          isDraft: local !== undefined ? local.is_draft === 1 : entry.isDraft,
          reviewId: local?.id ?? null,
          pendingCount: local === undefined ? 0 : q.pending.all(local.id).length,
          viewedCount: local === undefined ? 0 : q.viewed.all(local.id).length,
        };
      }),
    };
  }

  function stackSummaryFor(row: ReviewRow): ReviewSummary["stack"] {
    const stack = cachedPrStack(row.owner, row.repo, row.number);
    if (stack === null) return null;
    const current = stack.entries.find((e) => e.number === row.number);
    return { number: stack.number, position: current?.position ?? 1, size: stack.entries.length, key: stackKey(stack, row.owner, row.repo) };
  }

  function prPrompt(row: ReviewRow): PrPrompt {
    return { owner: row.owner, repo: row.repo, number: row.number, title: row.title, headSha: row.head_sha, baseSha: row.base_sha, baseRef: row.base_ref };
  }

  function stackPrompt(row: ReviewRow): StackPrompt | null {
    const stack = cachedPrStack(row.owner, row.repo, row.number);
    if (stack === null) return null;
    const current = stack.entries.find((e) => e.number === row.number);
    return {
      label: stack.number !== null ? `GitHub stack #${stack.number}` : "a stack inferred from PR bases",
      position: current?.position ?? "?",
      size: stack.entries.length,
      baseRefName: stack.baseRefName,
      entries: stack.entries.map((e) => ({
        position: e.position,
        number: e.number,
        state: e.state,
        merged: e.merged,
        isDraft: e.isDraft,
        title: e.title,
        additions: e.additions,
        deletions: e.deletions,
        current: e.number === row.number,
      })),
    };
  }

  function filesPrompt(files: ChangedFile[], cap = 150): { files: FilePrompt[]; fileCount: number; filesMore: number } {
    return {
      files: files.slice(0, cap).map((f) => ({ status: f.status.padEnd(8), path: f.path, additions: f.additions, deletions: f.deletions })),
      fileCount: files.length,
      filesMore: Math.max(0, files.length - cap),
    };
  }

  function signalsPrompt(report: SlopReport | null): SignalsPrompt | null {
    if (report === null) return null;
    return {
      items: report.signals.map((s) => ({
        label: s.label,
        count: s.count,
        evidence: s.evidence.slice(0, 3).map((e) => (e.line === null ? e.note : `${e.path}:${e.line} ${e.note}`)).join("; "),
      })),
    };
  }

  function codemapPrompt(row: ReviewRow): CodemapPrompt | null {
    const state = codemapState(row);
    if (state.status !== "ready" || state.codemap === null) return null;
    const c = state.codemap;
    return {
      readingOrder: c.readingOrder.map((m) => ({ module: m.module, pathCount: m.paths.length, reason: m.reason })),
      hotspots: c.hotspots.slice(0, 10).map((h) => ({ path: h.path, qualified: h.qualified, changedLines: h.changedLines, fanIn: h.fanIn })),
      symbols: [...changedSymbols(row)].sort((a, b) => b.changedLines - a.changedLines).slice(0, 60).map((s) => ({
        status: s.status.padEnd(8),
        kind: s.kind.padEnd(9),
        qualified: s.qualified,
        loc: s.status === "removed" ? `${s.path}:${s.oldStart}-${s.oldEnd} (base)` : `${s.path}:${s.start}-${s.end}`,
      })),
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

  function applyPr(row: ReviewRow, pr: GhPr, prepared: { worktree: string; headSha: string; baseSha: string }): void {
    const now = Date.now();
    q.updateReviewMeta.run(
      pr.title, pr.body, pr.state, pr.isDraft ? 1 : 0, pr.author?.login ?? null, pr.baseRefName, pr.headRefName, prepared.headSha, prepared.baseSha,
      pr.additions, pr.deletions, pr.changedFiles, pr.reviewDecision, pr.mergeable, JSON.stringify(pr.labels), JSON.stringify(pr.checks),
      JSON.stringify(pr.reviewers), JSON.stringify(pr.assignees), JSON.stringify(pr.commits), pr.createdAt,
      prepared.worktree, pr.updatedAt, now, now, row.id,
    );
  }

  const stackOpen = new Map<string, Promise<void>>();

  /** Open a review row (worktree, files, threads) for every layer that is not local yet. */
  function openMissingStackLayers(owner: string, repo: string, number: number): Promise<void> {
    const stack = cachedPrStack(owner, repo, number);
    if (stack === null) return Promise.resolve();
    const key = stackKey(stack, owner, repo);
    const inflight = stackOpen.get(key);
    if (inflight !== undefined) return inflight;
    const missing = stack.entries.filter((entry) => {
      if (entry.merged || !prIsOpen(entry.state)) return false;
      if (q.dismissed.get(owner, repo, entry.number) !== undefined) return false;
      return q.reviewByKey.get(owner, repo, entry.number) === undefined;
    });
    if (missing.length === 0) return Promise.resolve();
    const work = (async () => {
      try {
        await mapLimit(missing, 3, async (entry) => {
          try {
            await openPr(owner, repo, entry.number, { skipStack: true });
          } catch (cause) {
            bb.log.warn(`stack layer ${owner}/${repo}#${entry.number}: ${errorMessage(cause)}`);
          }
        });
        for (const entry of stack.entries) {
          const local = q.reviewByKey.get(owner, repo, entry.number);
          if (local !== undefined) publish(local.id, "stack");
        }
      } finally {
        stackOpen.delete(key);
      }
    })();
    stackOpen.set(key, work);
    return work;
  }

  async function openPr(owner: string, repo: string, number: number, opts?: { skipStack?: boolean }): Promise<Review> {
    q.undismiss.run(owner, repo, number);
    const existing = q.reviewByKey.get(owner, repo, number);
    if (existing !== undefined) {
      if (opts?.skipStack) return toReview(requireReview(existing.id));
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
    void refreshThreads(row).catch((cause: unknown) => bb.log.warn(`threads for ${id}: ${errorMessage(cause)}`));
    if (!opts?.skipStack) await refreshStack(row);
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
      storeStack(parsed.owner, parsed.repo, result.stack.entries[0].number, result.stack);
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
        return await syncReviewOnce(reviewId, force);
      } finally {
        reviewSync.delete(reviewId);
      }
    })();
    reviewSync.set(reviewId, work);
    return work;
  }

  async function syncReviewOnce(reviewId: string, force: boolean): Promise<{ review: Review; headChanged: boolean }> {
    const row = requireReview(reviewId);
    if (!force && Date.now() - row.synced_at < SYNC_EVERY_MS && stackFresh(row.owner, row.repo, row.number)) {
      return { review: toReview(row), headChanged: false };
    }
    const pr = await host.call("gh_pr", { owner: row.owner, repo: row.repo, number: row.number }, hostOptions(row));
    const wasOpen = prIsOpen(row.state);
    if (!prIsOpen(pr.state)) {
      const now = Date.now();
      if (pr.state !== row.state || pr.isDraft !== (row.is_draft === 1) || pr.title !== row.title || pr.updatedAt !== row.gh_updated_at) {
        q.setClosed.run(pr.state, pr.isDraft ? 1 : 0, pr.title, pr.updatedAt, now, now, row.id);
      } else {
        q.setSyncedAt.run(now, row.id);
      }
      if (wasOpen) {
        publish(row.id, "closed");
        await refreshStack(row);
      }
      return { review: toReview(requireReview(reviewId)), headChanged: false };
    }
    const headChanged = pr.headRefOid !== row.head_sha;
    const baseMoved = pr.baseRefName !== row.base_ref;
    const touched = force || headChanged || baseMoved || pr.updatedAt !== row.gh_updated_at || pr.title !== row.title || pr.body !== row.body || pr.state !== row.state || pr.isDraft !== (row.is_draft === 1) || (pr.reviewDecision ?? null) !== row.review_decision;
    if (!touched) {
      q.setSyncedAt.run(Date.now(), row.id);
      await refreshStack(row);
      return { review: toReview(requireReview(reviewId)), headChanged: false };
    }
    const key = `${row.owner}__${row.repo}__${row.number}`;
    const prepared = headChanged || baseMoved || row.worktree === ""
      ? await host.call(
          "repo_prepare",
          { repoPath: row.repo_path, number: row.number, headSha: pr.headRefOid, baseRefName: pr.baseRefName, worktreesDir: "", key },
          hostOptions(row),
        )
      : { worktree: row.worktree, headSha: pr.headRefOid, baseSha: row.base_sha };
    applyPr(row, pr, prepared);
    const fresh = requireReview(reviewId);
    if (headChanged || cachedFiles(fresh) === null) await refreshFiles(fresh);
    await refreshThreads(fresh).catch((cause: unknown) => bb.log.warn(`threads for ${reviewId}: ${errorMessage(cause)}`));
    if (headChanged) await reanchorNotes(fresh).catch((cause: unknown) => bb.log.warn(`notes for ${reviewId}: ${errorMessage(cause)}`));
    await refreshConversation(fresh).catch((cause: unknown) => bb.log.warn(`conversation for ${reviewId}: ${errorMessage(cause)}`));
    await refreshStack(fresh, true);
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
      if (!contents.has(note.path)) {
        const shown = await host.call("git_show", { worktree: row.worktree, sha: note.side === "LEFT" ? row.base_sha : row.head_sha, path: note.path }, hostOptions(row)).catch(() => ({ content: null }));
        contents.set(note.path, shown.content === null ? null : shown.content.split("\n"));
      }
      const lines = contents.get(note.path) ?? null;
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
    q.setThreadsCache.run(row.id, JSON.stringify(result.threads), Date.now());
    publish(row.id, "threads");
    return result.threads;
  }

  async function refreshConversation(row: ReviewRow): Promise<void> {
    const result = await host.call("gh_conversation", { owner: row.owner, repo: row.repo, number: row.number }, hostOptions(row));
    q.setConversationCache.run(row.id, JSON.stringify(result), Date.now());
    publish(row.id, "conversation");
  }

  function cachedThreads(row: ReviewRow): GhThread[] {
    const cache = q.threadsCache.get(row.id);
    return cache === undefined ? [] : parseJson<GhThread[]>(cache.json, []);
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
          ).catch(() => ({ patch: "" }));
          hunks = result.patch.trim() === "" ? null : hunkLineNumbers(result.patch);
          hunksByPath.set(file.path, hunks);
        }
        stale = hunks === null || !pendingHitsDiff(hunks, pending.side, pending.line, pending.start_line);
      }
      out.push(toPending(pending, stale));
    }
    return out;
  }

  async function reviewDetail(reviewId: string) {
    const row = requireReview(reviewId);
    void syncReview(reviewId);
    await ensureStack(row);
    const files = await filesFor(row);
    const viewed = new Set(q.viewed.all(row.id).map((v) => v.path));
    const threads = cachedThreads(row);
    const pending = await pendingFor(row, files);
    const perPath = new Map<string, { threads: number; unresolved: number; pending: number }>();
    const bump = (p: string, field: "threads" | "unresolved" | "pending") => {
      const entry = perPath.get(p) ?? { threads: 0, unresolved: 0, pending: 0 };
      entry[field]++;
      perPath.set(p, entry);
    };
    for (const t of threads) {
      bump(t.path, "threads");
      if (!t.isResolved) bump(t.path, "unresolved");
    }
    for (const p of pending) bump(fileForPath(files, p.path)?.path ?? p.path, "pending");
    return {
      review: toReview(row),
      files: files.map((f) => {
        const counts = perPath.get(f.path) ?? { threads: 0, unresolved: 0, pending: 0 };
        return { ...f, viewed: viewed.has(f.path), threadCount: counts.threads, unresolvedCount: counts.unresolved, pendingCount: counts.pending };
      }),
      pending,
      threads,
      seats: q.seats.all(row.id).map(toSeat),
      notes: q.notes.all(row.id).map(toNote),
      notesRunning: q.helper.get(row.id)?.job === "notes",
      notesError: notesErrors.get(row.id) ?? null,
      seen: seenState(row),
      chatProjectId: await chatProjectId(row),
      stack: stackViewFor(row),
    };
  }
  const notesErrors = new Map<string, string>();

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

  // -- chat seats ------------------------------------------------------------

  async function waitForEnvironment(threadId: string, timeoutMs = 90_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.environmentId !== null) return thread.environmentId;
      } catch (cause) {
        bb.log.warn(`environment of ${threadId}: ${errorMessage(cause)}`);
      }
    }
    return null;
  }

  function seatIntro(row: ReviewRow): string {
    return renderAnalystIntro({
      pr: prPrompt(row),
      stack: stackPrompt(row),
      description: row.body.trim() === "" ? "(none)" : row.body.trim().slice(0, 6000),
    });
  }

  async function excerpt(row: ReviewRow, selection: SelectionRef): Promise<string> {
    return excerptAt(row, selection.side === "old" ? row.base_sha : row.head_sha, selection.path, selection.startLine, selection.endLine);
  }

  async function excerptAt(row: ReviewRow, sha: string, path: string, startLine: number, endLine: number): Promise<string> {
    const result = await host.call("git_show", { worktree: row.worktree, sha, path }, hostOptions(row));
    if (result.content === null) return "(file content unavailable)";
    const lines = result.content.split("\n");
    const start = Math.min(startLine, endLine);
    const end = Math.max(startLine, endLine);
    const from = Math.max(1, start - 6);
    const to = Math.min(lines.length, end + 6);
    const width = String(to).length;
    return lines
      .slice(from - 1, to)
      .map((line, i) => {
        const n = from + i;
        return `${n >= start && n <= end ? ">" : " "}${String(n).padStart(width)}| ${line}`;
      })
      .join("\n");
  }

  async function chatMessage(row: ReviewRow, text: string, selection: SelectionRef | null): Promise<string> {
    if (selection === null) return text;
    const start = Math.min(selection.startLine, selection.endLine);
    const end = Math.max(selection.startLine, selection.endLine);
    return renderChatSelection({
      path: selection.path,
      start,
      end,
      side: selection.side === "old" ? "base" : "head",
      excerpt: await excerpt(row, selection),
      text,
    });
  }

  type SpawnArgs = Parameters<typeof bb.sdk.threads.spawn>[0];
  type PromptBlocks = Extract<SpawnArgs, { input: unknown }>["input"];
  type SpawnExecution = Pick<SpawnArgs, "model" | "reasoningLevel" | "permissionMode" | "serviceTier" | "executionInputSources">;

  async function chatProjectId(row: ReviewRow): Promise<string> {
    if (row.project_id !== null) return row.project_id;
    const projectId = (await bb.sdk.projects.list({ includePersonal: true })).find((p) => p.kind !== "standard")?.id;
    if (projectId === undefined) throw new Error("no project to spawn the analyst in");
    return projectId;
  }

  async function chatSend(reviewId: string, providerId: string, model: string | null, text: string, selection: SelectionRef | null): Promise<Seat> {
    const row = requireReview(reviewId);
    const message = await chatMessage(row, text, selection);
    return deliver(row, providerId, model === null ? {} : { model }, [{ type: "text", text: message, mentions: [] }]);
  }

  /**
   * Send prompt blocks to the provider's seat, spawning it on first use. The
   * blocks may carry @-mention pills; bb resolves those through our mention
   * provider when it accepts the message.
   */
  async function deliver(row: ReviewRow, providerId: string, execution: SpawnExecution, blocks: PromptBlocks): Promise<Seat> {
    const existing = q.seat.get(row.id, providerId);
    if (existing !== undefined) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: existing.thread_id });
        if (thread.archivedAt === null && thread.deletedAt === null) {
          await bb.sdk.threads.send({ threadId: existing.thread_id, mode: "auto", input: blocks });
          q.touch.run(Date.now(), row.id);
          return toSeat(existing);
        }
      } catch {
        // stale seat; respawn below
      }
      q.deleteSeat.run(row.id, providerId);
    }
    const providers = await bb.sdk.providers.list();
    const provider = providers.find((p) => p.id === providerId);
    if (provider === undefined) throw new Error(`unknown provider ${providerId}`);
    const modes = provider.capabilities.permissionModes;
    const permissionMode = execution.permissionMode ?? (modes.includes("auto") ? "auto" : modes.includes("accept-edits") ? "accept-edits" : undefined);
    const knownEnvironment = row.environment_id ?? q.seats.all(row.id).find((s) => s.environment_id !== null)?.environment_id ?? null;
    const projectId = await chatProjectId(row);
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: knownEnvironment !== null
        ? { type: "reuse", environmentId: knownEnvironment }
        : { type: "host", hostId: row.host_id, workspace: { type: "unmanaged", path: row.worktree } },
      providerId,
      ...execution,
      ...(permissionMode ? { permissionMode } : {}),
      title: `Review Desk ${row.owner}/${row.repo}#${row.number}: ${provider.displayName}`,
      visibility: hideSeatThreads ? "hidden" : "visible",
      // The intro is agent-only context so the chat transcript starts with the
      // reviewer's own question.
      input: [{ type: "text", text: seatIntro(row), mentions: [], visibility: "agent-only" }, ...blocks],
    });
    const now = Date.now();
    q.upsertSeat.run(row.id, providerId, thread.id, knownEnvironment, now);
    publish(row.id, "seats");
    if (knownEnvironment === null) {
      void (async () => {
        const environmentId = thread.environmentId ?? (await waitForEnvironment(thread.id));
        if (environmentId !== null) {
          q.upsertSeat.run(row.id, providerId, thread.id, environmentId, now);
          q.setEnvironment.run(environmentId, row.id);
          publish(row.id, "seats");
        }
      })();
    }
    const seat = q.seat.get(row.id, providerId);
    if (seat === undefined) throw new Error("seat vanished");
    return toSeat(seat);
  }

  async function chatReset(reviewId: string, providerId: string): Promise<void> {
    const seat = q.seat.get(reviewId, providerId);
    if (seat === undefined) return;
    try {
      await bb.sdk.threads.archive({ threadId: seat.thread_id });
      await bb.sdk.threads.stop({ threadId: seat.thread_id });
    } catch (cause) {
      bb.log.warn(`reset seat ${providerId}: ${errorMessage(cause)}`);
    }
    q.deleteSeat.run(reviewId, providerId);
    publish(reviewId, "seats");
  }

  // -- codemap ---------------------------------------------------------------

  function codemapState(row: ReviewRow): CodemapState {
    const cached = q.codemap.get(row.id);
    if (cached === undefined || cached.head_sha !== row.head_sha) {
      return codemapBuilds.has(row.id) ? { status: "building", codemap: null, error: null, updatedAt: null } : { status: "missing", codemap: null, error: null, updatedAt: null };
    }
    if (cached.status === "ready") return { status: "ready", codemap: parseJson<Codemap | null>(cached.json, null), error: null, updatedAt: cached.updated_at };
    if (cached.status === "building") return { status: "building", codemap: null, error: null, updatedAt: cached.updated_at };
    return { status: "failed", codemap: null, error: cached.error, updatedAt: cached.updated_at };
  }

  function startCodemap(row: ReviewRow): void {
    if (codemapBuilds.has(row.id)) return;
    codemapBuilds.add(row.id);
    q.setCodemap.run(row.id, row.head_sha, "building", null, null, Date.now());
    publish(row.id, "codemap");
    void (async () => {
      try {
        const files = await filesFor(row);
        const wasmDir = wasmDirCandidates().find((dir) => existsSync(`${dir}/tree-sitter.wasm`)) ?? null;
        const codemap = await host.call("codemap", { worktree: row.worktree, baseSha: row.base_sha, headSha: row.head_sha, files, wasmDir }, hostOptions(row));
        q.setCodemap.run(row.id, row.head_sha, "ready", JSON.stringify(codemap), null, Date.now());
      } catch (cause) {
        q.setCodemap.run(row.id, row.head_sha, "failed", null, errorMessage(cause), Date.now());
      } finally {
        codemapBuilds.delete(row.id);
        publish(row.id, "codemap");
      }
    })();
  }

  // -- code pills (mention provider) -----------------------------------------
  //
  // `@` in a seat's composer searches this PR: changed files, changed symbols
  // from the codemap, GitHub review threads, the description, and explicit
  // `path:10-20` ranges. The picked item becomes a pill in the draft; bb calls
  // `resolve` when the message is sent and attaches the text as agent-only
  // context, so the transcript shows the pill and the analyst sees the code.

  interface ChangedSymbol { path: string; qualified: string; kind: string; status: string; start: number; end: number; oldStart: number | null; oldEnd: number | null; changedLines: number; fanIn: number }
  const symbolCache = new Map<string, { headSha: string; symbols: ChangedSymbol[] }>();

  function changedSymbols(row: ReviewRow): ChangedSymbol[] {
    const cached = symbolCache.get(row.id);
    if (cached !== undefined && cached.headSha === row.head_sha) return cached.symbols;
    const state = codemapState(row);
    if (state.status !== "ready" || state.codemap === null) return [];
    const symbols = state.codemap.files.flatMap((f) =>
      f.symbols
        .filter((s) => s.status !== "unchanged")
        .map((s) => ({ path: f.path, qualified: s.qualified.replace(/\s+/g, " "), kind: s.kind, status: s.status, start: s.start, end: s.end, oldStart: s.oldStart, oldEnd: s.oldEnd, changedLines: s.changedLines, fanIn: s.fanIn })),
    );
    symbolCache.set(row.id, { headSha: row.head_sha, symbols });
    return symbols;
  }

  /** The review a composer talks about: the seat's review for a thread composer, else the project's latest review. */
  function reviewForComposer(ctx: PluginMentionSearchContext): ReviewRow | null {
    if (ctx.threadId !== null) {
      const seat = q.seatByThread.get(ctx.threadId);
      return seat === undefined ? null : q.review.get(seat.review_id) ?? null;
    }
    if (ctx.projectId !== null) return q.reviewsByProject.all(ctx.projectId)[0] ?? null;
    return null;
  }

  const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

  function matchScore(haystack: string, query: string, weight: number, fuzzy = false): number {
    if (query === "") return weight * 0.5;
    const h = haystack.toLowerCase();
    if (h === query) return weight * 3;
    if (h.startsWith(query)) return weight * 2;
    if (h.includes(query)) return weight;
    if (!fuzzy || query.length < 3) return 0;
    // Subsequence match for paths: "kvr/sel" finds kv-router/src/services/selection.
    let i = 0;
    for (const ch of h) {
      if (ch === query[i]) i++;
      if (i === query.length) return weight * 0.4;
    }
    return 0;
  }

  type ScoredItem = PluginMentionItem & { score: number };
  const scored = (ref: MentionRef, title: string, subtitle: string, icon: string, score: number): ScoredItem => ({ id: encodeMentionRef(ref), title, subtitle, icon, score });

  function mentionSearch(ctx: PluginMentionSearchContext): PluginMentionItem[] {
    const row = reviewForComposer(ctx);
    if (row === null) return [];
    const raw = ctx.query.trim();
    const query = raw.toLowerCase();
    const browsing = query === "";
    const files = cachedFiles(row) ?? [];
    const groups: ScoredItem[][] = [];

    // Explicit ranges: path:10-20, path:10, path#L10-L20.
    const range = /^(.*?)[:#]L?(\d+)(?:-L?(\d+))?$/.exec(raw);
    if (range !== null) {
      const needle = range[1].toLowerCase();
      const a = Number(range[2]);
      const b = Number(range[3] ?? range[2]);
      const candidates = needle === "" ? files.slice(0, 3) : files.filter((f) => f.path.toLowerCase().includes(needle)).slice(0, 5);
      groups.push(candidates.map((f) => {
        const ref: MentionRef = { kind: "range", reviewId: row.id, path: f.path, startLine: Math.min(a, b), endLine: Math.max(a, b), side: "new" };
        return scored(ref, mentionLabel(ref), f.path, "Code", 100);
      }));
    }

    const maxChanged = Math.max(1, ...files.map((f) => f.additions + f.deletions));
    const fileItems: ScoredItem[] = [];
    for (const f of files) {
      const s = Math.max(matchScore(baseName(f.path), query, 10), matchScore(f.path, query, 6, true));
      if (s === 0) continue;
      fileItems.push(scored({ kind: "file", reviewId: row.id, path: f.path }, baseName(f.path), `${f.path} · +${f.additions} -${f.deletions}`, "Code", s + ((f.additions + f.deletions) / maxChanged) * 2));
    }
    groups.push(fileItems);

    const symbolItems: ScoredItem[] = [];
    for (const sym of changedSymbols(row)) {
      const s = Math.max(matchScore(sym.qualified.split("::").pop() ?? sym.qualified, query, 9), matchScore(sym.qualified, query, 5));
      if (s === 0) continue;
      // Removed symbols only exist on the base side.
      const removed = sym.status === "removed" && sym.oldStart !== null && sym.oldEnd !== null;
      const ref: MentionRef = removed
        ? { kind: "symbol", reviewId: row.id, path: sym.path, qualified: sym.qualified, startLine: sym.oldStart ?? 1, endLine: sym.oldEnd ?? 1, side: "old" }
        : { kind: "symbol", reviewId: row.id, path: sym.path, qualified: sym.qualified, startLine: sym.start, endLine: sym.end, side: "new" };
      symbolItems.push(scored(ref, sym.qualified, `${sym.kind} ${sym.status} · ${sym.path}:${ref.startLine}-${ref.endLine}${removed ? " (base)" : ""}`, "Workflow", s + Math.min(sym.changedLines, 200) / 100 + Math.min(sym.fanIn, 50) / 50));
    }
    groups.push(symbolItems);

    const threadItems: ScoredItem[] = [];
    for (const t of cachedThreads(row)) {
      const first = t.comments[0];
      if (first === undefined) continue;
      const s = Math.max(matchScore(first.author, query, 6), matchScore(baseName(t.path), query, 4), matchScore(first.body.slice(0, 300), query, 3));
      if (s === 0) continue;
      const ref: MentionRef = { kind: "thread", reviewId: row.id, threadId: t.id };
      threadItems.push(scored(ref, mentionLabel(ref, { author: first.author, path: t.path, line: t.line ?? t.originalLine }), `${t.isResolved ? "resolved" : "open"} · ${first.body.replace(/\s+/g, " ").slice(0, 80)}`, "MessageSquare", s - (t.isResolved ? 2 : 0)));
    }
    groups.push(threadItems);

    const prScore = Math.max(matchScore("pr description", query, 8), matchScore("description", query, 8), matchScore(row.title, query, 4));
    groups.push(prScore > 0 ? [scored({ kind: "pr", reviewId: row.id }, "PR description", row.title, "Info", prScore)] : []);

    const commitItems: ScoredItem[] = [];
    for (const c of parseJson<Review["commits"]>(row.commits_json, [])) {
      const s = Math.max(query.length >= 4 && c.sha.startsWith(query) ? 30 : 0, matchScore(c.title, query, 5), matchScore("commit", query, 2));
      if (s === 0) continue;
      commitItems.push(scored({ kind: "commit", reviewId: row.id, sha: c.sha }, `${c.sha.slice(0, 7)} ${c.title}`.slice(0, 80), `commit by ${c.author}`, "GitPullRequest", s));
    }
    groups.push(commitItems);

    // Browsing (empty query) shows a mix; a query ranks everything together.
    const caps = browsing ? [3, 8, 6, 4, 1, 3] : [5, 40, 40, 40, 1, 10];
    const items = groups.flatMap((group, i) => group.sort((a, b) => b.score - a.score).slice(0, caps[i]));
    if (!browsing) items.sort((a, b) => b.score - a.score);
    return items.slice(0, 24).map(({ score: _score, ...rest }) => rest);
  }

  async function mentionResolve(itemId: string): Promise<string> {
    const ref = decodeMentionRef(itemId);
    if (ref === null) throw new Error("unknown code pill");
    const row = requireReview(ref.reviewId);
    const prefix = `${row.owner}/${row.repo}#${row.number}`;
    const short = (sha: string) => sha.slice(0, 10);
    switch (ref.kind) {
      case "range": {
        const startLine = Math.min(ref.startLine, ref.endLine);
        const endLine = Math.max(ref.startLine, ref.endLine);
        return renderMentionRange({
          prefix,
          path: ref.path,
          startLine,
          endLine,
          side: ref.side === "old" ? `base ${short(row.base_sha)}` : `head ${short(row.head_sha)}`,
          excerpt: await excerpt(row, { path: ref.path, startLine, endLine, side: ref.side }),
        });
      }
      case "file": {
        const file = (await filesFor(row)).find((f) => f.path === ref.path) ?? null;
        const result = await host.call("git_patch", { worktree: row.worktree, baseSha: row.base_sha, headSha: row.head_sha, path: ref.path, oldPath: file?.oldPath ?? null }, hostOptions(row));
        const lines = result.patch.split("\n");
        const MAX = 400;
        const patch = lines.length > MAX
          ? [...lines.slice(0, MAX), `... ${lines.length - MAX} more diff lines. Ask about a range with path:start-end, or run: git diff ${row.base_sha} ${row.head_sha} -- ${ref.path}`].join("\n")
          : result.patch;
        return renderMentionFile({
          prefix,
          path: ref.path,
          file: file === null ? null : { status: file.status, additions: file.additions, deletions: file.deletions },
          base: short(row.base_sha),
          head: short(row.head_sha),
          patch,
        });
      }
      case "symbol": {
        const file = (await filesFor(row)).find((f) => f.path === ref.path);
        const shown = await host.call(
          "git_show",
          { worktree: row.worktree, sha: ref.side === "old" ? row.base_sha : row.head_sha, path: ref.side === "old" ? file?.oldPath ?? ref.path : ref.path },
          hostOptions(row),
        );
        const lines = (shown.content ?? "").split("\n");
        const start = Math.max(1, ref.startLine);
        const end = Math.min(lines.length, Math.max(start, ref.endLine));
        const MAX = 250;
        const slice = lines.slice(start - 1, Math.min(end, start - 1 + MAX));
        const width = String(end).length;
        const sym = changedSymbols(row).find((s) => s.path === ref.path && s.qualified === ref.qualified);
        return renderMentionSymbol({
          prefix,
          qualified: ref.qualified,
          symbol: sym === undefined ? null : { kind: sym.kind, status: sym.status, changedLines: sym.changedLines, fanIn: sym.fanIn },
          path: ref.path,
          start,
          end,
          side: ref.side === "old" ? `base ${short(row.base_sha)}` : `head ${short(row.head_sha)}`,
          body: slice.map((line, i) => `${String(start + i).padStart(width)}| ${line}`).join("\n"),
          truncated: end - start + 1 > MAX,
          max: MAX,
        });
      }
      case "thread": {
        const thread = cachedThreads(row).find((t) => t.id === ref.threadId);
        if (thread === undefined) throw new Error("that review thread is not cached; press Sync and try again");
        const line = thread.line ?? thread.originalLine;
        return renderMentionThread({
          prefix,
          path: thread.path,
          line,
          status: thread.isResolved ? "resolved" : "open",
          outdated: thread.isOutdated,
          side: thread.side === "LEFT" ? "base" : "head",
          comments: thread.comments.map((c) => ({ author: c.author, createdAt: c.createdAt, body: c.body.trim() })),
          excerpt: line === null ? null : await excerpt(row, { path: thread.path, startLine: line, endLine: line, side: thread.side === "LEFT" ? "old" : "new" }),
        });
      }
      case "pr":
        return renderMentionPr({
          prefix,
          title: row.title,
          author: row.author ?? "unknown",
          baseRef: row.base_ref,
          headRef: row.head_ref,
          state: row.state,
          body: row.body.trim() === "" ? "(no description)" : row.body.trim().slice(0, 12_000),
        });
      case "commit": {
        const range = await commitRange(row, ref.sha, undefined, false);
        const patches: { path: string; body: string; more: number }[] = [];
        let budget = 400;
        for (const f of range.files) {
          if (budget <= 0 || f.binary) break;
          const patch = await host.call("git_patch", { worktree: row.worktree, baseSha: range.base, headSha: range.head, path: f.path, oldPath: f.oldPath }, hostOptions(row));
          const lines = patch.patch.split("\n");
          const take = lines.slice(0, budget);
          patches.push({ path: f.path, body: take.join("\n"), more: Math.max(0, lines.length - take.length) });
          budget -= take.length;
        }
        return renderMentionCommit({
          prefix,
          sha: short(range.info.sha),
          fullSha: range.info.sha,
          author: range.info.author,
          date: range.info.date,
          title: range.info.title,
          body: range.info.body,
          files: range.files.map((f) => ({ status: f.status.padEnd(8), path: f.path, additions: f.additions, deletions: f.deletions })),
          fileCount: range.files.length,
          patches,
          truncated: budget <= 0,
        });
      }
      case "crange": {
        const startLine = Math.min(ref.startLine, ref.endLine);
        const endLine = Math.max(ref.startLine, ref.endLine);
        return renderMentionCrange({
          prefix,
          path: ref.path,
          startLine,
          endLine,
          sha: short(ref.sha),
          excerpt: await excerptAt(row, ref.sha, ref.path, startLine, endLine),
        });
      }
    }
  }

  bb.ui.registerMentionProvider({
    id: MENTION_PROVIDER_ID,
    label: "This PR",
    search: (ctx) => mentionSearch(ctx),
    resolve: async (itemId) => ({ context: await mentionResolve(itemId) }),
  });

  // -- helper thread: one-shot jobs in the PR worktree -----------------------
  //
  // A hidden thread per review that takes one job per message and answers
  // with a single fenced block. Used for the brief; kept separate from the
  // chat seats so the conversation stays the reviewer's.

  function helperIntro(row: ReviewRow): string {
    return renderHelperIntro({ pr: prPrompt(row) });
  }

  async function helperSend(row: ReviewRow, job: string, text: string): Promise<void> {
    const { providerId, model } = await configuredHelper();
    const existing = q.helper.get(row.id);
    if (existing !== undefined && ((existing.model ?? "") !== model || existing.provider_id !== providerId)) {
      await dropHelper(row.id);
    }
    const live = q.helper.get(row.id);
    if (live !== undefined) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: live.thread_id });
        if (thread.archivedAt === null && thread.deletedAt === null) {
          q.setHelperJob.run(job, row.id);
          await bb.sdk.threads.send({ threadId: live.thread_id, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
          return;
        }
      } catch {
        // stale helper; respawn below
      }
      q.deleteHelper.run(row.id);
    }
    const providers = await bb.sdk.providers.list();
    const provider = providers.find((p) => p.id === providerId);
    if (provider === undefined) throw new Error(`unknown provider ${providerId}`);
    const modes = provider.capabilities.permissionModes;
    const permissionMode = modes.includes("auto") ? "auto" : modes.includes("accept-edits") ? "accept-edits" : modes[0];
    const knownEnvironment = row.environment_id ?? q.seats.all(row.id).find((s) => s.environment_id !== null)?.environment_id ?? null;
    const now = Date.now();
    const thread = await bb.sdk.threads.spawn({
      projectId: await chatProjectId(row),
      environment: knownEnvironment !== null
        ? { type: "reuse", environmentId: knownEnvironment }
        : { type: "host", hostId: row.host_id, workspace: { type: "unmanaged", path: row.worktree } },
      providerId,
      ...(permissionMode ? { permissionMode } : {}),
      model,
      title: `Review Desk ${row.owner}/${row.repo}#${row.number}: helper`,
      visibility: hideSeatThreads ? "hidden" : "visible",
      input: [{ type: "text", text: helperIntro(row), mentions: [], visibility: "agent-only" }, { type: "text", text, mentions: [] }],
    });
    q.upsertHelper.run(row.id, thread.id, providerId, knownEnvironment, now, model);
    q.setHelperJob.run(job, row.id);
    if (knownEnvironment === null) {
      void (async () => {
        const environmentId = thread.environmentId ?? (await waitForEnvironment(thread.id));
        if (environmentId !== null) {
          q.setEnvironment.run(environmentId, row.id);
          q.upsertHelper.run(row.id, thread.id, providerId, environmentId, now, model);
        }
      })();
    }
  }

  function extractFenced(text: string, tag: string): string | null {
    const fenced = new RegExp("```" + tag + "[^\\n]*\\n([\\s\\S]*?)```", "i").exec(text) ?? /```json[^\n]*\n([\s\S]*?)```/i.exec(text);
    if (fenced !== null) return fenced[1];
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    return start !== -1 && end > start ? text.slice(start, end + 1) : null;
  }

  // -- brief: slop signals + plain-English summary ---------------------------

  const signalRuns = new Map<string, Promise<void>>();

  function briefState(row: ReviewRow): BriefState {
    const b = q.brief.get(row.id);
    const signalsCurrent = b !== undefined && b.head_sha === row.head_sha;
    const signalsStatus = signalRuns.has(row.id) ? "computing" : !signalsCurrent ? "missing" : b.signals_status === "ready" || b.signals_status === "failed" ? b.signals_status : "missing";
    const briefStatus = b === undefined ? "missing" : b.brief_status === "writing" || b.brief_status === "ready" || b.brief_status === "failed" ? b.brief_status : "missing";
    return {
      headSha: row.head_sha,
      signalsStatus,
      signals: signalsCurrent && b.signals_status === "ready" ? parseJson<Record<string, unknown> | null>(b.signals_json, null) : null,
      signalsError: signalsCurrent ? b.signals_error : null,
      briefStatus,
      brief: b?.brief_status === "ready" ? parseJson<Record<string, unknown> | null>(b.brief_json, null) : null,
      briefError: b?.brief_error ?? null,
      stale: b?.brief_status === "ready" && b.brief_head_sha !== row.head_sha,
      updatedAt: b?.updated_at ?? null,
      helperModel: helperModelNow,
      helperModels: helperModelsNow,
    };
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

  function startSignals(row: ReviewRow): Promise<void> {
    const inflight = signalRuns.get(row.id);
    if (inflight !== undefined) return inflight;
    q.ensureBrief.run(row.id, row.head_sha, Date.now());
    publish(row.id, "brief");
    const work = (async () => {
      try {
        const files = (await filesFor(row)).filter((f) => !f.binary && f.additions + f.deletions > 0);
        const patches = new Map<string, string>();
        await mapLimit(files, 8, async (f) => {
          const result = await host.call("git_patch", { worktree: row.worktree, baseSha: row.base_sha, headSha: row.head_sha, path: f.path, oldPath: f.oldPath }, hostOptions(row));
          patches.set(f.path, result.patch);
        });
        const codemap = codemapState(row);
        const moduleOf = codemap.status === "ready" && codemap.codemap !== null ? new Map(codemap.codemap.files.map((f) => [f.path, f.module])) : null;
        const report = computeSlop({ files: await filesFor(row), patches, title: row.title, body: row.body, moduleOf });
        q.setSignals.run(row.head_sha, "ready", JSON.stringify(report), null, Date.now(), row.id);
      } catch (cause) {
        q.setSignals.run(row.head_sha, "failed", null, errorMessage(cause), Date.now(), row.id);
      } finally {
        signalRuns.delete(row.id);
        publish(row.id, "brief");
      }
    })();
    signalRuns.set(row.id, work);
    return work;
  }

  async function briefPrompt(row: ReviewRow): Promise<string> {
    const files = await filesFor(row);
    const report = briefState(row).signals as unknown as SlopReport | null;
    return renderBrief({
      fence: BRIEF_FENCE,
      score: report?.score ?? "n/a",
      pr: prPrompt(row),
      description: row.body.trim() === "" ? "(none)" : row.body.trim().slice(0, 8000),
      stack: stackPrompt(row),
      signals: signalsPrompt(report),
      ...filesPrompt(files),
      codemap: codemapPrompt(row),
    });
  }

  const rawBriefSchema = z.object({
    summary: z.string().optional(),
    areas: z.array(z.object({ module: z.coerce.string(), what: z.string().optional(), path: z.string().nullable().optional() })).optional(),
    claims: z.array(z.object({ claim: z.string(), verdict: z.string().optional(), evidence: z.array(z.object({ path: z.string(), line: z.coerce.number().nullable().optional() })).optional(), note: z.string().nullable().optional() })).optional(),
    ai: z.object({ score: z.coerce.number().optional(), reasons: z.array(z.object({ reason: z.string(), evidence: z.array(z.object({ path: z.string(), line: z.coerce.number().nullable().optional() })).optional() })).optional() }).optional(),
  });

  function normalizeBrief(raw: unknown, files: ChangedFile[]): Brief {
    const parsed = rawBriefSchema.parse(raw);
    const paths = new Set(files.map((f) => f.path));
    const resolvePath = (p: string): string | null => {
      const clean = p.trim().replace(/^\.\//, "");
      if (paths.has(clean)) return clean;
      return files.find((f) => f.path.endsWith(`/${clean}`))?.path ?? null;
    };
    const evidence = (list: { path: string; line?: number | null }[] | undefined): BriefEvidence[] =>
      (list ?? []).slice(0, 6).map((e) => {
        const resolved = resolvePath(e.path);
        return { path: resolved ?? e.path, line: typeof e.line === "number" && e.line > 0 ? Math.round(e.line) : null, found: resolved !== null };
      });
    const verdicts = new Set(["matches", "partly", "no-evidence", "contradicted"]);
    return {
      summary: (parsed.summary ?? "").trim(),
      areas: (parsed.areas ?? []).slice(0, 8).map((a) => ({ module: a.module, what: (a.what ?? "").trim(), path: a.path ? resolvePath(a.path) : null })),
      claims: (parsed.claims ?? []).slice(0, 12).map((c) => ({
        claim: c.claim.trim(),
        verdict: (verdicts.has((c.verdict ?? "").toLowerCase()) ? (c.verdict ?? "").toLowerCase() : "no-evidence") as Brief["claims"][number]["verdict"],
        evidence: evidence(c.evidence),
        note: (c.note ?? "").trim(),
      })),
      ai: {
        score: Math.max(0, Math.min(100, Math.round(parsed.ai?.score ?? 0))),
        reasons: (parsed.ai?.reasons ?? []).slice(0, 4).map((r) => ({ reason: r.reason.trim(), evidence: evidence(r.evidence) })),
      },
    };
  }

  async function writeBrief(row: ReviewRow): Promise<void> {
    q.ensureBrief.run(row.id, row.head_sha, Date.now());
    const current = q.brief.get(row.id);
    if (current?.brief_status === "writing") return;
    q.setBrief.run("writing", row.head_sha, null, null, null, Date.now(), row.id);
    publish(row.id, "brief");
    try {
      await helperSend(row, "brief", await briefPrompt(row));
    } catch (cause) {
      q.setBrief.run("failed", row.head_sha, null, null, errorMessage(cause), Date.now(), row.id);
      publish(row.id, "brief");
    }
  }

  async function completeBrief(reviewId: string, text: string | null, error: string | null): Promise<void> {
    const row = q.review.get(reviewId);
    const current = q.brief.get(reviewId);
    if (row === undefined || current === undefined || current.brief_status !== "writing") return;
    if (error !== null || text === null) {
      q.setBrief.run("failed", current.brief_head_sha, null, text, error ?? "the helper returned nothing", Date.now(), reviewId);
    } else {
      try {
        const json = extractFenced(text, BRIEF_FENCE);
        if (json === null) throw new Error(`no ${BRIEF_FENCE} block in the reply`);
        const brief = normalizeBrief(JSON.parse(json), await filesFor(row));
        if (brief.summary === "") throw new Error("the brief has no summary");
        q.setBrief.run("ready", current.brief_head_sha, JSON.stringify(brief), text, null, Date.now(), reviewId);
      } catch (cause) {
        q.setBrief.run("failed", current.brief_head_sha, null, text, `could not read the brief: ${errorMessage(cause)}`, Date.now(), reviewId);
      }
    }
    publish(reviewId, "brief");
  }

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    const helper = q.helperByThread.get(thread.id);
    if (helper === undefined) return;
    q.setHelperJob.run(null, helper.review_id);
    if (helper.job === "brief") void completeBrief(helper.review_id, lastAssistantText, null);
    if (helper.job === "notes") void completeNotes(helper.review_id, lastAssistantText, null);
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    const helper = q.helperByThread.get(thread.id);
    if (helper === undefined) return;
    q.setHelperJob.run(null, helper.review_id);
    if (helper.job === "brief") void completeBrief(helper.review_id, null, error ?? "the helper thread failed");
    if (helper.job === "notes") void completeNotes(helper.review_id, null, error ?? "the helper thread failed");
  });

  // -- private notes ----------------------------------------------------------
  //
  // Notes live only in this plugin until promoted to a pending comment. They
  // come from slop signals (per signal, on request), from the helper's
  // "find slop and cleanups" job, or from the reviewer marking a comment
  // private. Each carries a content hash of its line so it follows pushes.

  const NOTES_FENCE = "review-notes";

  async function fileLines(row: ReviewRow, path: string, side: "LEFT" | "RIGHT", cache: Map<string, string[] | null>): Promise<string[] | null> {
    const key = `${side}:${path}`;
    if (!cache.has(key)) {
      const shown = await host.call("git_show", { worktree: row.worktree, sha: side === "LEFT" ? row.base_sha : row.head_sha, path }, hostOptions(row)).catch(() => ({ content: null }));
      cache.set(key, shown.content === null ? null : shown.content.split("\n"));
    }
    return cache.get(key) ?? null;
  }

  interface NoteInput { path: string; line: number; startLine: number | null; side: "LEFT" | "RIGHT"; kind: Note["kind"]; severity: Note["severity"]; title: string; body: string; suggestion: string | null; source: Note["source"]; signalId: string | null }

  async function insertNotes(row: ReviewRow, inputs: NoteInput[]): Promise<Note[]> {
    const cache = new Map<string, string[] | null>();
    const existing = q.notes.all(row.id);
    const out: Note[] = [];
    const now = Date.now();
    for (const n of inputs) {
      // Same place and title means the same note; do not stack duplicates.
      if (existing.some((e) => e.path === n.path && e.line === n.line && e.title === n.title && e.state !== "dismissed")) continue;
      const lines = await fileLines(row, n.path, n.side, cache);
      if (lines !== null && n.line > lines.length) continue;
      const anchor = lines === null ? null : anchorHash(lines[n.line - 1] ?? "");
      const id = newId();
      q.insertNote.run(id, row.id, row.head_sha, n.path, n.line, n.startLine, n.side, n.kind, n.severity, n.title, n.body, n.suggestion, n.source, n.signalId, anchor, now, now);
      const inserted = q.noteById.get(id);
      if (inserted !== undefined) out.push(toNote(inserted));
    }
    return out;
  }

  const SIGNAL_TITLES: Record<string, string> = {
    "ai-phrasing": "AI phrasing in a comment",
    "restating-comments": "Comment repeats the code",
    "defensive-noise": "Defensive noise",
    "tests-weakened": "Test weakened",
    stubs: "Stub or deferral",
    "commented-code": "Commented-out code",
    duplication: "Duplicated block",
    scope: "Outside the stated scope",
    description: "Description shape",
    "over-commenting": "Over-commented",
  };

  async function notesFromSignal(row: ReviewRow, signalId: string, show: boolean): Promise<number> {
    if (!show) {
      const before = q.notesBySignal.all(row.id, signalId).length;
      q.deleteSignalNotes.run(row.id, signalId);
      publish(row.id, "notes");
      return before;
    }
    const report = briefState(row).signals as unknown as SlopReport | null;
    const signal = report?.signals.find((s) => s.id === signalId);
    if (signal === undefined) throw new Error("that signal is not in the current report; recompute first");
    const kind: Note["kind"] = signalId === "tests-weakened" || signalId === "defensive-noise" || signalId === "stubs" ? "risk" : signalId === "scope" ? "question" : "slop";
    const severity: Note["severity"] = signalId === "tests-weakened" ? "high" : signalId === "stubs" || signalId === "defensive-noise" || signalId === "duplication" ? "medium" : "low";
    const inputs: NoteInput[] = signal.evidence
      .filter((e) => e.path !== "" && e.line !== null)
      .map((e) => ({ path: e.path, line: e.line ?? 1, startLine: null, side: e.side === "old" ? "LEFT" : "RIGHT", kind, severity, title: SIGNAL_TITLES[signalId] ?? signal.label, body: `${e.note}\n\n${signal.description}`, suggestion: null, source: "signal", signalId }));
    const added = await insertNotes(row, inputs);
    publish(row.id, "notes");
    return added.length;
  }

  async function notesPrompt(row: ReviewRow): Promise<string> {
    const files = await filesFor(row);
    const report = briefState(row).signals as unknown as SlopReport | null;
    return renderNotes({
      fence: NOTES_FENCE,
      pr: { title: row.title },
      signals: signalsPrompt(report),
      ...filesPrompt(files),
      threads: cachedThreads(row).filter((t) => !t.isResolved).slice(0, 80).map((t) => ({
        path: t.path,
        line: t.line ?? t.originalLine ?? "?",
        author: t.comments[0]?.author ?? "",
        preview: (t.comments[0]?.body ?? "").split("\n")[0].slice(0, 90),
      })),
    });
  }

  const rawNotesSchema = z.array(z.object({
    path: z.string(),
    line: z.coerce.number(),
    endLine: z.coerce.number().nullable().optional(),
    kind: z.string().optional(),
    severity: z.string().optional(),
    title: z.string(),
    body: z.string().optional(),
    suggestion: z.string().nullable().optional(),
  }));

  async function findNotes(row: ReviewRow): Promise<void> {
    if (q.helper.get(row.id)?.job !== null && q.helper.get(row.id)?.job !== undefined) throw new Error("the helper is busy; wait for the current job to finish");
    notesErrors.delete(row.id);
    await helperSend(row, "notes", await notesPrompt(row));
    publish(row.id, "notes");
  }

  async function completeNotes(reviewId: string, text: string | null, error: string | null): Promise<void> {
    const row = q.review.get(reviewId);
    if (row === undefined) return;
    try {
      if (error !== null || text === null) throw new Error(error ?? "the helper returned nothing");
      const json = extractFenced(text, NOTES_FENCE) ?? (text.includes("[") ? text.slice(text.indexOf("["), text.lastIndexOf("]") + 1) : null);
      if (json === null) throw new Error(`no ${NOTES_FENCE} block in the reply`);
      const parsed = rawNotesSchema.parse(JSON.parse(json));
      const files = await filesFor(row);
      const paths = new Set(files.map((f) => f.path));
      const inputs: NoteInput[] = [];
      for (const n of parsed.slice(0, 25)) {
        const clean = n.path.trim().replace(/^\.\//, "");
        const path = paths.has(clean) ? clean : files.find((f) => f.path.endsWith(`/${clean}`))?.path;
        if (path === undefined || !(n.line > 0)) continue;
        const end = typeof n.endLine === "number" && n.endLine > n.line ? Math.round(n.endLine) : null;
        inputs.push({
          path,
          line: end ?? Math.round(n.line),
          startLine: end === null ? null : Math.round(n.line),
          side: "RIGHT",
          kind: (NOTE_KINDS as readonly string[]).includes(n.kind ?? "") ? (n.kind as Note["kind"]) : "cleanup",
          severity: (NOTE_SEVERITIES as readonly string[]).includes(n.severity ?? "") ? (n.severity as Note["severity"]) : "low",
          title: n.title.trim().slice(0, 140),
          body: (n.body ?? "").trim(),
          suggestion: n.suggestion ? n.suggestion.replace(/^```\w*\n?|```$/g, "").trimEnd() : null,
          source: "helper",
          signalId: null,
        });
      }
      const added = await insertNotes(row, inputs);
      if (added.length === 0 && inputs.length === 0) notesErrors.set(reviewId, "the helper found nothing it could anchor to the diff");
    } catch (cause) {
      notesErrors.set(reviewId, errorMessage(cause));
    }
    publish(reviewId, "notes");
  }

  function noteToComment(note: NoteRow): string {
    const parts = [note.title.trim() === "" ? note.body.trim() : `**${note.title.trim()}**\n\n${note.body.trim()}`];
    if (note.suggestion !== null && note.suggestion.trim() !== "") parts.push("```suggestion\n" + note.suggestion.replace(/\n$/, "") + "\n```");
    return parts.join("\n\n").trim();
  }

  /** Signals compute on first call for a head. The helper brief runs once when autoBrief is on, or on an explicit refresh (signals + brief together). GitHub sync does not rewrite it. */
  function briefGet(row: ReviewRow, refresh: boolean): BriefState {
    if (refresh) {
      void startSignals(row).then(() => writeBrief(row));
      return briefState(row);
    }
    const state = briefState(row);
    if (state.signalsStatus === "missing") void startSignals(row);
    if (autoBrief && state.briefStatus === "missing") void startSignals(row).then(() => writeBrief(row));
    return briefState(row);
  }

  // -- GitHub write paths ----------------------------------------------------

  async function submitReview(reviewId: string, event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string): Promise<{ url: string | null; posted: number; dropped: number }> {
    const row = requireReview(reviewId);
    const pending = await pendingFor(row, await filesFor(row));
    const live = pending.filter((p) => !p.stale);
    if (live.length === 0 && body.trim() === "") {
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
    q.clearPending.run(row.id);
    await refreshThreads(row).catch(() => undefined);
    publish(row.id, "pending");
    return { url: result.url, posted: live.length, dropped: pending.length - live.length };
  }

  // -- Roundtable bridge over loopback --------------------------------------

  async function roundtableRpc<T>(method: string, input: unknown): Promise<T> {
    const response = await fetch(`${bb.server.loopbackBaseUrl}/api/v1/plugins/roundtable/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = (await response.json()) as { ok: boolean; result?: T; error?: { message?: string } };
    if (!payload.ok) throw new Error(payload.error?.message ?? `roundtable ${method} failed`);
    return payload.result as T;
  }

  // -- RPC -------------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    reviews_list: () => {
      const rows = q.reviews.all().filter((row) => prIsOpen(row.state));
      discoverStacks(rows);
      return {
        reviews: rows.map((row) => ({
          id: row.id,
          owner: row.owner,
          repo: row.repo,
          number: row.number,
          title: row.title,
          state: row.state,
          isDraft: row.is_draft === 1,
          headSha: row.head_sha,
          pendingCount: q.pending.all(row.id).length,
          updatedAt: row.updated_at,
          stack: stackSummaryFor(row),
        })),
      };
    },
    reviews_open: async ({ ref }) => ({ review: await openReview(ref) }),
    reviews_get: ({ reviewId }) => reviewDetail(reviewId),
    reviews_sync: ({ reviewId }) => syncReview(reviewId, true),
    reviews_remove: async ({ reviewId }) => {
      await dropReview(requireReview(reviewId), { dismiss: true, reason: "removed" });
      return { ok: true as const };
    },
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
        return { ...parseJson<{ comments: []; reviews: [] }>(cache.json, { comments: [], reviews: [] }), fetchedAt: cache.fetched_at };
      }
      const result = await host.call("gh_conversation", { owner: row.owner, repo: row.repo, number: row.number }, hostOptions(row));
      q.setConversationCache.run(row.id, JSON.stringify(result), Date.now());
      return { ...result, fetchedAt: Date.now() };
    },
    review_threads_refresh: async ({ reviewId }) => ({ threads: await refreshThreads(requireReview(reviewId)) }),
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
    chat_send: async ({ reviewId, providerId, model, text, selection }) => ({ seat: await chatSend(reviewId, providerId, model ?? null, text, selection ?? null) }),
    chat_start: async ({ reviewId, providerId, model, reasoningLevel, permissionMode, serviceTier, executionInputSources, input }) => {
      const row = requireReview(reviewId);
      // The composer already validated these against the provider catalog; the
      // SDK types are stricter than our wire schema, so narrow here.
      const execution = {
        ...(model === undefined ? {} : { model }),
        ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
        ...(permissionMode === undefined ? {} : { permissionMode }),
        ...(serviceTier === undefined ? {} : { serviceTier }),
        ...(executionInputSources === undefined ? {} : { executionInputSources }),
      } as SpawnExecution;
      return { seat: await deliver(row, providerId, execution, input as unknown as PromptBlocks) };
    },
    seat_lookup: ({ threadId }) => {
      const seat = q.seatByThread.get(threadId);
      return { seat: seat === undefined ? null : { reviewId: seat.review_id, providerId: seat.provider_id } };
    },
    chat_reset: async ({ reviewId, providerId }) => {
      await chatReset(reviewId, providerId);
      return { ok: true as const };
    },
    codemap_get: ({ reviewId, refresh }) => {
      const row = requireReview(reviewId);
      const state = codemapState(row);
      if (refresh || state.status === "missing") startCodemap(row);
      return codemapState(row);
    },
    brief_get: ({ reviewId, refresh }) => briefGet(requireReview(reviewId), refresh === true),
    brief_write: async ({ reviewId }) => {
      const row = requireReview(reviewId);
      await startSignals(row);
      await writeBrief(row);
      return briefState(row);
    },
    helper_set_model: async ({ model }) => {
      await settings.experimental_set({ helperModel: model });
      helperModelNow = model;
      return { model };
    },
    notes_from_signal: async ({ reviewId, signalId, show }) => ({ count: await notesFromSignal(requireReview(reviewId), signalId, show) }),
    notes_find: async ({ reviewId }) => {
      await findNotes(requireReview(reviewId));
      return { ok: true as const };
    },
    note_add: async ({ reviewId, path, line, startLine, side, body, kind }) => {
      const row = requireReview(reviewId);
      const [note] = await insertNotes(row, [{ path, line, startLine: startLine ?? null, side, kind: kind ?? "question", severity: "medium", title: "", body, suggestion: null, source: "me", signalId: null }]);
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
      q.insertPending.run(pendingId, note.review_id, note.path, note.line, note.start_line, note.side === "LEFT" ? "LEFT" : "RIGHT", noteToComment(note), Date.now());
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
    notes_clear: ({ reviewId, source, dismissedOnly, staleOnly }) => {
      requireReview(reviewId);
      const before = q.notes.all(reviewId).length;
      if (dismissedOnly) q.deleteDismissedNotes.run(reviewId);
      else if (staleOnly) q.deleteStaleNotes.run(reviewId);
      else if (source !== undefined) q.deleteNotesBySource.run(reviewId, source);
      else q.deleteAllNotes.run(reviewId);
      publish(reviewId, "notes");
      return { removed: before - q.notes.all(reviewId).length };
    },
    rooms_list: async () => {
      try {
        const result = await roundtableRpc<{ rooms: { id: string; title: string; handles: string[] }[] }>("rooms_list", null);
        return { rooms: result.rooms.map((r) => ({ id: r.id, title: r.title, handles: r.handles })), available: true };
      } catch {
        return { rooms: [], available: false };
      }
    },
    send_to_room: async ({ roomId, text, tags, turns }) => {
      await roundtableRpc("rooms_post", { roomId, text, tags, ...(turns === undefined ? {} : { turns }) });
      return { ok: true as const };
    },
    context_providers: async () => {
      const providers = await bb.sdk.providers.list();
      const options = await Promise.all(
        providers.map(async (provider) => {
          let models: ProviderOption["models"] = [];
          if (provider.available) {
            try {
              const result = await bb.sdk.providers.models({ providerId: provider.id });
              models = result.models.filter((m) => (m.routeProviderId ?? provider.id) === provider.id).map((m) => ({ model: m.model, displayName: m.displayName, isDefault: m.isDefault }));
            } catch {
              models = [];
            }
          }
          return { id: provider.id, displayName: provider.displayName, available: provider.available, models };
        }),
      );
      options.sort((a, b) => Number(b.id === defaultProvider) - Number(a.id === defaultProvider));
      return { providers: options, defaultProvider };
    },
  });

  // -- CLI -------------------------------------------------------------------

  bb.cli.register({
    name: "review-desk",
    summary: "Open GitHub pull requests in Review Desk and chat with the PR analyst",
    commands: [
      { name: "open", summary: "Open or refresh a PR review", usage: "bb review-desk open <url | owner/repo#N | owner/repo/stack/N>" },
      { name: "list", summary: "List reviews", usage: "bb review-desk list [--json]" },
      { name: "ask", summary: "Send a message to the PR analyst", usage: "bb review-desk ask <reviewId> <text...> [--provider <id>]" },
      { name: "codemap", summary: "Build or print the codemap", usage: "bb review-desk codemap <reviewId> [--json]" },
      { name: "stack", summary: "Print the GitHub stack for a review", usage: "bb review-desk stack <reviewId> [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((a) => a !== "--json");
      const flag = (name: string) => {
        const i = args.indexOf(`--${name}`);
        return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
      };
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
          case "ask": {
            const [reviewId, ...words] = rest;
            const text = words.join(" ").trim();
            if (!reviewId || text === "") return { exitCode: 1, stderr: "usage: bb review-desk ask <reviewId> <text...> [--provider <id>]" };
            const seat = await chatSend(reviewId, flag("provider") ?? defaultProvider, null, text, null);
            return ok(seat, `Sent to ${seat.providerId} analyst thread ${seat.threadId}`);
          }
          case "codemap": {
            const row = requireReview(rest[0] ?? "");
            let state = codemapState(row);
            if (state.status === "missing" || state.status === "failed") startCodemap(row);
            state = codemapState(row);
            if (state.status !== "ready" || state.codemap === null) return ok(state, `Codemap ${state.status}${state.error ? `: ${state.error}` : ""}. Run again in a moment.`);
            const c = state.codemap;
            const text = [
              `Codemap (${c.engine}) for ${c.headSha.slice(0, 10)}: ${c.stats.files} files, ${c.stats.symbols} symbols (+${c.stats.added} ~${c.stats.modified} -${c.stats.removed})`,
              "Reading order:",
              ...c.readingOrder.map((m, i) => `  ${i + 1}. ${m.module}  (${m.paths.length} files) ${m.reason}`),
              "Hotspots:",
              ...c.hotspots.slice(0, 10).map((h) => `  ${h.score}  ${h.path}#${h.qualified}  (${h.changedLines} lines, fan-in ${h.fanIn})`),
            ].join("\n");
            return ok(c, text);
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
            return { exitCode: 1, stderr: "usage: bb review-desk open|list|ask|codemap|stack" };
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
        await sleep(Math.max(0, SYNC_EVERY_MS - (Date.now() - started)), signal);
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
  bb.log.info("loaded");
}
