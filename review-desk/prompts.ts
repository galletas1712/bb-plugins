// Jinja (Nunjucks) prompt templates next to this file in prompts/.
// HTML escaping is off: these strings go to models, not the DOM.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import nunjucks from "nunjucks";

export interface PrPrompt {
  owner: string;
  repo: string;
  number: number;
  title: string;
  headSha: string;
  baseSha: string;
  baseRef: string;
}

export interface StackPrompt {
  label: string;
  position: number | string;
  size: number;
  baseRefName: string;
  entries: {
    position: number;
    number: number;
    state: string;
    merged: boolean;
    isDraft: boolean;
    title: string;
    additions: number;
    deletions: number;
    current: boolean;
  }[];
}

export interface SignalsPrompt {
  items: { label: string; count: number; evidence: string }[];
}

export interface FilePrompt {
  status: string;
  path: string;
  additions: number;
  deletions: number;
}

export interface CodemapPrompt {
  readingOrder: { module: string; pathCount: number; reason: string }[];
  hotspots: { path: string; qualified: string; changedLines: number; fanIn: number }[];
  symbols: { status: string; kind: string; qualified: string; loc: string }[];
}

const here = dirname(fileURLToPath(import.meta.url));
const dir = [join(here, "prompts"), join(here, "..", "prompts")].find((p) => existsSync(p));
if (dir === undefined) throw new Error("review-desk prompts/ directory is missing");

const env = nunjucks.configure(dir, { autoescape: false, throwOnUndefined: true });

function render(name: string, ctx: Record<string, unknown>): string {
  return env.render(name, ctx).replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trimEnd();
}

export function renderAnalystIntro(ctx: { pr: PrPrompt; stack: StackPrompt | null; description: string }): string {
  return render("analyst-intro.jinja", ctx);
}

export function renderHelperIntro(ctx: { pr: PrPrompt }): string {
  return render("helper-intro.jinja", ctx);
}

export function renderBrief(ctx: {
  fence: string;
  score: string | number;
  pr: PrPrompt;
  description: string;
  stack: StackPrompt | null;
  signals: SignalsPrompt | null;
  files: FilePrompt[];
  fileCount: number;
  filesMore: number;
  codemap: CodemapPrompt | null;
}): string {
  return render("brief.jinja", ctx);
}

export function renderNotes(ctx: {
  fence: string;
  pr: Pick<PrPrompt, "title">;
  signals: SignalsPrompt | null;
  files: FilePrompt[];
  fileCount: number;
  filesMore: number;
  threads: { path: string; line: string | number; author: string; preview: string }[];
}): string {
  return render("notes.jinja", ctx);
}

export function renderChatSelection(ctx: { path: string; start: number; end: number; side: string; excerpt: string; text: string }): string {
  return render("chat-selection.jinja", ctx);
}

export function renderMentionRange(ctx: { prefix: string; path: string; startLine: number; endLine: number; side: string; excerpt: string }): string {
  return render("mentions/range.jinja", ctx);
}

export function renderMentionFile(ctx: {
  prefix: string;
  path: string;
  file: { status: string; additions: number; deletions: number } | null;
  base: string;
  head: string;
  patch: string;
}): string {
  return render("mentions/file.jinja", ctx);
}

export function renderMentionSymbol(ctx: {
  prefix: string;
  qualified: string;
  symbol: { kind: string; status: string; changedLines: number; fanIn: number } | null;
  path: string;
  start: number;
  end: number;
  side: string;
  body: string;
  truncated: boolean;
  max: number;
}): string {
  return render("mentions/symbol.jinja", ctx);
}

export function renderMentionThread(ctx: {
  prefix: string;
  path: string;
  line: number | null;
  status: string;
  outdated: boolean;
  side: string;
  comments: { author: string; createdAt: string; body: string }[];
  excerpt: string | null;
}): string {
  return render("mentions/thread.jinja", ctx);
}

export function renderMentionPr(ctx: {
  prefix: string;
  title: string;
  author: string;
  baseRef: string;
  headRef: string;
  state: string;
  body: string;
}): string {
  return render("mentions/pr.jinja", ctx);
}

export function renderMentionCommit(ctx: {
  prefix: string;
  sha: string;
  fullSha: string;
  author: string;
  date: string;
  title: string;
  body: string;
  files: FilePrompt[];
  fileCount: number;
  patches: { path: string; body: string; more: number }[];
  truncated: boolean;
}): string {
  return render("mentions/commit.jinja", ctx);
}

export function renderMentionCrange(ctx: { prefix: string; path: string; startLine: number; endLine: number; sha: string; excerpt: string }): string {
  return render("mentions/crange.jinja", ctx);
}
