// Decides whether one thread's title still fits its conversation, and applies
// the new title when asked. A title changed by anyone else since the last check
// counts as a manual rename and stops automatic retitling for that thread.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Complete } from "./claude";
import { buildTitlePrompt, parseTitleReply } from "./prompt";

export interface RetitleDeps {
  sdk: Pick<BbPluginApi["sdk"], "threads">;
  pluginId: string;
  complete: Complete;
}

export interface RetitleOptions {
  /** Write the new title. Off for dry runs. */
  apply: boolean;
  /** Ignore and clear a manual-rename lock. For explicit user requests only. */
  force?: boolean;
  signal?: AbortSignal;
}

export type RetitleOutcome =
  | { kind: "renamed"; from: string | null; to: string; costUsd: number | null; durationMs: number }
  | { kind: "proposed"; from: string | null; to: string; costUsd: number | null; durationMs: number }
  | { kind: "kept"; title: string | null; costUsd: number | null; durationMs: number }
  | { kind: "skipped"; reason: SkipReason };

export type SkipReason = "archived" | "hidden" | "handoff" | "locked" | "renamed-by-user" | "empty" | "changed-during-check";

/** Per-thread plugin metadata. `lastTitle` is the title as of our last check. */
interface RetitleMetadata {
  lastTitle?: string | null;
  locked?: boolean;
}

export async function retitle(
  deps: RetitleDeps,
  threadId: string,
  options: RetitleOptions,
): Promise<RetitleOutcome> {
  const { sdk, pluginId, complete } = deps;
  const { signal } = options;
  const thread = await sdk.threads.get({ threadId, signal });
  if (thread.archivedAt !== null || thread.deletedAt !== null) return skipped("archived");
  if (thread.visibility === "hidden") return skipped("hidden");
  if (isLiveHandoff(thread)) return skipped("handoff");

  const metadata = (await sdk.threads.getPluginMetadata({ threadId, pluginId, signal })) as RetitleMetadata;
  if (!options.force) {
    if (metadata.locked) return skipped("locked");
    // A null lastTitle means bb's own first-message title landed after our
    // last check. Only a change away from a title we saw is a manual rename.
    if (typeof metadata.lastTitle === "string" && metadata.lastTitle !== thread.title) {
      if (options.apply) await saveMetadata(deps, threadId, { locked: true, lastTitle: thread.title });
      return skipped("renamed-by-user");
    }
  }

  const { items } = await sdk.threads.conversationOutline({ threadId, signal });
  const prompt = buildTitlePrompt(thread.title, items);
  if (prompt === null) return skipped("empty");

  const completion = await complete(prompt, signal);
  const proposal = parseTitleReply(completion.text);
  const usage = { costUsd: completion.costUsd, durationMs: completion.durationMs };
  const changed = proposal !== null && proposal !== thread.title;

  if (!options.apply) {
    return changed
      ? { kind: "proposed", from: thread.title, to: proposal, ...usage }
      : { kind: "kept", title: thread.title, ...usage };
  }
  if (!changed) {
    await saveMetadata(deps, threadId, { locked: false, lastTitle: thread.title });
    return { kind: "kept", title: thread.title, ...usage };
  }

  // The model call takes seconds. Do not overwrite a title set meanwhile.
  const latest = await sdk.threads.get({ threadId, signal });
  if (latest.title !== thread.title) return skipped("changed-during-check");
  await sdk.threads.update({ threadId, title: proposal });
  await saveMetadata(deps, threadId, { locked: false, lastTitle: proposal });
  return { kind: "renamed", from: thread.title, to: proposal, ...usage };
}

/**
 * An untitled "Continue from @thread:..." handoff. bb displays its prompt with
 * the mention resolved to the source thread's current title, so the name
 * follows the source when it is renamed. Giving it a title would break that.
 */
function isLiveHandoff(thread: { title: string | null; titleFallback: string | null }): boolean {
  return thread.title === null && (thread.titleFallback ?? "").startsWith("Continue from @thread:");
}

function saveMetadata(deps: RetitleDeps, threadId: string, set: Required<RetitleMetadata>) {
  return deps.sdk.threads.updatePluginMetadata({ threadId, pluginId: deps.pluginId, set });
}

function skipped(reason: SkipReason): RetitleOutcome {
  return { kind: "skipped", reason };
}

export function describeOutcome(outcome: RetitleOutcome): string {
  switch (outcome.kind) {
    case "renamed":
      return `Renamed: ${JSON.stringify(outcome.from)} -> ${JSON.stringify(outcome.to)}`;
    case "proposed":
      return `Would rename: ${JSON.stringify(outcome.from)} -> ${JSON.stringify(outcome.to)}`;
    case "kept":
      return `Kept: ${JSON.stringify(outcome.title)}`;
    case "skipped":
      return `Skipped: ${outcome.reason}`;
  }
}
