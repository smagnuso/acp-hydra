import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRollingLogPath } from "./rolling-log.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hydra-rolllog-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveRollingLogPath", () => {
  it("returns the requested path when it exists", async () => {
    const p = join(dir, "current.log");
    writeFileSync(p, "hi\n");
    expect(await resolveRollingLogPath(p)).toBe(p);
  });

  it("falls back to the newest rotated file when current.log is absent", async () => {
    // What Windows looks like: pino-roll could not make the symlink, so
    // only the numbered files exist.
    writeFileSync(join(dir, "daemon.log.1"), "old\n");
    writeFileSync(join(dir, "daemon.log.9"), "newest\n");
    writeFileSync(join(dir, "daemon.log.10"), "actually newest\n");
    expect(await resolveRollingLogPath(join(dir, "current.log"))).toBe(
      join(dir, "daemon.log.10"),
    );
  });

  it("orders numerically, not lexically", async () => {
    writeFileSync(join(dir, "x.log.2"), "");
    writeFileSync(join(dir, "x.log.11"), "");
    expect(await resolveRollingLogPath(join(dir, "current.log"))).toBe(
      join(dir, "x.log.11"),
    );
  });

  it("returns the requested path when no rotated sibling exists", async () => {
    const p = join(dir, "current.log");
    expect(await resolveRollingLogPath(p)).toBe(p);
  });

  it("does not scan for siblings of a non-current.log path", async () => {
    // An agent log is a plain append-only file, not a rolling set; a
    // stray numbered neighbour must not be substituted for it.
    writeFileSync(join(dir, "claude.log.3"), "");
    const p = join(dir, "claude.log");
    expect(await resolveRollingLogPath(p)).toBe(p);
  });

  it("tolerates a missing directory", async () => {
    const p = join(dir, "nope", "current.log");
    expect(await resolveRollingLogPath(p)).toBe(p);
  });
});
