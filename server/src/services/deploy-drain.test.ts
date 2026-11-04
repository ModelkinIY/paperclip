import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseDeployDrain, readDeployDrain, resetDeployDrainCacheForTests } from "./deploy-drain.js";

const now = new Date("2026-11-04T18:00:00Z");
const later = "2026-11-04T19:00:00Z";

beforeEach(() => resetDeployDrainCacheForTests());

describe("deploy drain", () => {
  it("is inactive without a file", () => {
    expect(parseDeployDrain(null, now).active).toBe(false);
  });
  it("is active until expiry", () => {
    const raw = JSON.stringify({ target: "paperclip-inf:abc1234", since: "2026-11-04T17:55:00Z", expiresAt: later });
    expect(parseDeployDrain(raw, now)).toMatchObject({ active: true, target: "paperclip-inf:abc1234" });
    expect(parseDeployDrain(raw, new Date(later)).active).toBe(false);
  });
  it("never holds on a malformed file or one without expiry", () => {
    expect(parseDeployDrain("not json", now).active).toBe(false);
    expect(parseDeployDrain(JSON.stringify({ target: "x" }), now).active).toBe(false);
  });
  it("reads the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "drain-"));
    const file = join(dir, "deploy-drain.json");
    try {
      expect(readDeployDrain(now, file).active).toBe(false);
      resetDeployDrainCacheForTests();
      writeFileSync(file, JSON.stringify({ expiresAt: later }));
      expect(readDeployDrain(now, file).active).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
