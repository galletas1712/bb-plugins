import assert from "node:assert/strict";
import { test } from "node:test";
import { orderThreadComments } from "./thread-comments.ts";

const comment = (id, replyToId, time) => ({ id, replyToId, createdAt: `2026-10-05T00:00:0${time}Z` });

test("the original precedes replies and each reply's descendants remain underneath it", () => {
  const input = [comment("late", "root", 4), comment("nested", "early", 3), comment("root", null, 1), comment("early", "root", 2)];
  assert.deepEqual(orderThreadComments(input).map(({ comment, depth }) => [comment.id, depth]), [["root", 0], ["early", 1], ["nested", 2], ["late", 1]]);
  assert.equal(input[0].id, "late");
});

test("a reply whose parent was deleted remains visible", () => {
  assert.deepEqual(orderThreadComments([comment("orphan", "deleted", 2)]).map(({ comment, depth }) => [comment.id, depth]), [["orphan", 0]]);
});

test("inconsistent reply relationships do not hide comments or loop forever", () => {
  const input = [comment("one", "two", 1), comment("two", "one", 2)];
  assert.deepEqual(orderThreadComments(input).map(({ comment }) => comment.id), ["one", "two"]);
});
