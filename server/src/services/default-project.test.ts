import { describe, expect, it } from "vitest";
import { defaultProjectForCompany } from "./issues.js";

const C = "7f9393fa-8d74-4f8a-b3da-7d1d84da0f9f";
const P = "4a075d62-fc0c-4b15-b825-71c5da13a7c9";

describe("defaultProjectForCompany", () => {
  it("finds the company's project", () => {
    expect(defaultProjectForCompany(C, `other=x, ${C}=${P}`)).toBe(P);
  });
  it("returns null when unset, for other companies and for malformed ids", () => {
    expect(defaultProjectForCompany(C, undefined)).toBeNull();
    expect(defaultProjectForCompany(C, `00000000-0000-0000-0000-000000000000=${P}`)).toBeNull();
    expect(defaultProjectForCompany(C, `${C}=not-a-uuid`)).toBeNull();
  });
});
