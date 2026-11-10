// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PodMutexEntry } from "../api/podMutex";
import { Resources } from "./Resources";

const mockPodMutexApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  release: vi.fn(),
}));
const mockIssuesApi = vi.hoisted(() => ({ listLabels: vi.fn() }));

vi.mock("../api/podMutex", () => ({ podMutexApi: mockPodMutexApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => <a href={to} {...rest}>{children}</a>,
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(cb: () => void) {
  flushSync(cb);
}
async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
    await new Promise((r) => window.setTimeout(r, 0));
  }
}

const HELD: PodMutexEntry = {
  id: "cfg-1",
  labelId: "label-1",
  labelName: "pod:igor-3090",
  labelColor: "#000",
  holdingStatuses: ["todo", "in_progress"],
  enabled: true,
  createdAt: "2026-11-10T00:00:00Z",
  updatedAt: "2026-11-10T00:00:00Z",
  holder: {
    rootIssueId: "issue-a",
    identifier: "INF-1",
    title: "Tree A",
    acquiredAt: "2026-11-10T10:00:00Z",
    acquiredByIssueId: "issue-a",
    stillHolding: true,
  },
  waiting: [
    { issueId: "issue-b", identifier: "INF-2", title: "B", priority: "high", status: "todo", hasQueuedRun: true },
    { issueId: "issue-c", identifier: "INF-3", title: "C", priority: "low", status: "todo", hasQueuedRun: false },
  ],
};

describe("Resources page", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockIssuesApi.listLabels.mockResolvedValue([{ id: "label-1", name: "pod:igor-3090" }, { id: "label-2", name: "pod:free" }]);
    for (const fn of [mockPodMutexApi.create, mockPodMutexApi.update, mockPodMutexApi.remove, mockPodMutexApi.release]) {
      fn.mockResolvedValue({ ok: true });
    }
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  async function render(entries: PodMutexEntry[]) {
    mockPodMutexApi.list.mockResolvedValue(entries);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    act(() => {
      root.render(<QueryClientProvider client={qc}><Resources /></QueryClientProvider>);
    });
    await flush();
  }

  function button(text: string) {
    const b = [...container.querySelectorAll("button")].find((el) => el.textContent?.trim() === text);
    if (!b) throw new Error(`button ${text} not found`);
    return b as HTMLButtonElement;
  }

  it("shows the empty state when nothing is configured", async () => {
    await render([]);
    expect(mockPodMutexApi.list).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("No mutex labels configured");
  });

  it("renders label, holder and the waiting queue", async () => {
    await render([HELD]);
    const text = container.textContent ?? "";
    expect(text).toContain("pod:igor-3090");
    expect(text).toContain("held by");
    expect(text).toContain("INF-1");
    expect(text).not.toContain("(releasing)");
    const items = [...container.querySelectorAll("ol li")].map((li) => li.textContent);
    expect(items[0]).toContain("INF-2");
    expect(items[0]).toContain("queued run");
    expect(items[1]).toContain("INF-3");
    expect(items[1]).not.toContain("queued run");
    expect(container.querySelector('a[href="/issues/INF-1"]')).toBeTruthy();
  });

  it("marks a lease whose tree no longer holds as releasing; free mutex disables Release", async () => {
    await render([
      { ...HELD, holder: { ...HELD.holder!, stillHolding: false } },
      { ...HELD, id: "cfg-2", labelId: "label-2", labelName: "pod:free", holder: null, waiting: [] },
    ]);
    expect(container.textContent).toContain("(releasing)");
    expect(container.textContent).toContain("free");
    const releases = [...container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Release");
    expect(releases[0]!.disabled).toBe(false);
    expect(releases[1]!.disabled).toBe(true);
  });

  it("toggling a holding status and the enabled switch calls update", async () => {
    await render([HELD]);
    act(() => button("blocked").click());
    await flush();
    expect(mockPodMutexApi.update).toHaveBeenCalledWith("company-1", "label-1", {
      labelId: "label-1",
      holdingStatuses: ["todo", "in_progress", "blocked"],
    });
    act(() => button("todo").click());
    await flush();
    expect(mockPodMutexApi.update).toHaveBeenLastCalledWith("company-1", "label-1", {
      labelId: "label-1",
      holdingStatuses: ["in_progress"],
    });
    const sw = container.querySelector('[role="switch"]') as HTMLButtonElement;
    act(() => sw.click());
    await flush();
    expect(mockPodMutexApi.update).toHaveBeenLastCalledWith("company-1", "label-1", { labelId: "label-1", enabled: false });
    // refetch after mutation
    expect(mockPodMutexApi.list.mock.calls.length).toBeGreaterThan(1);
  });

  it("force-release asks for confirmation and calls the API only when confirmed", async () => {
    await render([HELD]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    act(() => button("Release").click());
    await flush();
    expect(mockPodMutexApi.release).not.toHaveBeenCalled();
    act(() => button("Release").click());
    await flush();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(mockPodMutexApi.release).toHaveBeenCalledWith("company-1", "label-1");
  });

  it("remove asks for confirmation and calls the API", async () => {
    await render([HELD]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    act(() => button("Remove").click());
    await flush();
    expect(mockPodMutexApi.remove).toHaveBeenCalledWith("company-1", "label-1");
  });

  it("adding uses the existing label id, or the name for a new label", async () => {
    await render([HELD]);
    const input = container.querySelector("input") as HTMLInputElement;
    const setValue = (v: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      act(() => {
        setter.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    setValue("pod:free");
    act(() => button("Add mutex label").click());
    await flush();
    expect(mockPodMutexApi.create).toHaveBeenCalledWith("company-1", { labelId: "label-2" });
    setValue("  pod:brand-new ");
    act(() => button("Add mutex label").click());
    await flush();
    expect(mockPodMutexApi.create).toHaveBeenLastCalledWith("company-1", { labelName: "pod:brand-new" });
  });

  it("shows API errors", async () => {
    mockPodMutexApi.list.mockRejectedValue(new Error("Board access required"));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    act(() => {
      root.render(<QueryClientProvider client={qc}><Resources /></QueryClientProvider>);
    });
    await flush();
    expect(container.textContent).toContain("Board access required");
  });
});
