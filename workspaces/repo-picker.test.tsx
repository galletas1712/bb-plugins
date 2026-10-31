// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoPicker } from "./repo-picker";

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => rpc }));
vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked, disabled, onCheckedChange }: { checked: boolean; disabled: boolean; onCheckedChange: (value: boolean) => void }) => (
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onCheckedChange(event.target.checked)} />
  ),
}));
vi.mock("@/components/ui/icon", () => ({ Icon: () => null }));

afterEach(() => { cleanup(); rpc.call.mockReset(); });

describe("repository picker", () => {
  it("makes a bottom-pinned composer scroll as a whole and restores its styles", async () => {
    rpc.call.mockResolvedValue({ repos: ["alpha", "beta"], previous: [] });
    const view = render(
      <div data-testid="composer-frame" style={{ position: "absolute", bottom: 0, maxHeight: "80%", overflowY: "hidden" }}>
        <div data-app-composer="">
          <div data-new-thread-footer="">
            <RepoPicker projectId="p1" target={{ kind: "existing-host", hostId: "h1" }} value={null} onChange={() => {}} />
          </div>
        </div>
      </div>,
    );
    await screen.findByRole("group", { name: "Repositories" });
    const frame = screen.getByTestId("composer-frame");
    expect(frame.style.maxHeight).toBe("100%");
    expect(frame.style.overflowY).toBe("auto");
    view.unmount();
    expect(frame.style.maxHeight).toBe("80%");
    expect(frame.style.overflowY).toBe("hidden");
  });

  it("shows the checkboxes below the composer controls without opening a menu", async () => {
    rpc.call.mockResolvedValue({ repos: ["alpha", "beta"], previous: ["alpha@main"] });
    const onChange = vi.fn();
    const view = render(
      <div data-app-composer="">
        <div data-new-thread-footer="">
          <div data-bb-plugin-root="" data-bb-plugin="workspaces">
            <RepoPicker projectId="p1" target={{ kind: "existing-host", hostId: "h1" }} value={null} onChange={onChange} />
          </div>
        </div>
      </div>,
    );
    const group = await screen.findByRole("group", { name: "Repositories" });
    const footer = view.container.querySelector("[data-new-thread-footer]")!;
    expect(footer.nextElementSibling?.contains(group)).toBe(true);
    expect((screen.getByRole("checkbox", { name: "alpha" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "beta" }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ status: "ready", value: { repos: ["alpha@main", "beta"] } }));
    view.unmount();
    expect(group.isConnected).toBe(false);
  });
  it("loads saved refs, omits unavailable repos, and retains edits after a reload", async () => {
    rpc.call.mockResolvedValue({ repos: ["alpha", "beta"], previous: ["alpha@origin/topic", "missing@main"] });
    const onChange = vi.fn();
    render(<RepoPicker projectId="p1" target={{ kind: "existing-host", hostId: "h1" }} value={null} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ status: "ready", value: { repos: ["alpha@origin/topic"] } }));
    const start = screen.getByPlaceholderText(/default branch/);
    fireEvent.change(start, { target: { value: "#123" } });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ status: "ready", value: { repos: ["alpha@#123"] } }));
  });

  it("loads each project's selection independently when the project changes", async () => {
    rpc.call.mockImplementation(async (_method, { projectId }) => ({
      repos: ["alpha", "beta"], previous: projectId === "p1" ? ["alpha@main"] : ["beta@#7"],
    }));
    const onChange = vi.fn();
    const target = { kind: "existing-host" as const, hostId: "h1" };
    const view = render(<RepoPicker projectId="p1" target={target} value={null} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ status: "ready", value: { repos: ["alpha@main"] } }));
    view.rerender(<RepoPicker projectId="p2" target={target} value={null} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ status: "ready", value: { repos: ["beta@#7"] } }));
  });

  it("preserves explicit composer inputs instead of replacing them with saved defaults", async () => {
    rpc.call.mockResolvedValue({ repos: ["alpha", "beta"], previous: ["alpha@main"] });
    const onChange = vi.fn();
    render(<RepoPicker projectId="p1" target={{ kind: "existing-host", hostId: "h1" }} value={{ repos: [] }} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ status: "ready", value: { repos: [] } }));
  });
});
