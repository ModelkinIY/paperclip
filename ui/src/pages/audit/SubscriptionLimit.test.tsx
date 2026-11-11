// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountLimitView } from "@/api/accountLimits";
import { SubscriptionLimit, formatAge, formatUntil, pct, statusOf } from "./SubscriptionLimit";

const listMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());
const refreshMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/accountLimits", () => ({
  accountLimitsApi: { list: listMock, update: updateMock, refresh: refreshMock },
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: unknown }) => <a href={to}>{children as never}</a>,
}));
vi.mock("@/context/ToastContext", () => ({ useOptionalToastActions: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const base = (over: Partial<AccountLimitView>): AccountLimitView => ({
  grantId: "g1", connectionId: "c1", provider: "anthropic", method: "subscription", accountName: "Claude main", accountLabel: null,
  limitsSupported: true,
  settings: { enabled: true, paceModel: "linear", weekly: { holdAbove: 0, releaseAtOrBelow: -2 }, fiveHour: { holdAbove: 0, releaseAtOrBelow: -2 }, maxStaleMinutes: 180 },
  capacity: {
    available: false, headroom: 55, reason: "weekly_ahead_of_pace", observedAt: new Date().toISOString(), source: "usage_probe",
    heldUntil: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    windows: [{ id: "seven_day", label: "7-day", scope: null, role: "weekly", usedPercent: 45, expectedPercent: 40, elapsedPercent: 40, delta: 5,
      resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), durationSeconds: 604800, hold: true }],
  },
  history: [], agents: [{ id: "a1", name: "Coder", via: "grant" }], queuedRuns: [{ id: "run-12345678", agentId: "a1", issueId: null, since: new Date().toISOString() }],
  paceModels: ["linear"], ...over,
});

describe("formatting", () => {
  it("formats percentages, times and status", () => {
    expect(pct(12.34)).toBe("12.3%");
    expect(pct(null)).toBe("—");
    expect(formatUntil(null)).toBe("—");
    expect(formatUntil(new Date(Date.now() - 1000).toISOString())).toBe("now");
    expect(formatUntil(new Date(Date.now() + 5 * 86_400_000 + 3_600_000).toISOString())).toMatch(/^in 5 d/);
    expect(formatAge(null)).toBe("never");
    expect(statusOf(base({})).label).toBe("Holding");
    expect(statusOf(base({ settings: { ...base({}).settings, enabled: false } })).label).toBe("Accounting off");
    expect(statusOf(base({ limitsSupported: false })).label).toBe("No limit");
  });
});

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("SubscriptionLimit", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listMock.mockReset();
    updateMock.mockReset().mockResolvedValue({ settings: base({}).settings });
    refreshMock.mockReset().mockResolvedValue({ probed: true });
  });
  afterEach(() => { flushSync(() => root?.unmount()); container.remove(); });

  async function mount() {
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => root.render(<QueryClientProvider client={client}><SubscriptionLimit companyId="co-1" /></QueryClientProvider>));
    for (let i = 0; i < 20 && !container.querySelector('[data-testid="subscription-limit"], [data-slot="empty-state"]'); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("lists accounts grouped by provider with status and shows pace details", async () => {
    listMock.mockResolvedValue([
      base({}),
      base({ grantId: "g2", provider: "openai", accountName: "Codex 1", settings: { ...base({}).settings, enabled: false } }),
      base({ grantId: "g3", provider: "google", method: "api_key", accountName: "Gemini key", limitsSupported: false }),
    ]);
    await mount();
    const nav = container.querySelector("nav")!;
    expect(nav.textContent).toContain("Claude");
    expect(nav.textContent).toContain("Codex / OpenAI");
    expect(nav.textContent).toContain("Holding");
    expect(nav.textContent).toContain("Accounting off");
    expect(nav.textContent).toContain("No limit");
    const details = container.querySelector('[data-testid="limit-details"]')!;
    expect(details.textContent).toContain("Weekly window ahead of pace");
    expect(details.textContent).toContain("45.0%");
    expect(details.textContent).toContain("+5.0");
    expect(details.textContent).toContain("Coder");
    expect(details.textContent).toContain("Run run-1234");
  });

  it("switches accounting per account from the list", async () => {
    listMock.mockResolvedValue([base({})]);
    await mount();
    const toggle = container.querySelector<HTMLButtonElement>('nav [role="switch"]')!;
    flushSync(() => toggle.click());
    await settle();
    expect(updateMock).toHaveBeenCalledWith("co-1", "g1", { enabled: false });
  });

  it("validates pace parameters before saving", async () => {
    listMock.mockResolvedValue([base({})]);
    await mount();
    const params = container.querySelector('[data-testid="params-Weekly"]')!;
    const [hold, release] = Array.from(params.querySelectorAll("input"));
    const set = (el: HTMLInputElement, v: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, v);
      flushSync(() => el.dispatchEvent(new Event("input", { bubbles: true })));
    };
    set(hold!, "1"); set(release!, "5");
    const save = params.querySelector("button")!;
    expect(save.disabled).toBe(true);
    expect(params.textContent).toContain("Release must not exceed hold");
    set(release!, "-1");
    expect(save.disabled).toBe(false);
    flushSync(() => save.click());
    await settle();
    expect(updateMock).toHaveBeenCalledWith("co-1", "g1", { weekly: { holdAbove: 1, releaseAtOrBelow: -1 } });
  });

  it("states that providers without limits never hold work, and takes a measurement on request", async () => {
    listMock.mockResolvedValue([base({ limitsSupported: false, accountName: "Gemini key", provider: "google" })]);
    await mount();
    expect(container.textContent).toContain("never holds work");
    listMock.mockResolvedValue([base({})]);
    flushSync(() => root.unmount());
    await mount();
    const refresh = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Refresh measurement")!;
    flushSync(() => refresh.click());
    await settle();
    expect(refreshMock).toHaveBeenCalledWith("co-1", "g1");
  });
});
