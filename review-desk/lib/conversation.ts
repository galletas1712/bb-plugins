import type { GhEvent, GhIssueComment, GhReview, GhThread } from "../host-contract";

export type ActivityCursor = { key: string; when: string };
export const compareActivity = (a: ActivityCursor, b: ActivityCursor) => (Date.parse(a.when) || 0) - (Date.parse(b.when) || 0) || a.key.localeCompare(b.key);

export interface ConversationItem extends ActivityCursor {
  author: string;
  body: string;
  url: string;
  state?: string;
  thread?: GhThread;
  event?: GhEvent;
  commits?: GhEvent[];
  target?: { kind: "review" | "comment"; id: string };
  canEdit?: boolean;
}

export const timelineLabels: Record<string, string> = {
  merged: "merged this pull request",
  closed: "closed this pull request",
  reopened: "reopened this pull request",
  ready_for_review: "marked this pull request as ready for review",
  convert_to_draft: "marked this pull request as draft",
  review_dismissed: "dismissed a review",
  base_ref_changed: "changed the base branch",
  head_ref_deleted: "deleted the branch",
  head_ref_restored: "restored the branch",
};
const isCommit = (event: GhEvent) => event.event === "committed" || event.event === "head_ref_force_pushed";

/** Keep feedback and lifecycle changes, grouping adjacent branch updates before pagination. */
export function conversationActivity(conversation: { reviews: GhReview[]; comments: GhIssueComment[]; events: GhEvent[] } | null, threads: GhThread[]): ConversationItem[] {
  const items: ConversationItem[] = [
    ...(conversation?.reviews ?? []).map((r) => ({ key: "review-" + r.id, author: r.author, when: r.submittedAt ?? "", body: r.body, state: r.state, url: r.url, canEdit: r.canEdit, target: r.nodeId ? { kind: "review" as const, id: r.nodeId } : undefined })),
    ...(conversation?.comments ?? []).map((c) => ({ key: "comment-" + c.id, author: c.author, when: c.createdAt, body: c.body, url: c.url, canEdit: c.canEdit, target: c.nodeId ? { kind: "comment" as const, id: c.nodeId } : undefined })),
    ...threads.filter((thread) => !thread.isOutdated && !thread.isResolved).map((thread) => ({ key: "thread-" + thread.id, author: "", when: thread.comments.reduce((latest, comment) => (Date.parse(comment.createdAt) || 0) > (Date.parse(latest) || 0) ? comment.createdAt : latest, ""), body: "", url: "", thread })),
    ...(conversation?.events ?? []).filter((event) => isCommit(event) || Object.hasOwn(timelineLabels, event.event)).map((event) => ({ key: "event-" + event.id, author: event.actor ?? "", when: event.createdAt ?? "", body: event.details, url: event.url ?? "", event })),
  ];
  items.sort(compareActivity);
  const grouped: ConversationItem[] = [];
  for (const item of items) {
    if (item.event && isCommit(item.event)) {
      const previous = grouped.at(-1);
      if (previous?.commits) previous.commits.push(item.event);
      // Keep the first event's key/time stable when new commits join an expanded group.
      else grouped.push({ ...item, event: undefined, commits: [item.event] });
    } else grouped.push(item);
  }
  return grouped;
}
