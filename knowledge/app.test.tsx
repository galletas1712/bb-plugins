// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ExplainersPanel, ExplainerOpener } from "./explainer-ui";

const app = await loadPluginApp(() => import("./app"));
const first = {
  recordId: "handoff",
  name: "overview.html",
  title: "How request handoff works",
  addedAt: "2026-10-01T00:00:00.000Z",
};
const second = {
  ...first,
  name: "workers.html",
  title: "Why workers reconnect",
};
const props = { threadId: "thread-one", environment: null };
const saved = {
  html: '<h1 style="color:var(--foreground)">Handoff</h1><script>window.count=1</script>',
  sha256: "a".repeat(64),
  path: "/library/saved.html",
  hostId: "host-one",
};
const ref = { recordId: first.recordId, name: first.name };

beforeEach(() => {
  window.matchMedia = vi.fn(
    () =>
      ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
  document.documentElement.style.setProperty(
    "--foreground",
    "rgb(230, 230, 230)",
  );
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
});

it("registers only a thread destination and compact opener", () => {
  expect(app.tabs).toHaveLength(1);
  expect(app.tabs[0]).toMatchObject({
    id: "explainers",
    context: { kind: "thread" },
    availability: "fixed",
  });
  expect(app.messageDirectives.map((directive) => directive.id)).toEqual([
    "explainer",
  ]);
  expect(app.threadInfoSections).toEqual([]);
  expect(app.threadRowMetadata).toEqual([]);
  expect(app.navPanels).toHaveLength(1);
});

it("shows just short titles, reads in the panel and returns to the list", async () => {
  const slot = renderSlot({ component: ExplainersPanel }, props, {
    rpc: {
      listThreadExplainers: () => [first, second],
      readExplainer: () => saved,
    },
  });
  fireEvent.click(await slot.findByRole("button", { name: first.title }));
  const frame = (await slot.findByTitle(first.title)) as HTMLIFrameElement;
  expect(frame.srcdoc).toContain("--foreground:rgb(230, 230, 230)");
  expect(frame.srcdoc).toContain("<script>window.count=1</script>");
  expect(frame.getAttribute("sandbox")).toBe(
    "allow-scripts allow-popups allow-popups-to-escape-sandbox",
  );
  expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
  fireEvent.click(slot.getByRole("button", { name: "← Back" }));
  expect(await slot.findByRole("button", { name: second.title })).toBeTruthy();
  expect(slot.queryByRole("textbox")).toBeNull();
  expect(
    slot.queryByText(/Add from Knowledge|Remove|Saved|overview.html/),
  ).toBeNull();
});

it("leaves the reader intact on unrelated refreshes and loads new saved bytes", async () => {
  let document = saved;
  const slot = renderSlot({ component: ExplainersPanel }, props, {
    rpc: {
      listThreadExplainers: () => [first],
      readExplainer: () => document,
    },
  });
  fireEvent.click(await slot.findByRole("button", { name: first.title }));
  const frame = (await slot.findByTitle(first.title)) as HTMLIFrameElement;
  const original = frame.srcdoc;
  await slot.behavior.emitRealtime("changed", {});
  expect(slot.getByTitle(first.title)).toBe(frame);
  expect(frame.srcdoc).toBe(original);
  document = {
    ...saved,
    html: "<h1>Updated handoff</h1>",
    sha256: "b".repeat(64),
  };
  await slot.behavior.emitRealtime("changed", {});
  await waitFor(() => expect(frame.srcdoc).toContain("Updated handoff"));
});

it("opens a fixed-tab target and clears it on Back", async () => {
  const slot = renderSlot({ component: ExplainersPanel }, props, {
    rpc: {
      listThreadExplainers: () => [first],
      readExplainer: () => saved,
    },
    experimental_fixedTabTarget: { tabId: "explainers", target: ref },
  });
  await slot.findByTitle(first.title);
  fireEvent.click(slot.getByRole("button", { name: "← Back" }));
  await slot.findByRole("button", { name: first.title });
  await slot.behavior.emitRealtime("changed", {});
  expect(slot.queryByTitle(first.title)).toBeNull();
});

it("shows an empty state and retries local failures", async () => {
  let fail = true;
  const slot = renderSlot({ component: ExplainersPanel }, props, {
    rpc: {
      listThreadExplainers: () => {
        if (fail) throw new Error("Temporarily unavailable");
        return [];
      },
    },
  });
  await slot.findByRole("alert");
  fail = false;
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  await slot.findByText("No explainers yet");
});

const directiveProps = {
  attributes: {
    record: first.recordId,
    artifact: first.name,
    title: first.title,
  },
  source: "::explainer{}",
  message: {
    id: "message-one",
    threadId: "actual-thread",
    turnId: null,
    projectId: "project-one",
  },
  openWorkspaceFile: null,
};

it("renders no inline document and opens the thread reader after association", async () => {
  const openTab = vi.fn(() => true);
  const slot = renderSlot({ component: ExplainerOpener }, directiveProps, {
    rpc: { attachThreadExplainer: () => first },
    experimental_panel: { openTab },
  });
  expect(slot.container.querySelector("iframe")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: first.title }));
  await waitFor(() =>
    expect(openTab).toHaveBeenCalledWith({
      tab: expect.objectContaining({ id: "explainers" }),
      target: ref,
    }),
  );
  expect(slot.inspection.rpcCalls[0]).toMatchObject({
    method: "attachThreadExplainer",
    input: { ...ref, threadId: "actual-thread", title: first.title },
  });
});

it("falls back to the saved file when an embedded chat has no registered tab", async () => {
  const slot = renderSlot({ component: ExplainerOpener }, directiveProps, {
    rpc: { attachThreadExplainer: () => first, readExplainer: () => saved },
    openFilePreview: () => true,
  });
  fireEvent.click(slot.getByRole("button", { name: first.title }));
  await waitFor(() =>
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "experimental_openFilePreview",
      options: {
        target: { kind: "host", hostId: "host-one", path: saved.path },
        location: null,
      },
    }),
  );
});

it("keeps failed attachment local and never falls back to scratch HTML", async () => {
  const openTab = vi.fn(() => true);
  const slot = renderSlot({ component: ExplainerOpener }, directiveProps, {
    rpc: {
      attachThreadExplainer: () => {
        throw new Error("Saved file missing");
      },
    },
    experimental_panel: { openTab },
  });
  fireEvent.click(slot.getByRole("button", { name: first.title }));
  expect((await slot.findByRole("alert")).textContent).toBe(
    "Saved file missing",
  );
  expect(openTab).not.toHaveBeenCalled();
  expect(slot.inspection.navigateCalls).toEqual([]);
});
