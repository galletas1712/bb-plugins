interface ThreadComment { id: string; replyToId: string | null; createdAt: string }

/** Keep replies under their parent even when API pages arrive out of order. */
export function orderThreadComments<T extends ThreadComment>(comments: T[]): { comment: T; depth: number }[] {
  const ids = new Set(comments.map((comment) => comment.id));
  const children = new Map<string | null, T[]>();
  for (const comment of [...comments].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    const parent = comment.replyToId !== null && ids.has(comment.replyToId) ? comment.replyToId : null;
    const group = children.get(parent) ?? [];
    group.push(comment);
    children.set(parent, group);
  }
  const ordered: { comment: T; depth: number }[] = [];
  const visited = new Set<string>();
  const visit = (comment: T, depth: number) => {
    if (visited.has(comment.id)) return;
    visited.add(comment.id);
    ordered.push({ comment, depth });
    for (const reply of children.get(comment.id) ?? []) visit(reply, depth + 1);
  };
  for (const root of children.get(null) ?? []) visit(root, 0);
  // Preserve comments with unavailable or inconsistent parent relationships.
  for (const comment of comments) visit(comment, 0);
  return ordered;
}
