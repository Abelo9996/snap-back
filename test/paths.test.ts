import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dataDir, storageDirIn } from "../src/paths.js";
import { cleanup, tempDir } from "./helpers.js";

afterEach(() => cleanup());

describe("storage directory", () => {
  it("uses snap-back in a fresh data directory", () => {
    const base = tempDir("data-");
    expect(storageDirIn(base)).toBe(path.join(base, "snap-back"));
  });

  it("keeps using a snapback directory left by an older version", () => {
    const base = tempDir("data-");
    mkdirSync(path.join(base, "snapback"));
    expect(storageDirIn(base)).toBe(path.join(base, "snapback"));
  });

  it("prefers snap-back when both directories exist", () => {
    const base = tempDir("data-");
    mkdirSync(path.join(base, "snapback"));
    mkdirSync(path.join(base, "snap-back"));
    expect(storageDirIn(base)).toBe(path.join(base, "snap-back"));
  });

  it("reads SNAP_BACK_HOME, then the older SNAPBACK_HOME", () => {
    const a = tempDir("home-a-");
    const b = tempDir("home-b-");
    expect(dataDir({ SNAP_BACK_HOME: a, SNAPBACK_HOME: b })).toBe(path.resolve(a));
    expect(dataDir({ SNAPBACK_HOME: b })).toBe(path.resolve(b));
  });
});
