// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
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
};
const ref = { recordId: first.recordId, name: first.name };
const target = { ...ref, title: first.title };

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
  document.documentElement.style.setProperty("--timeline-accent", "cyan");
  document.documentElement.style.setProperty("--success", "green");
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
  expect(frame.srcdoc).toContain("--brand:cyan");
  expect(frame.srcdoc).toContain("--chart-2:#0d9488");
  await act(async () => {
    document.documentElement.style.colorScheme = "dark";
  });
  await waitFor(() => expect(frame.srcdoc).toContain("--chart-2:#2dd4bf"));
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
  const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
  let savedDocument = saved;
  const slot = renderSlot({ component: ExplainersPanel }, props, {
    rpc: {
      listThreadExplainers: () => [first],
      readExplainer: () => savedDocument,
    },
  });
  fireEvent.click(await slot.findByRole("button", { name: first.title }));
  const frame = (await slot.findByTitle(first.title)) as HTMLIFrameElement;
  const original = frame.srcdoc;
  const parses = parse.mock.calls.length;
  await act(async () => {
    document.documentElement.style.setProperty("--panel-width", "420px");
    document.documentElement.setAttribute("data-layout", "changed");
  });
  expect(parse).toHaveBeenCalledTimes(parses);
  await slot.behavior.emitRealtime("changed", {});
  expect(slot.getByTitle(first.title)).toBe(frame);
  expect(frame.srcdoc).toBe(original);
  expect(parse).toHaveBeenCalledTimes(parses);
  savedDocument = {
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
      attachThreadExplainer: () => first,
    },
    experimental_fixedTabTarget: { tabId: "explainers", target },
  });
  await slot.findByTitle(first.title);
  expect(slot.inspection.rpcCalls).toContainEqual({
    method: "attachThreadExplainer",
    input: { threadId: "thread-one", ...target },
  });
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

it("renders only an opener and leaves association to the receiving panel", async () => {
  const openTab = vi.fn(() => true);
  const slot = renderSlot({ component: ExplainerOpener }, directiveProps, {
    experimental_panel: { openTab },
  });
  expect(slot.container.querySelector("iframe")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: first.title }));
  await waitFor(() =>
    expect(openTab).toHaveBeenCalledWith({
      tab: expect.objectContaining({ id: "explainers" }),
      target,
    }),
  );
  expect(slot.inspection.rpcCalls).toEqual([]);
});

it("opens the source thread when an embedded chat has no registered tab", async () => {
  const slot = renderSlot({ component: ExplainerOpener }, directiveProps);
  fireEvent.click(slot.getByRole("button", { name: first.title }));
  await waitFor(() =>
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "actual-thread",
    }),
  );
  expect(slot.inspection.rpcCalls).toEqual([]);
});

it("retries failed panel attachment without opening an unlisted document", async () => {
  let fail = true;
  const slot = renderSlot({ component: ExplainersPanel }, props, {
    rpc: {
      listThreadExplainers: () => [],
      readExplainer: () => saved,
      attachThreadExplainer: () => {
        if (fail) throw new Error("Metadata offline");
        return first;
      },
    },
    experimental_fixedTabTarget: { tabId: "explainers", target },
  });
  expect((await slot.findByRole("alert")).textContent).toBe("Metadata offline");
  expect(slot.container.querySelector("iframe")).toBeNull();
  expect(slot.inspection.navigateCalls).toEqual([]);
  fail = false;
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  await slot.findByTitle(first.title);
});
