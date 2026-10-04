import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";

/** GitHub review ranges belong to one side; old and new line numbers cannot be mixed. */
export function commentSelection(range: SelectedLineRange): { line: number; startLine: number | null; side: "LEFT" | "RIGHT" } | null {
  const side = range.side ?? "additions";
  if ((range.endSide ?? side) !== side) return null;
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  return { line: end, startLine: start === end ? null : start, side: side === "deletions" ? "LEFT" : "RIGHT" };
}

export interface CommentAnchor<T> {
  side: "LEFT" | "RIGHT";
  line: number | null;
  detached?: boolean;
  metadata: T;
}

/** Only current lines present in the displayed patch can own an inline slot. */
export function placeAnnotations<T>(file: FileDiffMetadata | null, comments: CommentAnchor<T>[]): {
  inline: DiffLineAnnotation<T[]>[];
  detached: T[];
} {
  const groups = new Map<string, DiffLineAnnotation<T[]>>();
  const detached: T[] = [];
  for (const comment of comments) {
    const side = comment.side === "LEFT" ? "deletions" : "additions";
    const line = comment.line;
    const present = file !== null && !comment.detached && line !== null && line > 0 && file.hunks.some((hunk) => {
      const start = side === "additions" ? hunk.additionStart : hunk.deletionStart;
      const count = side === "additions" ? hunk.additionCount : hunk.deletionCount;
      return line >= start && line < start + count;
    });
    if (!present || line === null) {
      detached.push(comment.metadata);
      continue;
    }
    const key = `${side}:${line}`;
    const group = groups.get(key);
    if (group) group.metadata.push(comment.metadata);
    else groups.set(key, { side, lineNumber: line, metadata: [comment.metadata] });
  }
  return { inline: [...groups.values()], detached };
}
