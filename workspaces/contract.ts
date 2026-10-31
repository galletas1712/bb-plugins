import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { isRepoSpec } from "./repo-spec.js";

/** One path segment that is never hidden: repo folder names and workspace keys. */
export const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export const repoNameSchema = z.string().regex(SAFE_NAME);

export const repoSpecSchema = z
  .string()
  .refine(isRepoSpec, "Use <repo> or <repo>@<start>, where a start is a branch, remote/branch, tag, full commit id, or #pr.");

export const repoEntrySchema = z
  .object({ name: repoNameSchema, from: z.string().min(1).nullable() })
  .strict();

/** What the new-thread composer submits for this provider. No repos makes an empty workspace. */
export const inputsSchema = z.object({ repos: z.array(repoSpecSchema) }).strict();

/** Uncommitted changes against HEAD, or the branch's commits since it left its base. */
export const modeSchema = z.enum(["working", "branch"]);
export type Mode = z.infer<typeof modeSchema>;

export const repoChangesSchema = z
  .object({
    name: z.string().min(1),
    branch: z.string().nullable(),
    /** The ref branch mode compares against, such as `upstream/main`. */
    base: z.string().nullable(),
    files: z.array(
      z
        .object({
          path: z.string().min(1),
          oldPath: z.string().min(1).nullable(),
          status: z.enum(["M", "A", "D", "R", "U", "?"]),
        })
        .strict(),
    ),
    /** More files changed than were listed. */
    truncated: z.boolean(),
    error: z.string().nullable(),
  })
  .strict();
export type RepoChanges = z.infer<typeof repoChangesSchema>;

const fileRequest = {
  repo: z.string().min(1),
  path: z.string().min(1),
  oldPath: z.string().min(1).nullable(),
  mode: modeSchema,
  untracked: z.boolean(),
};

/** What the Changes panel shows for a thread. */
const changesResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), repos: z.array(repoChangesSchema) }).strict(),
  z.object({ status: z.literal("unavailable"), reason: z.string().min(1) }).strict(),
]);
export type ChangesResult = z.infer<typeof changesResultSchema>;

/** A file's patch, or null when it is too large to show. */
const patchSchema = z.object({ patch: z.string().nullable() }).strict();

export const hostContract = defineRpcContract({
  /** Names of the main clones the project offers: the project folder itself, or its direct children. */
  scan: {
    input: z.object({ projectPath: z.string().min(1) }).strict(),
    output: z.object({ repos: z.array(repoNameSchema) }).strict(),
  },
  /** A new branch name from bb's suggested one, unused in every repo the project offers. */
  branch: {
    input: z.object({ projectPath: z.string().min(1), suggested: z.string().min(1) }).strict(),
    output: z.object({ branch: z.string().min(1) }).strict(),
  },
  /**
   * Makes the workspace folder hold a worktree of every listed repo on
   * `branch`, creating only the missing ones, then rewrites the agent
   * instructions. Safe to repeat.
   */
  ensure: {
    input: z
      .object({
        pathKey: z.string().min(1),
        projectPath: z.string().min(1),
        branch: z.string().min(1),
        repos: z.array(repoEntrySchema),
      })
      .strict(),
    output: z
      .object({ path: z.string().min(1), created: z.array(repoNameSchema) })
      .strict(),
  },
  /** Deletes every worktree, uncommitted work included, then the folder. Branches stay. */
  remove: {
    input: z.object({ pathKey: z.string().min(1) }).strict(),
    output: z.object({}).strict(),
  },
  /** Changes in each repo under `root`, or in `root` itself when it is a repo. */
  changes: {
    input: z.object({ root: z.string().min(1), mode: modeSchema }).strict(),
    output: z.object({ repos: z.array(repoChangesSchema) }).strict(),
  },
  diff: {
    input: z.object({ root: z.string().min(1), ...fileRequest }).strict(),
    output: patchSchema,
  },
});

export const rpcContract = defineRpcContract({
  listRepos: {
    input: z
      .object({ projectId: z.string().min(1), hostId: z.string().min(1) })
      .strict(),
    output: z.object({ repos: z.array(repoNameSchema), previous: z.array(repoSpecSchema).nullable() }).strict(),
  },
  changes: {
    input: z.object({ threadId: z.string().min(1), mode: modeSchema }).strict(),
    output: changesResultSchema,
  },
  diff: {
    input: z.object({ threadId: z.string().min(1), ...fileRequest }).strict(),
    output: patchSchema,
  },
});
