import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePatchFiles } from "@pierre/diffs";
import { commentSelection, placeAnnotations } from "./diff-annotations.ts";

const patch = parsePatchFiles(`diff --git a/example.ts b/example.ts
--- a/example.ts
+++ b/example.ts
@@ -10,3 +20,3 @@
 context
-old
+new
 context
`)[0].files[0];

test("comments use their own diff side and multiple comments share one inline slot", () => {
  const result = placeAnnotations(patch, [
    { side: "LEFT", line: 11, metadata: "old line" },
    { side: "RIGHT", line: 21, metadata: "first thread" },
    { side: "RIGHT", line: 21, metadata: "second thread" },
  ]);
  assert.deepEqual(result.inline, [
    { side: "deletions", lineNumber: 11, metadata: ["old line"] },
    { side: "additions", lineNumber: 21, metadata: ["first thread", "second thread"] },
  ]);
  assert.deepEqual(result.detached, []);
});

test("file comments, outdated comments, and lines absent from a patch remain visible outside the diff", () => {
  const result = placeAnnotations(patch, [
    { side: "RIGHT", line: null, metadata: "file comment" },
    { side: "RIGHT", line: 21, detached: true, metadata: "outdated thread" },
    { side: "LEFT", line: 21, metadata: "not an old-side line" },
    { side: "RIGHT", line: 23, metadata: "past the hunk" },
    { side: "RIGHT", line: 0, metadata: "invalid line" },
  ]);
  assert.deepEqual(result.inline, []);
  assert.deepEqual(result.detached, ["file comment", "outdated thread", "not an old-side line", "past the hunk", "invalid line"]);
});

test("comments on binary or missing patches are retained", () => {
  assert.deepEqual(placeAnnotations(null, [{ side: "RIGHT", line: 1, metadata: "comment" }]), { inline: [], detached: ["comment"] });
});

test("cross-side selections cannot create a review comment on unrelated line coordinates", () => {
  assert.equal(commentSelection({ start: 11, end: 21, side: "deletions", endSide: "additions" }), null);
  assert.deepEqual(commentSelection({ start: 12, end: 10, side: "deletions" }), { line: 12, startLine: 10, side: "LEFT" });
  assert.deepEqual(commentSelection({ start: 21, end: 21 }), { line: 21, startLine: null, side: "RIGHT" });
});
