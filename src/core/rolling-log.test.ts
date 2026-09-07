import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createPinoRoll from "pino-roll";
import { resolveRollingLogPath } from "./rolling-log.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hydra-rolllog-"));
});

afterEach(() => {
  // Retries: a test that opened a real log stream may still be closing
  // it, and Windows refuses to remove a directory holding an open file.
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
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
    writeFileSync(join(dir, "daemon.1.log"), "old\n");
    writeFileSync(join(dir, "daemon.9.log"), "newest\n");
    writeFileSync(join(dir, "daemon.10.log"), "actually newest\n");
    expect(await resolveRollingLogPath(join(dir, "current.log"))).toBe(
      join(dir, "daemon.10.log"),
    );
  });

  it("orders numerically, not lexically", async () => {
    writeFileSync(join(dir, "x.2.log"), "");
    writeFileSync(join(dir, "x.11.log"), "");
    expect(await resolveRollingLogPath(join(dir, "current.log"))).toBe(join(dir, "x.11.log"));
  });

  it("also matches a base configured without an extension", async () => {
    writeFileSync(join(dir, "daemon.7"), "");
    expect(await resolveRollingLogPath(join(dir, "current.log"))).toBe(join(dir, "daemon.7"));
  });

  it("finds the file pino-roll actually wrote", async () => {
    // The guard that matters. Every fixture above is a name this file
    // invented, so they all agreed with each other while disagreeing with
    // the library: pino-roll splits the base on its extension and writes
    // `daemon.1.log`, but this resolver looked for `daemon.log.1`. The
    // fallback therefore matched nothing on the one platform that needs
    // it, and no test noticed because none of them had ever seen a real
    // rotated file. Drive the real thing instead.
    const stream = await createPinoRoll({
      file: join(dir, "svc.log"),
      size: "5m",
      mkdir: true,
      symlink: false, // as on Windows, where the symlink cannot be made
      limit: { count: 5 },
    });
    stream.write("marker line\n");
    // pino-roll opens the file asynchronously, so flush() can return
    // before there is anything on disk to find.
    await expect
      .poll(async () => readdirSync(dir).length, { timeout: 5_000 })
      .toBeGreaterThan(0);

    const resolved = await resolveRollingLogPath(join(dir, "current.log"));
    expect(resolved).not.toBe(join(dir, "current.log"));
    await expect
      .poll(() => readFileSync(resolved, "utf8"), { timeout: 5_000 })
      .toContain("marker line");
    // Wait for the handle to actually go, rather than firing destroy() and
    // leaving afterEach to race it.
    await new Promise<void>((done) => {
      stream.on("close", () => done());
      stream.end();
    });
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
