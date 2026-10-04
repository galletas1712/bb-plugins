import assert from "node:assert/strict";
import { test } from "node:test";
import { diffMarkdown } from "./markdown-diff.ts";

test("a paragraph edit preserves unchanged headings and source locations", () => {
  const changes = diffMarkdown("# Title\n\nOld paragraph.\n\nEnd.", "# Title\n\nNew paragraph.\n\nEnd.");
  assert.deepEqual(changes.map((change) => change.changed), [false, true, false]);
  assert.deepEqual(changes[1].old, [{ content: "Old paragraph.", startLine: 3, endLine: 3 }]);
  assert.deepEqual(changes[1].new, [{ content: "New paragraph.", startLine: 3, endLine: 3 }]);
});

test("added and deleted documents retain every block", () => {
  const content = "# New file\n\nText.";
  const added = diffMarkdown("", content);
  const removed = diffMarkdown(content, "");
  assert.equal(added.length, 1);
  assert.equal(removed.length, 1);
  assert.deepEqual(added[0].old, []);
  assert.deepEqual(removed[0].new, []);
  assert.deepEqual(added[0].new, removed[0].old);
  assert.equal(added[0].changed, true);
  assert.equal(removed[0].changed, true);
  assert.deepEqual(diffMarkdown("", ""), []);
});

test("tables, nested lists, quotes, and fences remain complete blocks", () => {
  const content = "| A | B |\n| - | - |\n| one | two |\n\n- [x] Task\n  - Nested\n\n> Quote\n> continued\n\n```md\n# Literal heading\n\nParagraph inside fence.\n```";
  const changes = diffMarkdown("", content);
  assert.equal(changes[0].new.length, 4);
  assert.deepEqual(changes[0].new.map((block) => [block.startLine, block.endLine]), [[1, 3], [5, 6], [8, 9], [11, 15]]);
  assert.ok(changes[0].new[3].content.endsWith("```"));
});

test("unchanged blocks preserve different old and new line numbers", () => {
  const changes = diffMarkdown("# Title\n\nEnd.", "# Title\n\nInserted.\n\nEnd.");
  const last = changes.at(-1);
  assert.equal(last.changed, false);
  assert.equal(last.old[0].startLine, 3);
  assert.equal(last.new[0].startLine, 5);
});

test("reference link edits affect the referencing block", () => {
  const old = "# Title\n\n[Link][target]\n\n[target]: https://example.com/old\n[unused]: https://example.com/unused";
  const changes = diffMarkdown(old, old.replace("example.com/old", "example.com/new"));
  assert.equal(changes[0].changed, false);
  assert.equal(changes[1].changed, true);
  assert.ok(changes[1].old[0].content.includes("[target]: https://example.com/old"));
  assert.ok(!changes[1].old[0].content.includes("[unused]"));
  assert.equal(diffMarkdown(old, old.replace("example.com/unused", "example.com/other"))[0].changed, false);
});

test("footnotes carry nested reference definitions and reflect edits", () => {
  const old = "Text[^note].\n\n[^note]: See [link][target].\n\n[target]: https://example.com";
  const changes = diffMarkdown(old, old.replace("See", "Read"));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changed, true);
  assert.ok(changes[0].new[0].content.includes("[^note]: Read [link][target]."));
  assert.ok(changes[0].new[0].content.includes("[target]: https://example.com"));
});

test("blank line spacing and CRLF do not split or change rendered blocks", () => {
  const old = "# Title\r\n\r\nParagraph.\r\n";
  const changes = diffMarkdown(old, "# Title\n\n\nParagraph.\n");
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changed, false);
  assert.equal(changes[0].new[1].startLine, 4);
});

test("multiple insertions and removals reconstruct both documents in order", () => {
  const old = "# One\n\nOld A\n\nOld B\n\n# Two\n\nKeep\n\nOld tail";
  const next = "# One\n\nNew A\n\n# Two\n\nKeep\n\nNew tail\n\nMore";
  const changes = diffMarkdown(old, next);
  assert.deepEqual(changes.flatMap((change) => change.old.map((block) => block.content)), ["# One", "Old A", "Old B", "# Two", "Keep", "Old tail"]);
  assert.deepEqual(changes.flatMap((change) => change.new.map((block) => block.content)), ["# One", "New A", "# Two", "Keep", "New tail", "More"]);
});
