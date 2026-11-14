// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthApiError } from "@/api/auth";
import { canChangePassword, ChangePasswordForm } from "./ProfileSettings";

const mockAuthApi = vi.hoisted(() => ({ changePassword: vi.fn() }));
vi.mock("@/api/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/auth")>()),
  authApi: mockAuthApi,
}));
vi.mock("@/api/health", () => ({ healthApi: { get: vi.fn() } }));
vi.mock("@/api/assets", () => ({ assetsApi: {} }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: null, selectedCompany: null }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// Radix Checkbox measures itself.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => window.setTimeout(r, 0));
  });
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ChangePasswordForm", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ChangePasswordForm />
        </QueryClientProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  const field = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!;
  const submit = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;

  it("keeps submit disabled until passwords match and are long enough", () => {
    type(field("current-password"), "old-pass");
    type(field("new-password"), "short");
    expect(submit().disabled).toBe(true);
    expect(container.textContent).toContain("At least 8 characters");
    type(field("new-password"), "new-password-1");
    type(field("confirm-password"), "new-password-2");
    expect(submit().disabled).toBe(true);
    expect(container.textContent).toContain("Passwords do not match");
    type(field("confirm-password"), "new-password-1");
    expect(submit().disabled).toBe(false);
  });

  it("sends the change and reports success", async () => {
    mockAuthApi.changePassword.mockResolvedValue(undefined);
    type(field("current-password"), "old-pass");
    type(field("new-password"), "new-password-1");
    type(field("confirm-password"), "new-password-1");
    act(() => submit().click());
    await flush();
    expect(mockAuthApi.changePassword).toHaveBeenCalledWith({
      currentPassword: "old-pass",
      newPassword: "new-password-1",
      revokeOtherSessions: false,
    });
    expect(container.textContent).toContain("Password changed.");
    expect(field("current-password").value).toBe("");
  });

  it("explains a wrong current password", async () => {
    mockAuthApi.changePassword.mockRejectedValue(new AuthApiError("whatever the server says", 400, null, "INVALID_PASSWORD"));
    type(field("current-password"), "wrong");
    type(field("new-password"), "new-password-1");
    type(field("confirm-password"), "new-password-1");
    act(() => submit().click());
    await flush();
    expect(container.textContent).toContain("Current password is incorrect.");
    type(field("current-password"), "right");
    expect(container.textContent).not.toContain("Current password is incorrect.");
  });

  it("rejects a password over the length limit before sending", () => {
    type(field("current-password"), "old-pass");
    type(field("new-password"), "x".repeat(129));
    type(field("confirm-password"), "x".repeat(129));
    expect(submit().disabled).toBe(true);
    expect(container.textContent).toContain("At most 128 characters");
  });
});

describe("canChangePassword", () => {
  it("allows only a better-auth browser session in authenticated mode", () => {
    expect(canChangePassword("authenticated", "paperclip:session:u1")).toBe(true);
    expect(canChangePassword("local_trusted", "paperclip:session:u1")).toBe(false);
    expect(canChangePassword("authenticated", "paperclip:board_key:u1")).toBe(false);
    expect(canChangePassword(undefined, undefined)).toBe(false);
  });
});
