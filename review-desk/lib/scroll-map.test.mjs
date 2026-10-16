import assert from "node:assert/strict";
import { test } from "node:test";
import { mapScroll } from "./scroll-map.ts";

test("scroll correspondence follows block edges in both directions despite different heights", () => {
  const anchors = [{ source: 0, rendered: 0 }, { source: 100, rendered: 300 }, { source: 500, rendered: 400 }, { source: 600, rendered: 900 }];
  assert.equal(mapScroll(100, anchors, "source"), 300);
  assert.equal(mapScroll(300, anchors, "source"), 350);
  assert.equal(mapScroll(550, anchors, "source"), 650);
  assert.equal(mapScroll(350, anchors, "rendered"), 300);
  assert.equal(mapScroll(650, anchors, "rendered"), 550);
});

test("annotation height changes alter source measurements without moving the matching rendered block", () => {
  const before = [{ source: 0, rendered: 0 }, { source: 100, rendered: 200 }, { source: 200, rendered: 500 }];
  const expanded = [{ source: 0, rendered: 0 }, { source: 400, rendered: 200 }, { source: 500, rendered: 500 }];
  assert.equal(mapScroll(200, before, "rendered"), 100);
  assert.equal(mapScroll(200, expanded, "rendered"), 400);
  assert.equal(mapScroll(450, expanded, "source"), 350);
});

test("empty, duplicate, collapsed, and invalid measurements remain finite and clamped", () => {
  assert.equal(mapScroll(100, [], "source"), 0);
  const anchors = [{ source: 0, rendered: 0 }, { source: 0, rendered: 0 }, { source: NaN, rendered: 100 }, { source: 50, rendered: 80 }, { source: 40, rendered: 100 }, { source: 100, rendered: 200 }];
  assert.equal(mapScroll(-50, anchors, "source"), 0);
  assert.equal(mapScroll(500, anchors, "source"), 200);
  assert.equal(mapScroll(50, anchors, "source"), 80);
});
