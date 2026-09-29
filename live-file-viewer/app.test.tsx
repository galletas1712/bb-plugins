// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { htmlDocument } from "./preview";
// jsdom has no layout engine; CodeMirror measures ranges on animation frames.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
afterEach(cleanup);
let sequence = 0;
async function mount(extension = "html") {
  const app = await loadPluginApp(() => import("./app"));
  const writes = vi.fn(async (_input: unknown) => ({
    outcome: "written",
    sha256: "b".repeat(64),
  }));
  const slot = renderSlot(
    app.fileOpeners[0]!,
    {
      path: `test-${sequence++}.${extension}`,
      source: {
        kind: "workspace",
        threadId: "thread",
        environmentId: "env",
        projectId: "project",
      },
      Original: () => null,
    },
    {
      rpc: {
        read: () => ({
          content: "<h1>Saved</h1>",
          sha256: "a".repeat(64),
          rootPath: "/work",
          readOnly: false,
        }),
        assets: () => ({
          baseUrl: "https://bb.test/assets/token/",
          expiresAtMs: Date.now() + 3600000,
        }),
        write: writes,
      },
    },
  );
  await slot.findByRole("button", { name: "Editor" });
  await waitFor(() =>
    expect(slot.container.querySelector(".cm-editor")).not.toBeNull(),
  );
  return { slot, writes };
}
it("keeps the saved preview in a sandbox and preserves selection and undo across modes", async () => {
  const { slot, writes } = await mount();
  expect(
    slot.getByRole("button", { name: "Preview" }).getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(slot.getByRole("button", { name: "Editor" }));
  await waitFor(() =>
    expect(slot.container.querySelector(".cm-editor")).not.toBeNull(),
  );
  const element = slot.container.querySelector(".cm-editor")!;
  const view = EditorView.findFromDOM(element as HTMLElement)!;
  act(() =>
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: "<h1>Unsaved</h1><script>window.x=1</script>",
      },
      selection: { anchor: 5 },
    }),
  );
  fireEvent.click(slot.getByRole("button", { name: "Split view" }));
  await waitFor(() => expect(slot.container.querySelector("iframe")).not.toBeNull());
  const frame = slot.container.querySelector("iframe")!;
  expect(frame.srcdoc).toContain("Saved");
  expect(frame.srcdoc).not.toContain("Unsaved");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(writes).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Preview" }));
  fireEvent.click(slot.getByRole("button", { name: "Editor" }));
  expect(
    EditorView.findFromDOM(
      slot.container.querySelector(".cm-editor") as HTMLElement,
    ),
  ).toBe(view);
  expect(view.state.selection.main.anchor).toBe(5);
  act(() => {
    undo(view);
  });
  expect(view.state.doc.toString()).toBe("<h1>Saved</h1>");
  act(() =>
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "<h1>New</h1>" },
    }),
  );
  fireEvent.click(slot.getByRole("button", { name: "Save (Ctrl/⌘ S)" }));
  await waitFor(() => expect(writes).toHaveBeenCalledOnce());
  expect(writes.mock.calls[0]?.[0]).toMatchObject({
    content: "<h1>New</h1>",
    expectedSha256: "a".repeat(64),
  });
});
it("updates SVG previews on save without embedding an executable SVG document", async () => {
  const { slot, writes } = await mount("svg");
  fireEvent.click(slot.getByRole("button", { name: "Split view" }));
  const view = EditorView.findFromDOM(
    slot.container.querySelector(".cm-editor") as HTMLElement,
  )!;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="20"/></svg>';
  act(() =>
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: svg },
    }),
  );
  expect(writes).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Save (Ctrl/⌘ S)" }));
  await waitFor(() =>
    expect(
      decodeURIComponent(slot.getByRole("img").getAttribute("src")!),
    ).toContain(svg),
  );
  expect(writes).toHaveBeenCalledOnce();
  expect(slot.container.querySelector("iframe")).toBeNull();
});
it("sets relative asset bases without replacing an explicit author base", () => {
  const result = new DOMParser().parseFromString(
    htmlDocument("<h1>Test</h1>", "https://bb.test/assets/"),
    "text/html",
  );
  expect(result.querySelector("base")?.href).toBe("https://bb.test/assets/");
  const explicit = htmlDocument(
    '<base href="https://example.com/"><p>Test</p>',
    "https://bb.test/assets/",
  );
  expect(
    new DOMParser()
      .parseFromString(explicit, "text/html")
      .querySelectorAll("base"),
  ).toHaveLength(1);
  expect(explicit).toContain("https://example.com/");
});

it("keeps Markdown preview unchanged while editing and requires confirmation before reload", async () => {
  const { slot, writes } = await mount("md");
  fireEvent.click(slot.getByRole("button", { name: "Split view" }));
  const view = EditorView.findFromDOM(
    slot.container.querySelector(".cm-editor") as HTMLElement,
  )!;
  act(() =>
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: "# Unsaved markdown",
      },
    }),
  );
  await waitFor(() =>
    expect(
      slot.container.querySelector(".lfv-markdown")?.textContent,
    ).not.toContain("Unsaved markdown"),
  );
  fireEvent.click(slot.getByRole("button", { name: "Reload from disk" }));
  expect(slot.getByRole("alertdialog")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Keep editing" }));
  expect(view.state.doc.toString()).toBe("# Unsaved markdown");
  fireEvent.click(slot.getByRole("button", { name: "Reload from disk" }));
  fireEvent.click(slot.getByRole("button", { name: "Discard and reload" }));
  await waitFor(() => expect(view.state.doc.toString()).toBe("<h1>Saved</h1>"));
  expect(writes).not.toHaveBeenCalled();
});

it("renders explicit action glyphs rather than the host fallback", async () => {
  const { slot } = await mount();
  for (const [label, icon] of [["Save (Ctrl/⌘ S)", "Save"], ["Reload from disk", "RotateCcw"]]) {
    const button = slot.getByRole("button", { name: label });
    expect(button.querySelector("svg")?.getAttribute("data-viewer-icon")).toBe(icon);
    expect(button.querySelectorAll("svg path").length).toBeGreaterThan(0);
    expect(button.getAttribute("title")).toBe(label);
  }
});
