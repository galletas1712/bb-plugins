import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "HTMLElement", "Node", "MutationObserver"]) globalThis[name] = dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
const { EditableBody } = await import("./editable-body.tsx");
afterEach(cleanup);

const defaults = { body: "Original", canEdit: true, label: "comment", renderBody: (body) => createElement("p", null, body), onSave: async (body) => ({ body }) };
const mount = (props = {}) => render(createElement(EditableBody, { ...defaults, ...props }));
const start = (view) => fireEvent.click(view.getByRole("button", { name: "Edit comment" }));
const change = (view, value) => fireEvent.change(view.getByRole("textbox"), { target: { value } });
const submit = async (view) => { await act(async () => { fireEvent.click(view.getByRole("button", { name: "Save" })); }); };

test("edit controls follow GitHub permissions", () => {
  const view = mount({ canEdit: false });
  assert.equal(view.queryByRole("button", { name: "Edit comment" }), null);
  assert.ok(view.getByText("Original"));
});

test("cancel discards edits without saving and refreshes the original", () => {
  let saves = 0;
  let cancels = 0;
  const view = mount({ onSave: async () => { saves++; return { body: "Saved" }; }, onCancel: () => { cancels++; } });
  start(view);
  change(view, "Draft");
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  assert.equal(saves, 0);
  assert.equal(cancels, 1);
  assert.ok(view.getByText("Original"));
});

test("save preserves exact Markdown and shows the canonical result", async () => {
  const saves = [];
  const view = mount({ onSave: async (body, original) => { saves.push({ body, original }); return { body: "GitHub result" }; } });
  start(view);
  assert.equal(view.getByRole("button", { name: "Save" }).disabled, true);
  change(view, "  Markdown\n\n");
  await submit(view);
  assert.deepEqual(saves, [{ body: "  Markdown\n\n", original: "Original" }]);
  assert.equal(view.queryByRole("textbox"), null);
  assert.ok(view.getByText("GitHub result"));
});

test("background updates preserve the draft and its expected original", async () => {
  const saves = [];
  const onSave = async (body, original) => { saves.push({ body, original }); return { body }; };
  const view = mount({ onSave });
  start(view);
  change(view, "Draft");
  view.rerender(createElement(EditableBody, { ...defaults, body: "External update", onSave }));
  assert.equal(view.getByRole("textbox").value, "Draft");
  await submit(view);
  assert.deepEqual(saves, [{ body: "Draft", original: "Original" }]);
});

test("failed saves retain the draft and allow retry", async () => {
  let attempts = 0;
  const view = mount({ onSave: async (body) => { if (++attempts === 1) throw new Error("GitHub rejected the edit"); return { body }; } });
  start(view);
  change(view, "Draft");
  await submit(view);
  assert.match(view.getByRole("alert").textContent, /GitHub rejected/);
  assert.equal(view.getByRole("textbox").value, "Draft");
  await submit(view);
  assert.ok(view.getByText("Draft"));
  assert.equal(view.queryByRole("alert"), null);
});

test("saving blocks duplicate submissions and cancel", async () => {
  let finish;
  let calls = 0;
  const view = mount({ onSave: () => { calls++; return new Promise((resolve) => { finish = resolve; }); } });
  start(view);
  change(view, "Draft");
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  assert.equal(view.getByRole("button", { name: "Saving…" }).disabled, true);
  assert.equal(view.getByRole("button", { name: "Cancel" }).disabled, true);
  assert.equal(view.getByRole("textbox").disabled, true);
  assert.equal(calls, 1);
  await act(async () => { finish({ body: "Draft" }); });
  assert.ok(view.getByText("Draft"));
});

test("descriptions may be cleared while comments must have content", async () => {
  const view = mount();
  start(view);
  change(view, " ");
  assert.equal(view.getByRole("button", { name: "Save" }).disabled, true);
  view.rerender(createElement(EditableBody, { ...defaults, allowEmpty: true }));
  change(view, "");
  assert.equal(view.getByRole("button", { name: "Save" }).disabled, false);
  await submit(view);
  assert.equal(view.queryByRole("textbox"), null);
});
